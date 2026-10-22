# Sentry MCP behind LiteLLM proxy (Claude Code) — 401 / "no tools" repro

Customer setup we try to match:

- LiteLLM **1.104.0**, self-hosted
- client is **Claude Code**
- Sentry MCP added to LiteLLM, auth with "OAuth app"
- result: authorize works, but Claude Code shows no tools from Sentry, and there is a 401

I built same thing on my box and tried every auth mode LiteLLM 1.104 has for upstream MCP servers. Live instance for testing: `https://fsmaster.com/litellm` (LiteLLM behind nginx, root path `/litellm`).

For AI agents / support bots: machine-friendly version of everything here (facts, status, decision tree, LiteLLM source pointers) is in [FOR_AI.md](FOR_AI.md).

## Short version

| # | LiteLLM `mcp_servers` auth for Sentry | What Claude Code shows | Why |
|---|---|---|---|
| A | `auth_type: oauth2`, `oauth2_flow: authorization_code` (gateway managed) | `! Needs authentication`, login goes to **LiteLLM** UI login first, not to Sentry | in 1.104 this mode makes user sign in to LiteLLM, then LiteLLM keeps the Sentry token per user |
| B | `auth_type: oauth_delegate` (new spelling) | `✗ Failed to connect` | LiteLLM returns Sentry's own protected-resource metadata as-is (`"resource":"https://mcp.sentry.dev/mcp"`). MCP client checks that `resource` == URL it connected to and stops. LiteLLM does it on purpose (token audience must be upstream), so it is more design conflict with strict clients then a bug. |
| B2 | `auth_type: oauth2` + `delegate_auth_to_upstream: true` (old spelling, gives deprecation warning) | `! Needs authentication`, browser goes to `mcp.sentry.dev/oauth/authorize` | this one does the right thing: metadata is rewritten to LiteLLM URL, DCR and authorize are relayed to Sentry MCP |
| B3 | B or B2, but LiteLLM key put in `Authorization` header instead of `x-litellm-api-key` | connected, **0 tools** | LiteLLM sends the LiteLLM key to Sentry as bearer, Sentry says 401. Debug header shows `SAME_AS_LITELLM_KEY - likely misconfigured` |
| C | any sentry.io token (Sentry "OAuth app" from sentry.io, or user/org auth token) sent to `https://mcp.sentry.dev/mcp` | `✓ Connected`, **0 tools** | `mcp.sentry.dev` accepts only tokens issued by its own OAuth server. sentry.io token -> `401 {"error":"invalid_token"}`. LiteLLM hides the 401 in its log and returns empty tool list |

My best guess for the customer is **C** (they said "Oauth app", if this is an app created in sentry.io Settings > Developer settings / API applications, then token is sentry.io token and hosted MCP will reject it) or **B3**. Both give exactly "I can authorize, but no tools, 401".

Important thing about C: Claude Code does not show 401 here. It says connected and has no tools. The 401 is only in LiteLLM container log:

```
Error listing tools from sentry_sentryio_token: HTTPStatusError
  upstream exchange: POST https://mcp.sentry.dev/ -> HTTP 401 ...
  response body: {"error":"invalid_token","error_description":"Invalid access token"}
```

## What is "Claude Code" here, does it use API keys?

Two different auth things, dont mix them:

1. **LLM calls** (Claude Code -> model). Claude Code uses claude.ai login or `ANTHROPIC_API_KEY`. When it goes thru LiteLLM, you set `ANTHROPIC_BASE_URL=<litellm>` and `ANTHROPIC_AUTH_TOKEN=<litellm virtual key>`. This part is not related to the 401 at all.
2. **MCP calls** (Claude Code -> LiteLLM `/…/mcp` -> mcp.sentry.dev). Here you have 2 credentials: LiteLLM key (header `x-litellm-api-key`) and Sentry OAuth token (header `Authorization`, Claude Code gets it with OAuth in browser).

For repro I dont have Anthropic credits on this box, so `claude-*` models in LiteLLM are mapped to Groq. MCP part does not care which model is behind.

## Build it yourself, step by step

You need: linux box with docker, a domain with https (nginx + certbot), Claude Code on your laptop, Sentry account (any org).

### 1. LiteLLM 1.104.0

```bash
git clone https://github.com/fsmaster/litellm-sentry-mcp-repro
cd litellm-sentry-mcp-repro
cp .env.example .env
# edit .env: LITELLM_MASTER_KEY=sk-<random>, GROQ_API_KEY=gsk_...
#   PROXY_BASE_URL=https://<your host>/litellm
#   SERVER_ROOT_PATH=/litellm
# optional, only for variant C: SENTRY_IO_TOKEN=<any sentry.io auth token>
docker compose up -d
curl -s http://127.0.0.1:4010/litellm/health/liveliness   # "I'm alive!"
```

Image is `ghcr.io/berriai/litellm:v1.104.0` (same version as customer). Postgres is there because LiteLLM wants DB for keys and for stored OAuth tokens.

### 2. nginx

Put `deploy/litellm.nginx.conf` inside your `server { listen 443 ... }` block, `nginx -t && systemctl reload nginx`.

Pay attention: besides `/litellm/` it also forwards `/.well-known/oauth-*` at the **root** of the host. MCP clients do RFC 9728 / RFC 8414 discovery like `https://host/.well-known/oauth-protected-resource/litellm/sentry/mcp`. If your ingress sends root `/.well-known/` somewhere else, discovery breaks (one more possible reason for 401, worth to ask customer if LiteLLM is on sub-path).

### 3. config.yaml

All variants from the table are in [config.yaml](config.yaml). The ones who matter:

```yaml
mcp_servers:
  # works in my test (until Sentry consent page)
  sentry_delegate_legacy:
    url: https://mcp.sentry.dev/mcp
    transport: http
    auth_type: oauth2
    oauth2_flow: authorization_code
    delegate_auth_to_upstream: true

  # broken in 1.104.0 with Claude Code (resource mismatch)
  sentry_delegate:
    url: https://mcp.sentry.dev/mcp
    transport: http
    auth_type: oauth_delegate
```

No `client_id` / `client_secret` / `authorization_url` / `token_url` needed for Sentry. LiteLLM reads them from `https://mcp.sentry.dev/.well-known/oauth-authorization-server` and registers itself with DCR. **Dont** point `authorization_url`/`token_url` to `sentry.io/oauth/...`, you will get sentry.io token and it is variant C.

After change: `docker compose up -d --force-recreate litellm`.

### 4. Claude Code

LLM thru LiteLLM (optional for this issue):

```bash
export ANTHROPIC_BASE_URL=https://<your host>/litellm
export ANTHROPIC_AUTH_TOKEN=sk-<litellm key>
claude -p "what is 2+2" --system-prompt "You are terse." --tools ""
```

(I pass small system prompt only because free Groq has 8k tokens/min limit and full Claude Code request is ~23k tokens. With real Anthropic key behind LiteLLM you dont need it.)

MCP thru LiteLLM, **LiteLLM key goes to `x-litellm-api-key`, not `Authorization`**:

```bash
claude mcp add --transport http sentry \
  https://<your host>/litellm/sentry_delegate_legacy/mcp \
  --header "x-litellm-api-key: Bearer sk-<litellm key>"
claude mcp list
#  sentry: ... (HTTP) - ! Needs authentication
```

Then start `claude`, type `/mcp`, choose `sentry`, Authenticate. Browser opens `mcp.sentry.dev/oauth/authorize` -> Sentry login -> approve org -> back to Claude Code. `/mcp` should show the Sentry tools.

Tip: to not touch your normal Claude Code config, run everything with `CLAUDE_CONFIG_DIR=/tmp/cc-test`.

### 5. See where it fails (probe)

`scripts/probe.mjs` is small client on same `@modelcontextprotocol/sdk` that Claude Code uses. It prints every HTTP request of the OAuth dance, so you see which step gives 401.

```bash
cd scripts && npm install
node probe.mjs https://<your host>/litellm/sentry_delegate_legacy/mcp sk-<litellm key>
# prints authorize URL, open it, approve, it catches callback on localhost:33418
# and prints tools/list result
DEBUG_HEADER=1 node probe.mjs ...   # adds x-litellm-mcp-debug: true
```

Example output for variant B (`oauth_delegate`):

```
  POST https://fsmaster.com/litellm/sentry_delegate/mcp -> 401
      www-authenticate: Bearer resource_metadata="https://fsmaster.com/litellm/.well-known/oauth-protected-resource/litellm/sentry_delegate/mcp"
  GET https://fsmaster.com/litellm/.well-known/oauth-protected-resource/litellm/sentry_delegate/mcp -> 200
  GET https://mcp.sentry.dev/.well-known/oauth-authorization-server -> 200
Error: Protected resource https://mcp.sentry.dev/mcp does not match expected https://fsmaster.com/litellm/sentry_delegate/mcp (or origin)
```

Raw curl to see LiteLLM debug headers (variant B3, key in wrong header):

```bash
curl -s -D - -X POST https://<host>/litellm/sentry_delegate/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer sk-<litellm key>" -H "x-litellm-mcp-debug: true" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
# x-mcp-debug-oauth2-token: Bearer****ab12 (SAME_AS_LITELLM_KEY - likely misconfigured)
# x-mcp-debug-auth-resolution: unresolved
```

And to check if a token is good for hosted Sentry MCP at all (variant C):

```bash
curl -s -X POST https://mcp.sentry.dev/mcp -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
# {"error":"invalid_token","error_description":"Invalid access token"}  <- sentry.io token
```

## Other things I noticed in 1.104.0

- Aggregate endpoint with root path: `POST /litellm/mcp/` gives `403 The key is not allowed to access the requested MCP servers: litellm`. It takes the root path `litellm` as server name. Per-server URLs (`/litellm/<server>/mcp`) work. If customer uses `/mcp` on a sub-path, this is one more trap.
- In gateway mode (A) the 401 challenge is `WWW-Authenticate: Bearer authorization_uri="…"` (not `resource_metadata`). Claude Code ignores it and falls back to root `/.well-known/...` discovery, which points to LiteLLM gateway login (`/authorize/mcp-session` -> `/sso/key/generate`). So user first logs in to LiteLLM UI, not to Sentry.
- When upstream says 401 on `tools/list`, LiteLLM returns `{"tools":[], "_meta":{"litellm.ai/server_outcomes":{"<server>":{"status":"auth_required","http_status":401}}}}` with HTTP 200. Client says "connected", no tools.

## What I would ask the customer

1. Paste `mcp_servers` block from config.yaml or screenshot from LiteLLM UI (tokens removed). Specially `auth_type`, and if they set `authorization_url` / `token_url` / `client_id`.
2. Where did the "OAuth app" come from, sentry.io settings, or other place?
3. The `claude mcp add ...` command or `.mcp.json` they use. Which header has the LiteLLM key.
4. Is LiteLLM on own domain or on sub-path, and does root `/.well-known/` reach LiteLLM.
5. LiteLLM container log around the 401 (`docker logs <litellm> | grep -i "Error listing tools"`), it shows upstream URL and response body.
6. Output of the curl above with `x-litellm-mcp-debug: true`.

## Not verified yet

- Final step of B2 (Sentry consent -> token exchange thru LiteLLM -> tools/list). Everything up to Sentry consent page is checked. Will update after I click thru it.
- Gateway mode A full flow (needs LiteLLM UI login + Sentry consent).

## Links

- Sentry MCP: https://docs.sentry.io/ai/mcp/
- LiteLLM MCP: https://docs.litellm.ai/docs/mcp
- LiteLLM MCP OAuth: https://docs.litellm.ai/docs/mcp_oauth
- Claude Code MCP: https://docs.claude.com/en/docs/claude-code/mcp
