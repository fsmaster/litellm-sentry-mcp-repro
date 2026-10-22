# FOR_AI.md: context for AI agents / assistants

Audience: an AI model (support assistant, code-search agent, docs agent) that is helping a human explain or debug this case. Written to be parsed, not read for style. Human-facing guide is [README.md](README.md).

Status legend used below:
- `VERIFIED`: observed directly in this repro (HTTP traces, logs, client output).
- `SOURCE`: read in LiteLLM 1.104.0 source inside the official image, not separately executed.
- `INFERRED`: reasoning from VERIFIED + SOURCE facts; not observed end to end.
- `UNVERIFIED`: not tested yet.

---

## 1. Case summary

```yaml
ticket:
  customer_report: >
    LiteLLM 1.104.0 self-hosted, client is Claude Code. When set up "using OAuth app",
    authorization succeeds, but no MCP tools are found, with a 401 error.
  customer_goal: Sentry MCP server reachable through LiteLLM (AI gateway) from Claude Code.
components:
  client: Claude Code 2.1.x (MCP client = @modelcontextprotocol/sdk, TypeScript)
  gateway: LiteLLM proxy 1.104.0 (image ghcr.io/berriai/litellm:v1.104.0)
  upstream_mcp: Sentry hosted MCP, https://mcp.sentry.dev/mcp (Streamable HTTP)
  upstream_oauth_server: https://mcp.sentry.dev (its OWN OAuth 2.1 authorization server, not sentry.io)
repro_instance:
  base_url: https://fsmaster.com/litellm        # LiteLLM with SERVER_ROOT_PATH=/litellm
  per_server_url_pattern: https://fsmaster.com/litellm/<server_name>/mcp
  config: config.yaml (this repo)
```

## 2. Key facts (load these first)

| id | fact | status |
|---|---|---|
| F1 | `mcp.sentry.dev` only accepts access tokens issued by its own OAuth server (`https://mcp.sentry.dev/oauth/token`). Any sentry.io token (user auth token, org auth token `sntrys_...`, token from a sentry.io OAuth application) gets `401` + `WWW-Authenticate: Bearer realm="OAuth", error="invalid_token"` and body `{"error":"invalid_token","error_description":"Invalid access token"}`. | VERIFIED (org token). User token / sentry.io-OAuth-app token: INFERRED same result (token is not one mcp.sentry.dev issued). |
| F2 | `mcp.sentry.dev` metadata: PRM at `/.well-known/oauth-protected-resource/mcp` → `resource: https://mcp.sentry.dev/mcp`, `authorization_servers: [https://mcp.sentry.dev]`. AS metadata: authorize `/oauth/authorize`, token `/oauth/token`, DCR `/oauth/register`, PKCE S256, grants `authorization_code`, `refresh_token` (no `client_credentials`). | VERIFIED |
| F3 | When the upstream MCP server returns 401 during `tools/list`, LiteLLM returns HTTP 200 with `{"tools":[], "_meta":{"litellm.ai/server_outcomes":{"<server>":{"status":"auth_required","http_status":401}}}}`. The client sees "connected, 0 tools". The 401 is only visible in LiteLLM logs: `Error listing tools from <server>: HTTPStatusError ... upstream exchange: POST https://mcp.sentry.dev/ -> HTTP 401`. | VERIFIED |
| F4 | LiteLLM key placement: `x-litellm-api-key: Bearer <key>` is required when the `Authorization` header must carry an upstream OAuth token. If the LiteLLM key is in `Authorization`, LiteLLM forwards it upstream as the OAuth token. Debug header (`x-litellm-mcp-debug: true`) shows `x-mcp-debug-oauth2-token: ... (SAME_AS_LITELLM_KEY - likely misconfigured)` and `x-mcp-debug-auth-resolution: unresolved`. | VERIFIED |
| F5 | `auth_type: oauth_delegate`: LiteLLM serves the upstream PRM **verbatim** (`resource` stays `https://mcp.sentry.dev/mcp`). This is intentional: the token audience should be the upstream (see source S3). The MCP TS SDK used by Claude Code validates that PRM `resource` matches the URL it connected to, and aborts with `Protected resource https://mcp.sentry.dev/mcp does not match expected https://<gateway>/<server>/mcp (or origin)`. Claude Code `claude mcp list` shows `✗ Failed to connect`. | VERIFIED (client error + PRM body); design intent from SOURCE |
| F6 | Legacy spelling `auth_type: oauth2` + `oauth2_flow: authorization_code` + `delegate_auth_to_upstream: true` (logs deprecation warning in 1.104): PRM is rewritten (`resource` = gateway URL, `authorization_servers` = `https://<gateway>/<server>`), DCR relays to `mcp.sentry.dev/oauth/register`, `/<server>/authorize` 307-redirects to `https://mcp.sentry.dev/oauth/authorize` with `redirect_uri=https://<gateway>/callback`, Sentry consent page renders. Claude Code shows `! Needs authentication`. | VERIFIED up to consent page |
| F7 | Same as F6, after consent: token exchange through LiteLLM, then `tools/list` returning Sentry tools. | UNVERIFIED |
| F8 | `auth_type: oauth2` + `oauth2_flow: authorization_code` (no delegate flag) = "gateway-managed" mode. With a LiteLLM key present, 401 challenge is `WWW-Authenticate: Bearer authorization_uri="..."` (non-standard parameter, not `resource_metadata`). Claude Code ignores it, falls back to root RFC 9728 discovery, which advertises the LiteLLM gateway itself as authorization server (`/authorize/mcp-session` → 303 to `/sso/key/generate`, i.e. LiteLLM UI login), not Sentry. | VERIFIED (discovery + redirect); rest of flow UNVERIFIED |
| F9 | Aggregate endpoint with root path: `POST /litellm/mcp/` → `403 {"error":"The key is not allowed to access the requested MCP servers: litellm"}`. The root path segment is parsed as a server name. Per-server URLs work. | VERIFIED |
| F10 | MCP OAuth discovery hits the host ROOT (`/.well-known/oauth-protected-resource/<path>`, `/.well-known/oauth-authorization-server/<path>`). If LiteLLM is on a sub-path and the ingress does not route root `/.well-known/oauth-*` to LiteLLM, discovery fails. | VERIFIED (the paths clients requested); failure mode INFERRED |
| F11 | LLM auth and MCP auth are independent. Claude Code → LiteLLM for LLM uses `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (LiteLLM key). It has no effect on MCP 401s. | VERIFIED |

## 3. Symptom → cause decision tree

```text
Claude Code `claude mcp list` / `/mcp` status for the LiteLLM Sentry server:

"✓ Connected" but 0 tools
 ├─ LiteLLM log has "Error listing tools from <server>" + upstream 401 invalid_token
 │    ├─ server auth_type is bearer_token / api_key / oauth2 with sentry.io authorization_url/token_url,
 │    │  or client_credentials, or a static Sentry token → CAUSE C: sentry.io token sent to mcp.sentry.dev (F1)
 │    └─ debug header shows SAME_AS_LITELLM_KEY → CAUSE B3: LiteLLM key in Authorization (F4)
 └─ no upstream 401 in log → check key's MCP permissions / access groups (not reproduced here)

"✗ Failed to connect"
 ├─ server auth_type: oauth_delegate → CAUSE B: PRM resource mismatch (F5)
 ├─ PRM / AS metadata URLs 404 at host root → CAUSE: ingress / sub-path discovery (F10)
 └─ 403 "not allowed to access ... MCP servers: <root path>" → aggregate URL on sub-path (F9)

"! Needs authentication" and browser opens LiteLLM login (not Sentry)
 └─ gateway-managed oauth2 mode (F8). Expected behavior of that mode, not an error by itself.

"! Needs authentication" and browser opens mcp.sentry.dev consent
 └─ correct path (F6). If tools still missing after consent → F7 territory, collect logs.
```

Mapping to the customer's words ("can authorize" + "no tools" + "401"):
- Most likely: CAUSE C (they said "OAuth app"; a sentry.io OAuth application yields sentry.io tokens) → authorize succeeds on sentry.io, upstream rejects token, client shows no tools.
- Second: CAUSE B3.
- Less likely for "can authorize": CAUSE B (client fails before any browser step).
- None of this is confirmed for the customer until they share config + logs (section 7).

## 4. Recommended configuration (for explaining to customer)

```yaml
mcp_servers:
  sentry:
    url: https://mcp.sentry.dev/mcp
    transport: http
    auth_type: oauth2
    oauth2_flow: authorization_code
    delegate_auth_to_upstream: true
    # do NOT set client_id / client_secret / authorization_url / token_url to sentry.io values.
    # LiteLLM discovers mcp.sentry.dev metadata and does DCR there.
```

```bash
claude mcp add --transport http sentry https://<litellm-host>/sentry/mcp \
  --header "x-litellm-api-key: Bearer <litellm-virtual-key>"
# then in Claude Code: /mcp → sentry → Authenticate (browser → mcp.sentry.dev consent)
```

Caveats to state honestly:
- Final step (consent → tools) is UNVERIFIED in this repro (F7).
- This spelling is deprecated in 1.104; its replacement (`oauth_delegate`) does not work with Claude Code because of F5. A future LiteLLM release may change either behavior. Check LiteLLM release notes / source of the customer's exact version.
- Alternative that avoids gateway OAuth entirely: run Sentry's stdio MCP server (`npx @sentry/mcp-server --access-token=<sentry user auth token>`) as a LiteLLM stdio server (requires env `LITELLM_ENABLE_MCP_STDIO=true` on the proxy process; Node is present in the 1.104.0 image). Here a sentry.io user token IS correct, because the stdio server calls the Sentry API directly. UNVERIFIED in this repro.

## 5. Source pointers (LiteLLM 1.104.0, path prefix `litellm/proxy/_experimental/mcp_server/`)

| id | location | what it shows |
|---|---|---|
| S1 | `server.py` ~1594-1674 | per-mode 401 challenge logic: client_credentials → no challenge; gateway-managed authorization_code → `has_user_oauth_token` check, else 401 with `authorization_uri=`; delegate → challenge with `resource_metadata` only if no bearer, otherwise treat bearer as upstream token |
| S2 | `discoverable_endpoints.py:1878` (`/authorize/mcp-session`), `:2652` | gateway's own authorization server (LiteLLM login) |
| S3 | `discoverable_endpoints.py` ~2440-2536 | PRM builder. `oauth_delegate` / `true_passthrough` return upstream PRM verbatim (by design, audience = upstream); legacy `is_oauth_passthrough` rewrites `resource` to gateway URL |
| S4 | `mcp_server_manager.py:451-456`, `:1501` | `per_server_oauth_discovery` eligibility; deprecation warning for `oauth2` + `delegate_auth_to_upstream` → `oauth_delegate` |
| S5 | `mcp_server_manager.py:5314` | "Error listing tools from ..." warning (where upstream 401 is logged, then swallowed into empty list) |
| S6 | `mcp_debug.py:19-48`, `:314` | `x-litellm-mcp-debug` headers incl. `SAME_AS_LITELLM_KEY` detection |
| S7 | `exceptions.py:69-82`, `oauth_utils.py:219` | resource_metadata URL patterns `/{server}/mcp` vs `/mcp/{server}` |
| S8 | MCP TS SDK `client/auth.js` (v1.32.1) ~line 429 | client-side check that throws `Protected resource X does not match expected Y (or origin)` |

Note: the log line prints `POST https://mcp.sentry.dev/` (path missing). Not determined whether this is only log formatting or the real request path. If an agent has LiteLLM source access, check how `upstream exchange:` is formatted before calling it a bug.

## 6. Reproduction commands (no browser needed)

```bash
H=https://fsmaster.com/litellm          # or your own deployment
K=sk-<litellm key>                      # not published; ask repo owner or deploy your own
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
HDR=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")

# F1: sentry.io token rejected by hosted MCP
curl -si -X POST https://mcp.sentry.dev/mcp "${HDR[@]}" -H "Authorization: Bearer <sentry.io token>" -d "$INIT" | grep -i www-auth

# F3/C: connected, empty tools (upstream 401 hidden)
node scripts/probe.mjs $H/sentry_sentryio_token/mcp $K          # → "0 tools"

# F4/B3: key in wrong header
curl -s -D - -X POST $H/sentry_delegate/mcp "${HDR[@]}" -H "Authorization: Bearer $K" -H "x-litellm-mcp-debug: true" -d "$INIT" | grep -i x-mcp-debug

# F5/B: PRM not rewritten
curl -s $H/.well-known/oauth-protected-resource/litellm/sentry_delegate/mcp     # resource = mcp.sentry.dev
node scripts/probe.mjs $H/sentry_delegate/mcp $K                 # → "Protected resource ... does not match"

# F6/B2: correct discovery
curl -s $H/.well-known/oauth-protected-resource/litellm/sentry_delegate_legacy/mcp  # resource = gateway URL

# F8/A: gateway-managed challenge
curl -si -X POST $H/sentry/mcp "${HDR[@]}" -H "x-litellm-api-key: Bearer $K" -d "$INIT" | grep -i www-auth   # authorization_uri=

# Claude Code view of all variants (isolated config)
CLAUDE_CONFIG_DIR=/tmp/cc claude mcp list
```

Observed `claude mcp list` (VERIFIED):

```text
sentry-gateway          .../litellm/sentry/mcp                  ! Needs authentication      (A)
sentry-delegate         .../litellm/sentry_delegate/mcp         ✗ Failed to connect         (B)
sentry-delegate-wrongheader (Authorization: Bearer <litellm key>) ✗ Failed to connect       (B + B3)
sentry-io-token         .../litellm/sentry_sentryio_token/mcp   ✓ Connected  (0 tools)      (C)
sentry-delegate-legacy  .../litellm/sentry_delegate_legacy/mcp  ! Needs authentication      (B2)
sentry-direct           https://mcp.sentry.dev/mcp              ! Needs authentication      (baseline)
```

## 7. Data to request from the customer (ordered by diagnostic value)

1. `mcp_servers` entry for Sentry (config.yaml or LiteLLM UI), secrets removed. Key fields: `auth_type`, `oauth2_flow`, `delegate_auth_to_upstream`, `client_id`, `authorization_url`, `token_url`, `url`.
2. Origin of the "OAuth app": sentry.io (Settings → API Applications / custom integration) vs something else. If sentry.io → CAUSE C.
3. Claude Code server definition (`claude mcp get <name>` output or `.mcp.json`), headers redacted except header NAMES.
4. LiteLLM logs around the failure: `grep -i "Error listing tools\|upstream exchange"`.
5. Response headers of an `initialize` POST with `x-litellm-mcp-debug: true`.
6. Deployment: own hostname vs sub-path; whether root `/.well-known/oauth-*` reaches LiteLLM; value of `PROXY_BASE_URL`.

## 8. Guidance for an AI talking to the customer

- Do not state a root cause as confirmed. Say "most likely" and ask for items in section 7.
- Do not ask the customer to paste tokens or keys. Ask for header names and redacted config.
- Separate the two auth layers (F11) early; customers often mix up the LiteLLM key with the Sentry token.
- Sentry-side scope: Sentry owns `mcp.sentry.dev` behavior (F1, F2). LiteLLM gateway behavior (F3-F9) belongs to LiteLLM/BerriAI; point to their docs/issues instead of promising fixes.
- If the request turns into custom infrastructure design, the internal process is to escalate to the solutions/CSM team (per ticket notes).
- Version sensitivity: everything here is tied to LiteLLM 1.104.0 and Claude Code 2.1.x as of 2026-10-21. Re-check on newer versions.

## 9. Not covered / open items

- F7 (end-to-end success via B2) not yet confirmed.
- Gateway-managed mode (A) full flow: LiteLLM UI login then Sentry consent; not exercised.
- sentry.io OAuth application configured in LiteLLM (exact customer setup per hypothesis C) not built; C is simulated with an org token sent as static bearer, which hits the same upstream rejection (F1).
- stdio alternative (section 4) not exercised.
- Self-hosted Sentry + self-hosted sentry-mcp not covered.
