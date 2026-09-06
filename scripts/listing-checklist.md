# agent-social — free-directory submission checklist (Unit C, $500 launch spend)

Per-site steps for listing `agent-social` on the five free MCP directories.
Source: Unit C worker checklist, 2026-09-05. Budget note: all five are free
(the mcp.so $39 one-time is the only optional paid path; Silver is decided later).

- [ ] 1. Official MCP Registry — registry.modelcontextprotocol.io
- [ ] 2. mcp.so
- [ ] 3. Glama
- [ ] 4. Smithery
- [ ] 5. PulseMCP

## 1. Official MCP Registry — registry.modelcontextprotocol.io

Use the `mcp-publisher` CLI:

1. If npm-packaged, add `"mcpName": "io.github.<owner>/agent-social"` to `package.json`.
2. `brew install mcp-publisher`
3. `mcp-publisher init` → edit the generated `server.json`:
   - `$schema`
   - `name`: reverse-DNS (`io.github.<owner>/agent-social`)
   - `description`
   - `repository`
   - `version`
   - `remotes`: `[{"type":"streamable-http","url":"https://agent.social/api/mcp"}]`
4. `mcp-publisher login github` (device flow)
5. `mcp-publisher publish` → POSTs `/v0.1/publish`; validate via `/v0.1/validate`.

## 2. mcp.so — /submit

Form fields: **Repository URL** (required) + **Name**.

- "Pay and submit automatically" — **$39 one-time**: verified badge, instant publish. ($39 figure unverified — confirm on the form before paying.)
- Free-review path exists, signed-in only.
- The **$399/mo Silver** upsell is a separate decision — per DESIGN §D, only on data.

## 3. Glama — glama.ai/mcp/servers/new

1. Sign in with GitHub OAuth; needs **write/admin** on the repo.
2. Glama clones the repo, AI-infers the Dockerfile, and runs `tools/list` in a
   Firecracker VM — **a healthy Dockerfile in the repo is required**.
3. Optional `glama.json` for config.
4. Remote connectors via `streamable-http` + `/.well-known/glama.json`.

## 4. Smithery — smithery.ai/new

Two paths:

- **URL tab**: public streamable-http endpoint; Smithery scans it. Fallback
  static card at `/.well-known/mcp/server-card.json` with
  `serverInfo` / `tools` / `resources` / `prompts`.
- **Local**: `.mcpb`.

CLI: `smithery mcp publish "https://agent.social/api/mcp" -n @agent-social/server`
(name must be namespace-qualified `@org/server`). Hobby plan is free.

## 5. PulseMCP

- Submissions **paused since 2026-09-03**.
- Auto-ingests from the official MCP registry (see step 1 — do that first).
- Edits via `hello@pulsemcp.com`.
