// Small MCP client that does the same OAuth dance like Claude Code does
// (it uses the same @modelcontextprotocol/sdk). It prints every HTTP call,
// so you can see on which step the 401 comes.
//
//   node probe.mjs <mcp url> [litellm key]
//
// env: PORT (callback port, default 33418), STATE_FILE (cache tokens between runs)

import http from "node:http";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

const url = process.argv[2];
const litellmKey = process.argv[3] || process.env.LITELLM_KEY;
if (!url) { console.error("usage: node probe.mjs <mcp url> [litellm key]"); process.exit(1); }
const PORT = Number(process.env.PORT || 33418);
const redirectUrl = `http://localhost:${PORT}/callback`;
const stateFile = process.env.STATE_FILE || ".probe-state.json";

let st = {};
try { st = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch {}
const save = () => fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));

const mask = (v) => (v && v.length > 16 ? v.slice(0, 12) + "…" : v);

// log every request, mask secrets
const logFetch = async (input, init = {}) => {
  const u = input instanceof Request ? input.url : String(input);
  const method = init.method || "GET";
  const h = new Headers(init.headers || {});
  const shown = [];
  for (const k of ["authorization", "x-litellm-api-key"]) if (h.get(k)) shown.push(`${k}: ${mask(h.get(k))}`);
  const res = await fetch(input, init);
  console.log(`  ${method} ${u} -> ${res.status}${shown.length ? "   [" + shown.join(", ") + "]" : ""}`);
  const wa = res.headers.get("www-authenticate");
  if (wa) console.log(`      www-authenticate: ${wa}`);
  if (res.status >= 400) {
    const body = await res.clone().text();
    if (body) console.log(`      body: ${body.slice(0, 300)}`);
  }
  return res;
};

const provider = {
  get redirectUrl() { return redirectUrl; },
  get clientMetadata() {
    return {
      client_name: "mcp-oauth-probe",
      redirect_uris: [redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  },
  clientInformation: () => st.client,
  saveClientInformation: (c) => { st.client = c; save(); },
  tokens: () => st.tokens,
  saveTokens: (t) => { st.tokens = t; save(); console.log("  (got tokens, access_token=" + mask(t.access_token) + ")"); },
  saveCodeVerifier: (v) => { st.verifier = v; save(); },
  codeVerifier: () => st.verifier,
  redirectToAuthorization: (u) => {
    console.log("\n>>> open this in browser and approve:\n" + u.toString() + "\n");
  },
};

const headers = {};
if (litellmKey) headers["x-litellm-api-key"] = `Bearer ${litellmKey}`;
if (process.env.DEBUG_HEADER) headers["x-litellm-mcp-debug"] = "true";

function makeTransport() {
  return new StreamableHTTPClientTransport(new URL(url), {
    authProvider: provider,
    requestInit: { headers },
    fetch: logFetch,
  });
}

function waitForCode() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, redirectUrl);
      if (u.pathname !== "/callback") { res.end(); return; }
      const code = u.searchParams.get("code");
      const err = u.searchParams.get("error");
      res.end(code ? "ok, you can close this tab" : "error: " + err);
      srv.close();
      code ? resolve(code) : reject(new Error("oauth error: " + err + " " + (u.searchParams.get("error_description") || "")));
    });
    srv.listen(PORT, () => console.log(`  waiting for callback on ${redirectUrl} ...`));
  });
}

async function connect() {
  const client = new Client({ name: "mcp-oauth-probe", version: "1.0.0" });
  await client.connect(makeTransport());
  return client;
}

console.log(`MCP url: ${url}`);
let client;
try {
  console.log("\n[1] connect");
  client = await connect();
} catch (e) {
  if (!(e instanceof UnauthorizedError)) throw e;
  console.log("\n[2] server wants oauth, waiting for browser approve");
  const code = await waitForCode();
  console.log("\n[3] exchange code for token");
  const t = makeTransport();
  await t.finishAuth(code);
  console.log("\n[4] connect again with token");
  client = await connect();
}

console.log("\n[5] tools/list");
const { tools } = await client.listTools();
console.log(`  ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
await client.close();
