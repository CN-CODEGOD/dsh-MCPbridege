/**
 * DSH MCP Bridge — host half.
 *
 * Runs a Model Context Protocol server (Streamable HTTP, JSON-RPC 2.0) that
 * projects the tools of this DeepSeek Harness process to any external MCP
 * client. An OpenClaw / Claude / Codex agent adds
 * `http://<this-host>:18790/mcp` as a Streamable HTTP MCP server and can then
 * call DSH tools (read, write, pwsh, web_search, ...) directly.
 *
 * The plugin owns nothing but the HTTP listener: tool discovery and execution
 * go through `ctx.tools`, so newly registered tools appear without a restart.
 */

import http from 'node:http'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-mcp-bridge'
export const inject = ['tools']

const SERVER_INFO = { name: 'dsh-mcp-bridge', version: '1.0.0' }
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const DEFAULT_PROTOCOL_VERSION = '2025-06-18'
const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_TEXT_CHARS = 400_000

const INSTRUCTIONS =
  'This server exposes the tools of a running DeepSeek Harness (DSH) instance. ' +
  'Tool names match DSH tool names; arguments use the same JSON schema DSH shows its own model. ' +
  'Calls execute inside the live DSH session (files, shell, web) and return the tool result as text.'

/** No-op logger: the listener must never be able to take the host down. */
function log(message) {
  try {
    console.log(`[dsh-mcp-bridge] ${message}`)
  } catch {
    /* ignored */
  }
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
    sessionId: typeof source.sessionId === 'string' && source.sessionId.length > 0 ? source.sessionId : '',
    tools: Array.isArray(source.tools) ? source.tools.filter((item) => typeof item === 'string') : [],
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
  return { content: [{ type: 'text', text }], isError }
}

function clampText(text) {
  if (text.length <= MAX_TEXT_CHARS) return text
  return `${text.slice(0, MAX_TEXT_CHARS)}\n\n[truncated by dsh-mcp-bridge after ${MAX_TEXT_CHARS} characters]`
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
 * @param ctx - the plugin context; only `ctx.tools` is required.
 * @param config - the row config (`host`, `port`, `path`, `token`, `sessionId`, `tools`).
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  let server

  /** The Agent used as the tool-execution scope, so DSH resolves cwd and policy like a real session. */
  function resolveAgent() {
    const agents = ctx.get('agents')
    if (!agents) return undefined
    try {
      if (settings.sessionId) {
        const exact = agents.get(settings.sessionId)
        if (exact) return exact
      }
      const live = agents.list()
      return Array.isArray(live) && live.length > 0 ? live[live.length - 1] : undefined
    } catch (error) {
      log(`agent lookup failed: ${String(error)}`)
      return undefined
    }
  }

  function allowed(name) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(name)) return false
    if (settings.tools.length === 0) return true
    return settings.tools.includes(name)
  }

  function visibleSchemas(agent) {
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

  async function invokeTool(toolName, args, signal) {
    const agent = resolveAgent()
    const input = {
      callId: randomUUID(),
      name: toolName,
      arguments: args && typeof args === 'object' ? args : {},
      signal,
    }
    if (agent) input.agent = agent
    let result
    try {
      result = await ctx.tools.execute(input)
    } catch (error) {
      return textResult(`DSH tool "${toolName}" failed: ${error instanceof Error ? error.message : String(error)}`, true)
    }
    const content = blocksToContent(result && result.content)
    if (content.length === 0) {
      let fallback = ''
      try {
        fallback = JSON.stringify(result && result.value !== undefined ? result.value : null)
      } catch {
        fallback = String(result && result.value)
      }
      content.push({ type: 'text', text: clampText(fallback || '(no output)') })
    }
    return { content, isError: Boolean(result && result.isError) }
  }

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
      case 'tools/list':
        return { tools: visibleSchemas(resolveAgent()) }
      case 'tools/call': {
        const toolName = params && typeof params.name === 'string' ? params.name : ''
        if (!toolName) throw Object.assign(new Error('params.name is required'), { code: -32602 })
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

  function landingPage() {
    const agent = resolveAgent()
    const tools = visibleSchemas(agent)
    const rows = tools
      .map((tool) => `<tr><td><code>${escapeHtml(tool.name)}</code></td><td>${escapeHtml(tool.description)}</td></tr>`)
      .join('\n')
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>DSH MCP Bridge</title>
<style>body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:32px;background:#0b1020;color:#e6e9f5}h1{font-size:20px;margin:0 0 4px}p{color:#9aa4bf}code{background:#161d33;padding:1px 5px;border-radius:4px}table{border-collapse:collapse;width:100%;margin-top:24px}td,th{border-bottom:1px solid #1e2740;padding:8px;text-align:left;vertical-align:top}th{color:#8ea0c8}</style>
</head><body>
<h1>DSH MCP Bridge</h1>
<p>Streamable HTTP MCP endpoint: <code>http://${escapeHtml(settings.host)}:${settings.port}${escapeHtml(settings.path)}</code> · ${tools.length} tools exposed${settings.token.length > 0 ? ' · bearer token required' : ' · no token configured'}</p>
<table><thead><tr><th>Tool</th><th>Description</th></tr></thead><tbody>${rows || '<tr><td colspan="2">no tools visible</td></tr>'}</tbody></table>
</body></html>`
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
    // `IncomingMessage` emits `close` once the body is consumed, so only a
    // response that never finished means the caller went away.
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
            tools: visibleSchemas(resolveAgent()).length,
            auth: settings.token.length > 0,
          })
          return
        }
        if (url.pathname === '/' && req.method === 'GET') {
          if (!authorized(req)) {
            sendJson(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer realm="dsh-mcp-bridge"' })
            return
          }
          const html = landingPage()
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
          log('warning: no bearer token configured; any host that can reach this port can call DSH tools')
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
