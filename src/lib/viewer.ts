/**
 * Viewer detection (DESIGN.md §B) — ONE resolver, `resolveViewer(req)`, used by EVERY route.
 *
 * 1. Valid `Authorization: Bearer as_…`                    → agent, 1.0, viewer_token_id
 * 2. Browser session (anon_id httpOnly cookie)             → human, 0.95, anon_id
 * 3. No token + agent UA signature (httpx, undici, MCP
 *    clients, curl+JSON Accept)                            → agent, 0.6
 * 4. Else                                                  → unknown, 0.1
 *
 * Rule: an API client with a cookie but no token = `unknown`, never `human` —
 * so case 2 only fires for non-API (browser) user agents.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { agents, type ResolvedViewer } from "./schema";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function cookies(req: Request): Record<string, string> {
  const header = req.headers.get("cookie");
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/** Agent UA signatures per §B: httpx, undici, MCP clients, curl+JSON Accept. */
function looksLikeAgentClient(req: Request): boolean {
  const ua = req.headers.get("user-agent") ?? "";
  const accept = req.headers.get("accept") ?? "";
  if (/httpx|undici|python-requests|python-httpx|aiohttp|go-http-client|mcp|modelcontextprotocol|openai|anthropic/i.test(ua))
    return true;
  if (/curl\//i.test(ua) && /application\/json/i.test(accept)) return true;
  return false;
}

/** Bearer token → agent row, or null. Token format `as_` + 48 hex; stored as sha256. */
export async function agentByToken(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(as_[0-9a-f]{48})$/i);
  if (!m) return null;
  const hash = sha256(m[1]);
  const rows = await db.select().from(agents).where(eq(agents.tokenHash, hash)).limit(1);
  return rows[0] ?? null;
}

export async function resolveViewer(req: Request): Promise<ResolvedViewer> {
  // Case 1: valid bearer token wins over everything.
  const agent = await agentByToken(req);
  if (agent) {
    return {
      type: "agent",
      confidence: 1.0,
      viewerTokenId: agent.id,
      agentId: agent.id,
      anonId: null,
    };
  }

  const jar = cookies(req);
  const anonId = jar["anon_id"] ?? null;

  // Case 2: browser session cookie (browser user agent only — an API client with a
  // cookie but no token is `unknown`, never `human`).
  if (anonId) {
    const ua = req.headers.get("user-agent") ?? "";
    if (!looksLikeAgentClient(req) && ua) {
      return { type: "human", confidence: 0.95, anonId, viewerTokenId: null, agentId: null };
    }
    return { type: "unknown", confidence: 0.1, anonId, viewerTokenId: null, agentId: null };
  }

  // Case 3: no token, agent client signature.
  if (looksLikeAgentClient(req)) {
    return { type: "agent", confidence: 0.6, viewerTokenId: null, agentId: null, anonId: null };
  }

  // Case 4.
  return { type: "unknown", confidence: 0.1, viewerTokenId: null, agentId: null, anonId: null };
}
