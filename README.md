# DSH MCP Bridge

Bridges a live **DeepSeek Harness (DSH)** process to external **Model Context Protocol** clients
(OpenClaw, Claude Code, Codex, …) over **Streamable HTTP**.

An external agent gets two things:

1. **A real conversation partner** — send a message to a DSH session and get the agent's answer.
2. **DSH's tools** — `read`, `write`, `edit`, `glob`, `grep`, `pwsh`, `web_search`, …

```
OpenClaw agent ──HTTP/JSON-RPC──▶ http://<host>:18790/mcp ──▶ DSH session (agent loop + tools)
```

## Endpoint

| Item | Value |
| --- | --- |
| URL | `http://<host>:18790/mcp` |
| Transport | Streamable HTTP (`streamable-http`) |
| Protocol | MCP `2025-06-18` (also accepts `2025-03-26`, `2024-11-05`) |
| Auth | optional `Authorization: Bearer <token>` |
| Health | `GET /health` |
| Overview | `GET /` (HTML list of tools + current execution session) |

## Bridge tools (talk to DSH)

| Tool | Purpose |
| --- | --- |
| `dsh_sessions` | List sessions: id, cwd, preset, live/cold, running, which one is the execution target. |
| `dsh_history` | Read the trailing transcript (`limit`, default 20) as role-tagged text. Defaults to the bridge session. |
| `dsh_chat` | Send `message` to a session (default: the bridge session) and wait for the assistant reply. `mode: queue \| steer`, `waitSeconds` (default 180, max 900). Returns the reply plus a header with session id, elapsed time and tools the DSH agent used. |

Every other tool name is passed straight through to `ctx.tools` and executed in the bridge's own
DSH session (see below).

## Execution scope — why it is not your chat session

Tool calls and `dsh_chat` default to one **dedicated bridge session** (`session-dsh-mcp-bridge`,
created on first use in the first registered workspace and reused after restarts). Foreign callers
therefore never inherit the operator's chat session, its transcript, or its permission preset.

That session is created with an explicit `sandbox/mode` event (`sandbox: danger-full-access` by
default) — see the `0xC0000142` section for why that matters. `execSessionId` pins any other
existing session instead.

## Add it to OpenClaw

1. Open `http://FNOS.COM:18789` → **Settings → MCP**.
2. **Add server**, name `dsh`, transport **Streamable HTTP**.
3. URL: `http://<this-computer-LAN-IP>:18790/mcp`.
4. If `token` is configured, add header `Authorization: Bearer <token>`.
5. Save, then run `openclaw mcp doctor dsh --probe`, or ask the agent to call `dsh_sessions`.

## Config

```yaml
- insert:
    - id: mcp-bridge
      name: '@local/dsh-mcp-bridge'
      config:
        host: '0.0.0.0'   # bind address
        port: 18790       # listening port
        path: /mcp        # endpoint path
        token: ''         # empty = no auth (trusted LAN); set to require Bearer auth
        execSessionId: '' # pin the session used for tool calls / default chat target
        workspace: ''     # cwd for the auto-created bridge session (default: first workspace)
        tools: []         # allowlist of DSH tool names; empty = every visible tool
        chatTools: true   # expose dsh_sessions / dsh_history / dsh_chat
        sandbox: danger-full-access  # sandbox mode recorded on the bridge session
```

### Change the config

Append an id-targeted override to `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`, then
restart DeepSeek Harness. An override replaces the **complete** config, so repeat every field:

```yaml
- id: mcp-bridge
  name: "@local/dsh-mcp-bridge"
  config:
    host: '0.0.0.0'
    port: 18790
    path: /mcp
    token: 'change-me-long-random-string'
    execSessionId: ''
    workspace: ''
    tools: []
    chatTools: true
    sandbox: danger-full-access
```

## Windows `0xC0000142` (STATUS_DLL_INIT_FAILED)

A spawned child process that cannot initialize its DLLs reports `0xC0000142`. Nothing ran — it is a
*process start* failure, not a command failure.

**Root cause found here:** a freshly created session has no `sandbox/mode` override, so it inherits
the deployment default (`workspace-write`). Under that confined sandbox the `pwsh` child died with
`0xC0000142` on every call. The bridge session now records an explicit mode, so this cannot happen
through the bridge:

```yaml
config:
  sandbox: danger-full-access   # default; also: workspace-write | read-only | inherit
```

`inherit` reproduces the old behaviour (deployment default). Whatever the mode, a `0xC0000142`
result is retried once without a session scope (a crash means nothing executed, so the retry cannot
duplicate work) and, if that also fails, the reply carries the remediation instead of a bare error.

If you pin `execSessionId` to your own session, that session's preset is what applies — don't pin a
workspace-write session if you need spawned processes.

## Security

With `token: ''` any host that can reach the port can drive this Harness — including `pwsh` and
`dsh_chat`. Keep it on a trusted LAN or set a token. Windows Firewall already allows the DeepSeek
Harness executable inbound on private/public profiles in a default desktop install.

## Limits

* `GET` on the MCP path returns 405 by design; the server only answers POSTed JSON-RPC.
* `dsh_chat` waits for the turn to finish; it does not stream partial tokens.
* Image/file content blocks are reported as an omitted-content placeholder.
* Tools are re-listed on every `tools/list`; no restart is needed when plugins add tools.
