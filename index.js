/**
 * DSH MCP Bridge — host half.
 *
 * Runs a Model Context Protocol server (Streamable HTTP, JSON-RPC 2.0) that
 * projects a live DeepSeek Harness process to external MCP clients such as
 * OpenClaw:
 *
 *  - `dsh_chat` / `dsh_sessions` / `dsh_history` let a foreign agent actually
 *    hold a conversation with a DSH session (send a prompt, wait for the reply,
 *    read the transcript) instead of only poking at tools.
 *  - every other tool name is the DSH tool of that name, executed in a
 *    dedicated bridge session owned by this plugin — never in the operator's
 *    own chat session, whose permission preset must not leak into foreign
 *    callers.
 */

import http from 'node:http'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-mcp-bridge'
export const inject = ['tools']

const SERVER_INFO = { name: 'dsh-mcp-bridge', version: '1.1.0' }
/** Stable id so the bridge reuses one session across restarts instead of minting a new one. */
const BRIDGE_SESSION_ID = 'session-dsh-mcp-bridge'
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const DEFAULT_PROTOCOL_VERSION = '2025-06-18'
const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_TEXT_CHARS = 400_000
const POLL_MS = 300

/** Windows STATUS_DLL_INIT_FAILED: the child process never initialized. */
const SPAWN_INIT_FAILURE = /0xC0000142|3221225794|-1073741502/iu

const INSTRUCTIONS = [
  'This server bridges a running DeepSeek Harness (DSH) instance.',
  '',
  'Conversation tools — talk to the live DSH agent:',
  '  dsh_sessions  list DSH sessions (live and persisted)',
  '  dsh_history   read the recent transcript of one session',
  '  dsh_chat      send a message to a session and wait for the assistant reply',
  '',
  'Every other tool name is a DSH tool (read, write, edit, pwsh, web_search, ...).',
  'Those execute in this bridge\'s own DSH session, not in the operator\'s chat session,',
  'and return the tool result as text.',
].join('\n')

function log(message) {
  try {
    console.log(`[dsh-mcp-bridge] ${message}`)
  } catch {
    /* ignored */
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeConfig(config) {
  const source = config && typeof config === 'object' ? config : {}
  const port = Number.parseInt(String(source.port ?? 18790), 10)
  const path = typeof source.path === 'string' && source.path.startsWith('/') ? source.path : '/mcp'
  return {
    host: typeof source.host === 'string' && source.host.length > 0 ? source.host : '0.0.0.0',
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 18790,
    path,
    token: typeof source.token === 'string' ? source.token.trim() : '',
    execSessionId: typeof source.execSessionId === 'string' ? source.execSessionId.trim() : '',
    workspace: typeof source.workspace === 'string' && source.workspace.length > 0 ? source.workspace : '',
    tools: Array.isArray(source.tools) ? source.tools.filter((item) => typeof item === 'string') : [],
    chatTools: source.chatTools !== false,
    sandbox: ['read-only', 'workspace-write', 'danger-full-access', 'inherit'].includes(source.sandbox)
      ? source.sandbox
      : 'danger-full-access',
  }
}

function jsonRpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } }
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result }
}

function sendJson(res, status, payload, extraHeaders = {}) {
  let body
  try {
    body = JSON.stringify(payload)
  } catch (error) {
    body = JSON.stringify(jsonRpcError(null, -32603, `serialization failed: ${String(error)}`))
    status = 500
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('request aborted')))
  })
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text: clampText(String(text)) }], isError }
}

function clampText(text) {
  if (text.length <= MAX_TEXT_CHARS) return text
  return `${text.slice(0, MAX_TEXT_CHARS)}\n\n[truncated by dsh-mcp-bridge after ${MAX_TEXT_CHARS} characters]`
}

function blockText(block) {
  if (!block || typeof block !== 'object') return ''
  if (block.type === 'text' && typeof block.text === 'string') return block.text
  if (block.type === 'tool-call') return `[tool-call ${block.name ?? '?'}]`
  if (block.type === 'image') return '[image]'
  if (block.type === 'file') return '[file]'
  return ''
}

function messageText(message) {
  if (!message || typeof message !== 'object') return ''
  const blocks = Array.isArray(message.content) ? message.content : []
  return blocks.map(blockText).filter(Boolean).join('\n')
}

/** Convert DSH content blocks into MCP tool-result content. */
function blocksToContent(blocks) {
  const content = []
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      content.push({ type: 'text', text: clampText(block.text) })
    } else if (block && typeof block.type === 'string') {
      content.push({ type: 'text', text: `[${block.type} content omitted by dsh-mcp-bridge]` })
    }
  }
  return content
}

function normalizeInputSchema(schema) {
  const source = schema && typeof schema === 'object' ? schema : {}
  const normalized = { ...source }
  if (normalized.type === undefined) normalized.type = 'object'
  if (normalized.type === 'object' && normalized.properties === undefined) normalized.properties = {}
  return normalized
}

/**
 * Mount the MCP server for this plugin row.
 * @param ctx - the plugin context; `ctx.tools` is required, session services optional.
 * @param config - row config (`host`, `port`, `path`, `token`, `execSessionId`, `workspace`, `tools`, `chatTools`).
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  let server
  let bridgeSessionId = ''
  let bridgeAgent
  let bridgeSessionPromise
  let bridgeModeApplied = false

  const sessionController = () => {
    try {
      return ctx.get('sessionController')
    } catch {
      return undefined
    }
  }
  const sessionStore = () => {
    try {
      return ctx.get('sessions')
    } catch {
      return undefined
    }
  }

  function defaultWorkspace() {
    if (settings.workspace) return settings.workspace
    try {
      const registry = ctx.get('workspaceRegistry')
      const workspaces = registry && typeof registry.list === 'function' ? registry.list() : []
      const first = (Array.isArray(workspaces) ? workspaces : []).find((workspace) => workspace && workspace.path)
      if (first) return first.path
    } catch {
      /* ignored */
    }
    try {
      const wd = ctx.get('workingDirectory')
      if (wd && typeof wd.defaultDirectory === 'string') return wd.defaultDirectory
    } catch {
      /* ignored */
    }
    return process.cwd()
  }

  /**
   * The session this bridge executes tools in. Created on first use so foreign
   * callers never inherit the operator's chat session or its permission preset.
   */
  function ensureBridgeSession() {
    if (settings.execSessionId) return Promise.resolve(settings.execSessionId)
    if (bridgeSessionId) return Promise.resolve(bridgeSessionId)
    if (!bridgeSessionPromise) {
      bridgeSessionPromise = (async () => {
        const cwd = defaultWorkspace()
        const sc = sessionController()
        if (sc && typeof sc.create === 'function') {
          const live = sessionStore()?.get?.(BRIDGE_SESSION_ID)
          if (live) {
            bridgeSessionId = BRIDGE_SESSION_ID
            return bridgeSessionId
          }
          try {
            const created = await sc.create({ sessionId: BRIDGE_SESSION_ID, cwd })
            if (created && created.sessionId) {
              bridgeSessionId = created.sessionId
              log(`bridge session created: ${bridgeSessionId} (cwd=${cwd})`)
              return bridgeSessionId
            }
          } catch (error) {
            // A cold session with this stable id already exists in persistence: resume it.
            bridgeSessionId = BRIDGE_SESSION_ID
            log(`reusing persisted bridge session ${BRIDGE_SESSION_ID}: ${String(error)}`)
            return bridgeSessionId
          }
        }
        const agents = ctx.get('agents')
        if (agents && typeof agents.create === 'function') {
          try {
            const handle = await agents.create({
              sessionId: `session-mcp-bridge-${randomUUID()}`,
              meta: { cwd },
            })
            bridgeSessionId = handle.agent.id
            bridgeAgent = handle.agent
            log(`bridge agent created: ${bridgeSessionId}`)
            return bridgeSessionId
          } catch (error) {
            log(`agents.create failed: ${String(error)}`)
          }
        }
        return ''
      })().finally(() => {
        if (!bridgeSessionId) bridgeSessionPromise = undefined
      })
    }
    return bridgeSessionPromise
  }

  /**
   * Record the bridge session's sandbox mode as its one `sandbox/mode` event.
   * A workspace-write bridge session spawns confined children, and on Windows a
   * confined spawn can die with 0xC0000142 before it runs anything; the operator
   * can still pick `inherit` (or any explicit mode) through config.
   */
  function applyBridgeMode() {
    if (bridgeModeApplied || settings.execSessionId || !bridgeSessionId) return
    if (settings.sandbox === 'inherit') {
      bridgeModeApplied = true
      return
    }
    const session = sessionStore()?.get?.(bridgeSessionId)
    if (!session || typeof session.append !== 'function') return
    try {
      session.append('sandbox/mode', { mode: settings.sandbox })
      bridgeModeApplied = true
      log(`bridge session ${bridgeSessionId} sandbox mode -> ${settings.sandbox}`)
    } catch (error) {
      log(`failed to set bridge sandbox mode: ${String(error)}`)
    }
  }

  async function resolveExecAgent() {
    const id = await ensureBridgeSession()
    if (!id) return undefined
    applyBridgeMode()
    if (bridgeAgent && bridgeAgent.id === id) return bridgeAgent
    try {
      const live = ctx.get('agents')?.get(id)
      if (live) {
        bridgeAgent = live
        return live
      }
    } catch {
      /* ignored */
    }
    const sc = sessionController()
    if (sc && typeof sc.resolveAgent === 'function') {
      try {
        const resolved = await sc.resolveAgent(id)
        if (resolved && resolved.agent) {
          bridgeAgent = resolved.agent
          return resolved.agent
        }
        if (resolved && resolved.error) log(`resolveAgent(${id}) failed: ${JSON.stringify(resolved.error)}`)
      } catch (error) {
        log(`resolveAgent(${id}) threw: ${String(error)}`)
      }
    }
    return undefined
  }

  function allowed(name) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(name)) return false
    if (settings.tools.length === 0) return true
    return settings.tools.includes(name)
  }

  async function visibleSchemas() {
    const agent = await resolveExecAgent()
    let schemas = []
    try {
      schemas = agent ? ctx.tools.schemas(agent) : ctx.tools.schemas()
    } catch (error) {
      log(`tool discovery failed: ${String(error)}`)
      return []
    }
    const seen = new Set()
    const tools = []
    for (const schema of Array.isArray(schemas) ? schemas : []) {
      const toolName = schema && typeof schema.name === 'string' ? schema.name : ''
      if (!toolName || seen.has(toolName) || !allowed(toolName)) continue
      seen.add(toolName)
      tools.push({
        name: toolName,
        description: typeof schema.description === 'string' ? schema.description : '',
        inputSchema: normalizeInputSchema(schema.parameters),
      })
    }
    return tools
  }

  // ---------------------------------------------------------------- bridge tools

  function bridgeToolDefinitions() {
    if (!settings.chatTools) return []
    return [
      {
        name: 'dsh_sessions',
        description:
          'List DeepSeek Harness sessions available to this bridge: id, working directory, agent preset, running state. ' +
          'Use the id with dsh_chat / dsh_history.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Maximum rows to return (default 50).' },
          },
          additionalProperties: false,
        },
        run: (args) => listSessions(args),
      },
      {
        name: 'dsh_history',
        description:
          'Read the recent transcript of one DSH session as role-tagged text (user / assistant / tool). ' +
          'Defaults to the bridge session.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'Session id; omit for the bridge session.' },
            limit: { type: 'number', description: 'How many trailing messages to return (default 20).' },
          },
          additionalProperties: false,
        },
        run: (args) => readHistory(args),
      },
      {
        name: 'dsh_chat',
        description:
          'Send a message to a DSH session and wait for the assistant reply. This is a real conversation turn: ' +
          'the DSH agent runs its own loop (model + its own tools) and the final text comes back. ' +
          'Defaults to the bridge session, which creates one on first use.',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'The text to send to the DSH agent.' },
            sessionId: { type: 'string', description: 'Target session id; omit for the bridge session.' },
            mode: {
              type: 'string',
              enum: ['queue', 'steer'],
              description: 'queue waits for the current turn to finish; steer injects into the running turn.',
            },
            waitSeconds: { type: 'number', description: 'How long to wait for the reply (default 180, max 900).' },
          },
          required: ['message'],
          additionalProperties: false,
        },
        run: (args, signal) => chat(args, signal),
      },
    ]
  }

  async function listSessions(args) {
    const limit = Number.isFinite(Number(args?.limit)) ? Math.max(1, Math.min(500, Number(args?.limit))) : 50
    const rows = []
    const sc = sessionController()
    if (sc && typeof sc.list === 'function') {
      try {
        const value = await sc.list({}, new AbortController().signal)
        for (const item of Array.isArray(value?.items) ? value.items : []) {
          rows.push({
            id: String(item.sessionId),
            cwd: item.cwd ?? '',
            preset: item.agentPreset ?? '',
            running: Boolean(item.running),
            updatedAt: Number(item.updatedAt ?? 0),
            live: Boolean(sessionStore()?.get?.(item.sessionId)),
          })
        }
      } catch (error) {
        log(`session list failed: ${String(error)}`)
      }
    }
    if (rows.length === 0) {
      for (const session of sessionStore()?.list?.() ?? []) {
        rows.push({
          id: String(session.id),
          cwd: session.header?.cwd ?? '',
          preset: session.header?.agentPreset ?? '',
          running: false,
          updatedAt: Number(session.header?.createdAt ?? 0),
          live: true,
        })
      }
    }
    if (rows.length === 0) return textResult('no DSH sessions are available')
    const execId = settings.execSessionId || bridgeSessionId
    const lines = rows
      .slice(0, limit)
      .map((row) => {
        const marks = [row.live ? 'live' : 'cold', row.running ? 'running' : 'idle', row.id === execId ? 'exec-target' : '']
          .filter(Boolean)
          .join(',')
        return `- ${row.id}  [${marks}]  cwd=${row.cwd || '?'}${row.preset ? `  preset=${row.preset}` : ''}`
      })
    return textResult(`DSH sessions (${Math.min(rows.length, limit)}/${rows.length}):\n${lines.join('\n')}`)
  }

  async function readHistory(args) {
    const limit = Number.isFinite(Number(args?.limit)) ? Math.max(1, Math.min(200, Number(args?.limit))) : 20
    const targetId = typeof args?.sessionId === 'string' && args.sessionId ? args.sessionId : await ensureBridgeSession()
    if (!targetId) return textResult('no target session available', true)
    const session = sessionStore()?.get?.(targetId)
    if (!session) return textResult(`session ${targetId} is not live in this process`, true)
    let messages = []
    try {
      messages = session.deriveMessages()
    } catch (error) {
      return textResult(`cannot read session ${targetId}: ${String(error)}`, true)
    }
    const tail = messages.slice(-limit)
    if (tail.length === 0) return textResult(`session ${targetId} has no messages yet`)
    const body = tail
      .map((message) => {
        const text = messageText(message)
        return `### ${message.role}\n${text || '(no text content)'}`
      })
      .join('\n\n')
    return textResult(`Transcript of ${targetId} (last ${tail.length} of ${messages.length} messages):\n\n${body}`)
  }

  async function chat(args, signal) {
    const sc = sessionController()
    if (!sc || typeof sc.prompt !== 'function') return textResult('this deployment has no sessionController; cannot start a DSH turn', true)
    const message = typeof args?.message === 'string' ? args.message.trim() : ''
    if (!message) return textResult('message is required', true)
    const targetId = typeof args?.sessionId === 'string' && args.sessionId ? args.sessionId : await ensureBridgeSession()
    if (!targetId) return textResult('no target session: pass sessionId or let a tool call create the bridge session first', true)
    const waitMs = Math.min(Math.max(Number(args?.waitSeconds ?? 180) * 1000, 5_000), 900_000)
    const mode = args?.mode === 'steer' ? 'steer' : 'queue'

    const store = sessionStore()
    const before = store?.get?.(targetId)
    let cursor = before ? Number(before.seq) : 0

    try {
      await sc.prompt(
        {
          requestId: `mcp-${randomUUID()}`,
          sessionId: targetId,
          mode,
          content: [{ type: 'text', text: message }],
        },
        signal,
      )
    } catch (error) {
      return textResult(`prompt rejected for ${targetId}: ${error instanceof Error ? error.message : String(error)}`, true)
    }

    const startedAt = Date.now()
    let anchorSeq = -1
    const assistantParts = []
    const toolNames = []
    let ended = false
    let lastError = ''

    while (!ended && Date.now() - startedAt < waitMs) {
      await delay(POLL_MS)
      if (signal?.aborted) return textResult(`cancelled while waiting for ${targetId}`, true)
      const session = store?.get?.(targetId)
      if (!session) continue
      const now = Number(session.seq)
      if (now <= cursor) continue
      let fresh = []
      try {
        fresh = session.snapshotEvents(cursor, now)
      } catch (error) {
        lastError = String(error)
        continue
      }
      cursor = now
      for (const event of fresh) {
        if (event.type === 'user/message' && anchorSeq < 0) {
          // The first user message appended after the prompt was admitted is ours;
          // queued prompts are only appended when their turn actually starts.
          anchorSeq = Number(event.seq)
          continue
        }
        if (anchorSeq < 0) continue
        if (event.type === 'assistant/message') {
          const text = messageText(event.data?.message)
          if (text.trim()) assistantParts.push(text)
        } else if (event.type === 'tool/call') {
          toolNames.push(String(event.data?.name ?? '?'))
        } else if (event.type === 'turn/end') {
          const reason = event.data?.reason
          if (reason && reason.kind === 'error') lastError = reason.error?.message ?? 'turn failed'
          else if (reason && reason.kind === 'aborted') lastError = 'turn was aborted'
          ended = true
        }
      }
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    if (anchorSeq < 0) {
      return textResult(
        `prompt was accepted by ${targetId} but no turn started within ${waitMs / 1000}s ` +
          `(the session may be busy or its agent unavailable). Use dsh_history to inspect it.`,
        true,
      )
    }
    const header = `[${targetId} · ${mode} · ${elapsed}s${toolNames.length ? ` · tools: ${[...new Set(toolNames)].join(', ')}` : ''}]`
    const body = assistantParts.join('\n\n').trim()
    if (!body) {
      return textResult(`${header}\n(turn ended with no assistant text${lastError ? `; ${lastError}` : ''})`, Boolean(lastError) && !ended)
    }
    return textResult(`${header}\n${body}`)
  }

  // ---------------------------------------------------------------- tool execution

  async function executeOnce(input) {
    try {
      return await ctx.tools.execute(input)
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: `DSH tool "${input.name}" failed: ${error instanceof Error ? error.message : String(error)}` }],
      }
    }
  }

  function resultText(result) {
    const blocks = Array.isArray(result?.content) ? result.content : []
    const text = blocks
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    if (text) return text
    try {
      return JSON.stringify(result?.value ?? null)
    } catch {
      return String(result?.value)
    }
  }

  async function invokeTool(toolName, args, signal) {
    const agent = await resolveExecAgent()
    const base = {
      name: toolName,
      arguments: args && typeof args === 'object' ? args : {},
      signal,
    }
    const result = await executeOnce({ ...base, callId: randomUUID(), ...(agent ? { agent } : {}) })
    const text = resultText(result)
    const notes = []

    // A sandboxed child that cannot initialize its DLLs reports 0xC0000142 and
    // has not run at all, so one retry outside the session scope is side-effect free.
    if (SPAWN_INIT_FAILURE.test(text) && agent) {
      log(`tool ${toolName} raised a spawn-init failure; retrying without a session scope`)
      const retry = await executeOnce({ ...base, callId: randomUUID() })
      const retryText = resultText(retry)
      if (!retry.isError && !SPAWN_INIT_FAILURE.test(retryText)) {
        const content = blocksToContent(retry.content)
        if (content.length === 0) content.push({ type: 'text', text: clampText(retryText || '(no output)') })
        content.push({
          type: 'text',
          text:
            '(dsh-mcp-bridge: the first attempt died with Windows 0xC0000142 STATUS_DLL_INIT_FAILED under the ' +
            'session scope; this result comes from a retry without one.)',
        })
        return { content, isError: false }
      }
      notes.push(
        `(dsh-mcp-bridge: the session-scoped attempt raised Windows 0xC0000142; the retry without a session scope also failed — ${retryText.slice(0, 400) || '(empty)'})`,
      )
      notes.push(
        "(dsh-mcp-bridge: 0xC0000142 is STATUS_DLL_INIT_FAILED — the child process never started, usually because the " +
          "session's sandbox cannot initialize it. Give the bridge session full access (config `sandbox: danger-full-access`, " +
          "the default) or let dsh_chat perform the operation inside DSH's own agent loop.)",
      )
    }

    const content = blocksToContent(result?.content)
    if (content.length === 0) content.push({ type: 'text', text: clampText(text || '(no output)') })
    for (const note of notes) content.push({ type: 'text', text: note })
    return { content, isError: Boolean(result?.isError) }
  }

  // ---------------------------------------------------------------- transport

  async function dispatch(method, params, signal) {
    switch (method) {
      case 'initialize': {
        const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        }
      }
      case 'ping':
        return {}
      case 'tools/list': {
        const tools = await visibleSchemas()
        const bridge = bridgeToolDefinitions().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
        const taken = new Set(tools.map((tool) => tool.name))
        return { tools: [...bridge.filter((tool) => !taken.has(tool.name)), ...tools] }
      }
      case 'tools/call': {
        const toolName = params && typeof params.name === 'string' ? params.name : ''
        if (!toolName) throw Object.assign(new Error('params.name is required'), { code: -32602 })
        const bridgeTool = bridgeToolDefinitions().find((tool) => tool.name === toolName)
        if (bridgeTool) return bridgeTool.run(params && params.arguments, signal)
        if (!allowed(toolName)) throw Object.assign(new Error(`tool "${toolName}" is not exposed by this bridge`), { code: -32602 })
        return invokeTool(toolName, params && params.arguments, signal)
      }
      case 'resources/list':
        return { resources: [] }
      case 'resources/templates/list':
        return { resourceTemplates: [] }
      case 'prompts/list':
        return { prompts: [] }
      case 'logging/setLevel':
        return {}
      default:
        throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 })
    }
  }

  function authorized(req) {
    if (settings.token.length === 0) return true
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/iu.exec(header.trim())
    return Boolean(match) && match[1] === settings.token
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/gu, (character) => {
      switch (character) {
        case '&':
          return '&amp;'
        case '<':
          return '&lt;'
        case '>':
          return '&gt;'
        case '"':
          return '&quot;'
        default:
          return '&#39;'
      }
    })
  }

  async function landingPage() {
    const tools = await visibleSchemas()
    const bridge = bridgeToolDefinitions()
    const rows = [...bridge, ...tools]
      .map((tool) => `<tr><td><code>${escapeHtml(tool.name)}</code></td><td>${escapeHtml(tool.description)}</td></tr>`)
      .join('\n')
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>DSH MCP Bridge</title>
<style>body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:32px;background:#0b1020;color:#e6e9f5}h1{font-size:20px;margin:0 0 4px}p{color:#9aa4bf}code{background:#161d33;padding:1px 5px;border-radius:4px}table{border-collapse:collapse;width:100%;margin-top:24px}td,th{border-bottom:1px solid #1e2740;padding:8px;text-align:left;vertical-align:top}th{color:#8ea0c8}</style>
</head><body>
<h1>DSH MCP Bridge ${escapeHtml(SERVER_INFO.version)}</h1>
<p>Streamable HTTP MCP endpoint: <code>http://${escapeHtml(settings.host)}:${settings.port}${escapeHtml(settings.path)}</code> · ${bridge.length + tools.length} tools · execution session <code>${escapeHtml(settings.execSessionId || bridgeSessionId || '(lazy)')}</code>${settings.token.length > 0 ? ' · bearer token required' : ' · no token configured'}</p>
<table><thead><tr><th>Tool</th><th>Description</th></tr></thead><tbody>${rows || '<tr><td colspan="2">no tools visible</td></tr>'}</tbody></table>
</body></html>`
  }

  async function handlePost(req, res) {
    let raw
    try {
      raw = await readBody(req)
    } catch (error) {
      sendJson(res, 413, jsonRpcError(null, -32600, error instanceof Error ? error.message : String(error)))
      return
    }
    let payload
    try {
      payload = JSON.parse(raw)
    } catch (error) {
      sendJson(res, 400, jsonRpcError(null, -32700, 'parse error', String(error)))
      return
    }
    const request = Array.isArray(payload) ? payload[0] : payload
    if (!request || typeof request !== 'object' || typeof request.method !== 'string') {
      sendJson(res, 400, jsonRpcError(request && request.id, -32600, 'invalid request'))
      return
    }
    const isNotification = request.id === undefined || request.id === null
    if (isNotification) {
      res.writeHead(202, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end()
      return
    }
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) controller.abort()
    })
    try {
      const result = await dispatch(request.method, request.params, controller.signal)
      sendJson(res, 200, jsonRpcResult(request.id, result))
    } catch (error) {
      const code = error && Number.isInteger(error.code) ? error.code : -32603
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, code === -32700 ? 400 : 200, jsonRpcError(request.id, code, message))
    }
  }

  server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Accept',
            'Access-Control-Max-Age': '86400',
          })
          res.end()
          return
        }
        if (url.pathname === '/health') {
          sendJson(res, 200, {
            ok: true,
            server: SERVER_INFO,
            endpoint: `http://${settings.host}:${settings.port}${settings.path}`,
            execSession: settings.execSessionId || bridgeSessionId || null,
            auth: settings.token.length > 0,
          })
          return
        }
        if (url.pathname === '/' && req.method === 'GET') {
          if (!authorized(req)) {
            sendJson(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer realm="dsh-mcp-bridge"' })
            return
          }
          const html = await landingPage()
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) })
          res.end(html)
          return
        }
        if (url.pathname !== settings.path) {
          sendJson(res, 404, { error: 'not_found', endpoint: `http://${settings.host}:${settings.port}${settings.path}` })
          return
        }
        if (!authorized(req)) {
          sendJson(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer realm="dsh-mcp-bridge"' })
          return
        }
        if (req.method === 'POST') {
          await handlePost(req, res)
          return
        }
        if (req.method === 'GET') {
          sendJson(
            res,
            405,
            jsonRpcError(null, -32000, 'this server does not offer an SSE stream; POST JSON-RPC requests to this URL'),
            { Allow: 'POST, DELETE, OPTIONS' },
          )
          return
        }
        if (req.method === 'DELETE') {
          res.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
          res.end()
          return
        }
        sendJson(res, 405, jsonRpcError(null, -32600, `method ${req.method} not allowed`), { Allow: 'POST, DELETE, OPTIONS' })
      } catch (error) {
        log(`request failed: ${String(error)}`)
        try {
          if (!res.headersSent) sendJson(res, 500, jsonRpcError(null, -32603, 'internal error'))
          else res.end()
        } catch {
          /* ignored */
        }
      }
    })()
  })

  server.on('clientError', (error, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    } catch {
      /* ignored */
    }
    log(`client error: ${String(error)}`)
  })

  server.on('error', (error) => {
    log(`listener error on ${settings.host}:${settings.port}: ${String(error)}`)
  })

  ctx.effect(() => {
    try {
      server.listen(settings.port, settings.host, () => {
        log(`listening on http://${settings.host}:${settings.port}${settings.path}`)
        if (settings.token.length === 0) {
          log('warning: no bearer token configured; any host that can reach this port can drive this Harness')
        }
      })
    } catch (error) {
      log(`failed to start: ${String(error)}`)
    }
    return () =>
      new Promise((resolve) => {
        try {
          server.closeAllConnections?.()
          server.close(() => resolve())
        } catch {
          resolve()
        }
      })
  })
}
