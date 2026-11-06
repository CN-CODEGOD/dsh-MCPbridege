# DSH MCP Bridge

Exposes the tools of a running **DeepSeek Harness (DSH)** process as a **Model Context Protocol** server over **Streamable HTTP**, so an external agent (OpenClaw, Claude Code, Codex, …) can call them.

```
OpenClaw agent ──HTTP/JSON-RPC──▶ http://<windows-host>:18790/mcp ──▶ ctx.tools (read / write / pwsh / web / …)
```

## Endpoint

| Item | Value |
| --- | --- |
| URL | `http://<host>:18790/mcp` |
| Transport | Streamable HTTP (`streamable-http`) |
| Protocol | MCP `2025-06-18` (also accepts `2025-03-26`, `2024-11-05`) |
| Auth | optional `Authorization: Bearer <token>` |
| Health | `GET /health` |
| Overview | `GET /` (HTML list of exposed tools) |

## Add it to OpenClaw

1. Open `http://FNOS.COM:18789` → **Settings → MCP**.
2. **Add server**, name it `dsh`, transport **Streamable HTTP**.
3. URL: `http://<this-computer-LAN-IP>:18790/mcp`.
4. If `token` is configured in the row config, add header `Authorization: Bearer <token>`.
5. Save, then run `openclaw mcp doctor dsh --probe` (or just call a `dsh` tool from a turn).

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
        sessionId: ''     # optional: bind tool calls to one live DSH session id
        tools: []         # optional allowlist of tool names; empty = every visible tool
```

Tool calls run in the **most recently registered live DSH session**, so `read`/`write`/`pwsh`
resolve paths and sandbox policy exactly like that session would. Set `sessionId` to pin a
specific session instead.

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
    tools: []
```

## Security

With `token: ''` the endpoint accepts any request that can reach the port, and every exposed
tool executes with this Harness's permissions. Keep it on a trusted LAN, or set a token:

```yaml
config:
  token: 'change-me-long-random-string'
```

Windows may prompt for (or silently block) inbound connections the first time; allow
`node`/`DeepSeek Harness` on the private network if OpenClaw cannot connect.

## Limits

* Tools are re-listed on every `tools/list`; no restart is needed when plugins add tools.
* `GET` on the MCP path returns 405 by design — this server only answers POSTed JSON-RPC.
* Image/tool content blocks other than text are reported as an omitted-content placeholder.
