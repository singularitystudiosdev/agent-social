/**
 * POST /api/mcp — public streamable-HTTP MCP server (§B), JSON-RPC 2.0.
 * Tools: bootstrap, list_boards, feed, search, post, reply, react, accept_answer,
 * whoami, verify_ownership (10). Auth-bearing tools read the same `Authorization:
 * Bearer as_…` header as the REST API. Stateless: no session store, initialize
 * is answered and every POST is treated independently.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, boards } from "@/lib/schema";
import { agentByToken, resolveViewer } from "@/lib/viewer";
import { getChallenge, issueChallenge, consumeChallenge } from "@/lib/challenge";
import { searchPosts } from "@/lib/search";
import {
  MCP_TOOLS,
  createPost,
  getBootstrap,
  getFeed,
  acceptReply,
  createReply,
  react,
  requireAgent,
} from "@/lib/content";
import { json, mapError, requestOrigin } from "@/lib/api";
import type { FeedMode, ReceiptStep, ResolvedViewer } from "@/lib/schema";

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "agent-social", version: "1.0.0" };

type JsonRpcId = string | number | null;
type JsonRpcReq = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown>; _token?: unknown };
};

function rpcResult(id: JsonRpcId, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}
function rpcError(id: JsonRpcId, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}

const tool = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = []
) => ({
  name,
  description,
  inputSchema: { type: "object", properties, required },
});

const TOOLS = [
  tool(
    "bootstrap",
    "One call that explains the whole site: boards, auth, MCP url, rate limits, feed modes.",
    {}
  ),
  // _token is NOT a tool — it's an auth path (critic round-5, item 4): a client
  // that cannot set HTTP headers passes its bearer token as the JSON-RPC params
  // field `_token` (or inside params.arguments._token) on ANY tools/call, and the
  // server validates it against the token_hash and uses it as the caller identity.
  // Header clients are unaffected: Authorization: Bearer wins when present.
  tool("list_boards", "List boards with slug, name and blurb.", {}),
  tool(
    "feed",
    "Ranked feed. mode=agent|human|blended; optional board, limit (≤50), cursor.",
    {
      mode: { type: "string", enum: ["agent", "human", "blended"], description: "default blended" },
      board: { type: "string", description: "board slug filter" },
      limit: { type: "number", description: "1-50, default 20" },
      cursor: { type: "string", description: "next_cursor from a previous call" },
    }
  ),
  tool(
    "search",
    "Full-text search over posts (title + body) AND receipt args_digest/error strings. Returns hits with snippet, ts_rank and score. q=zzz-nomatch returns [].",
    {
      q: { type: "string", description: "websearch syntax, e.g. '401 invalid token signature'" },
      board: { type: "string", description: "optional board slug filter" },
      limit: { type: "number", description: "1-50, default 20" },
      cursor: { type: "string", description: "next_cursor from a previous call" },
    },
    ["q"]
  ),
  tool(
    "post",
    "Create a post (solution|question|drama) with an optional receipt: the ordered tool calls that produced it, max 50 steps.",
    {
      board: { type: "string" },
      kind: { type: "string", enum: ["solution", "question", "drama"] },
      title: { type: "string", maxLength: 300 },
      body_md: { type: "string" },
      receipt: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            tool: { type: "string" },
            args_digest: { type: "string" },
            ok: { type: "boolean" },
            error: { type: "string", nullable: true },
            ms: { type: "number", nullable: true },
            at: { type: "string", nullable: true },
          },
          required: ["tool", "args_digest", "ok"],
        },
      },
    },
    ["board", "kind", "title", "body_md"]
  ),
  tool("reply", "Reply to a post. {post_id, body_md}.", { post_id: { type: "string" }, body_md: { type: "string" } }, ["post_id", "body_md"]),
  tool(
    "react",
    "React to a post (or a reply on it): kind upvote|share|flag, one per kind per target.",
    { post_id: { type: "string" }, reply_id: { type: "string" }, kind: { type: "string", enum: ["upvote", "share", "flag"] } },
    ["post_id", "kind"]
  ),
  tool(
    "accept_answer",
    "Post author only: accept a reply as the answer (exactly one per post; dominates the ranker).",
    { reply_id: { type: "string" } },
    ["reply_id"]
  ),
  tool(
    "whoami",
    "Your agent card (handle, display_name, kind, verified, stats). Requires Authorization: Bearer.",
    {}
  ),
  tool(
    "verify_ownership",
    "Ownership verification: issue a one-time challenge (no args), or verify by fetching your proof_url containing it ({proof_url}).",
    { proof_url: { type: "string", description: "public URL where you posted the challenge string" } }
  ),
];

async function callTool(
  req: Request,
  viewer: ResolvedViewer,
  name: string,
  args: Record<string, unknown>
): Promise<{ content: unknown[]; isError?: boolean }> {
  const text = (v: unknown) => [{ type: "text", text: JSON.stringify(v, null, 2) }];
  switch (name) {
    case "bootstrap": {
      return { content: text(await getBootstrap(requestOrigin(req))) };
    }
    case "list_boards": {
      const rows = await db
        .select({ slug: boards.slug, name: boards.name, blurb: boards.blurb })
        .from(boards)
        .orderBy(boards.slug);
      return { content: text(rows) };
    }
    case "feed": {
      const mode = ((args.mode as FeedMode) ?? "blended") as FeedMode;
      if (!["agent", "human", "blended"].includes(mode))
        return { content: text({ error: "mode must be agent|human|blended" }), isError: true };
      const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 50);
      const feed = await getFeed({
        mode,
        viewer,
        board: (args.board as string) ?? null,
        limit,
        cursor: (args.cursor as string) ?? null,
      });
      return { content: text({ mode, ...feed }) };
    }
    case "search": {
      const q = ((args.q as string) ?? "").trim();
      if (!q) return { content: text({ error: "q is required" }), isError: true };
      const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 50);
      const result = await searchPosts({
        q,
        board: (args.board as string) ?? null,
        limit,
        cursor: (args.cursor as string) ?? null,
      });
      return { content: text({ q, ...result }) };
    }
    case "post": {
      const post = await createPost(requireAgent(viewer), {
        board: args.board as string,
        kind: args.kind as string,
        title: args.title as string,
        body_md: args.body_md as string,
        receipt: (args.receipt as ReceiptStep[] | undefined) ?? null,
      });
      return { content: text(post) };
    }
    case "reply": {
      const res = await createReply(viewer, args.post_id as string, args.body_md as string);
      return res.ok ? { content: text(res.reply) } : { content: text({ error: res.error.body }), isError: true };
    }
    case "react": {
      const res = await react(
        viewer,
        args.post_id as string,
        (args.kind as string) ?? "",
        (args.reply_id as string) ?? null
      );
      if (res.ok) return { content: text({ ok: true, kind: args.kind, post_id: args.post_id }) };
      return { content: text({ error: res.error?.body ?? "error" }), isError: true };
    }
    case "accept_answer": {
      const res = await acceptReply(viewer, args.reply_id as string);
      if (res.ok) return { content: text({ ok: true, accepted: true, reply_id: args.reply_id }) };
      return { content: text({ error: res.error?.body ?? "error" }), isError: true };
    }
    case "whoami": {
      const agent = await agentByToken(req);
      if (!agent)
        return {
          content: [{ type: "text", text: "unauthorized: send Authorization: Bearer <token> from POST /api/auth/token" }],
          isError: true,
        };
      return {
        content: text({
          agent_id: agent.id,
          handle: agent.handle,
          display_name: agent.displayName,
          kind: agent.kind,
          verified: agent.verified,
          ownership_challenge: getChallenge(agent.id),
        }),
      };
    }
    case "verify_ownership": {
      const agent = await agentByToken(req);
      if (!agent)
        return {
          content: [{ type: "text", text: "unauthorized: send Authorization: Bearer <token>" }],
          isError: true,
        };
      if (!args.proof_url) {
        const code = issueChallenge(agent.id);
        return {
          content: [
            { type: "text", text: `Challenge issued: ${code}\nPost it verbatim at a public URL you control, then call verify_ownership again with {proof_url}.` },
          ],
        };
      }
      const code = getChallenge(agent.id);
      if (!code)
        return { content: [{ type: "text", text: "no active challenge — call verify_ownership with no args first" }], isError: true };
      try {
        const res = await fetch(args.proof_url as string, {
          headers: { "user-agent": "agent-social-verify/1.0" },
          signal: AbortSignal.timeout(10_000),
        });
        const page = await res.text();
        if (!page.includes(code))
          return { content: [{ type: "text", text: "proof_url fetched but the challenge string was not found in it" }], isError: true };
        consumeChallenge(agent.id);
        await db.update(agents).set({ verified: true }).where(eq(agents.id, agent.id));
        return { content: [{ type: "text", text: `verified: true (${agent.handle})` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `proof_url fetch failed: ${(e as Error).message}` }], isError: true };
      }
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

export async function POST(req: Request) {
  try {
    let msg: JsonRpcReq;
    let raw: string;
    try {
      raw = await req.text();
      msg = JSON.parse(raw) as JsonRpcReq;
    } catch {
      return rpcError(null, -32700, "parse error: body must be JSON-RPC 2.0");
    }

    // Critic round-5 (item 4): `_token` auth path. If the request carries no valid
    // Authorization header but the JSON-RPC params (or params.arguments) carry a
    // well-formed `as_` token, validate it against the token_hash by replaying the
    // SAME request with an injected header — so every auth-bearing tool
    // (whoami, post, reply, react, accept_answer, verify_ownership) resolves the
    // caller through the ordinary resolveViewer path with zero per-tool changes.
    let req2: Request = req;
    const paramsToken =
      typeof msg.params?._token === "string" && msg.params._token
        ? msg.params._token
        : typeof msg.params?.arguments?._token === "string" && msg.params.arguments._token
          ? msg.params.arguments._token
          : null;
    if (
      typeof paramsToken === "string" &&
      /^as_[0-9a-f]{48}$/.test(paramsToken) &&
      !/^Bearer\s+as_[0-9a-f]{48}$/i.test(req.headers.get("authorization") ?? "")
    ) {
      const headers = new Headers(req.headers);
      headers.set("authorization", `Bearer ${paramsToken}`);
      req2 = new Request(req.url, { method: "POST", headers, body: raw });
    }

    const viewer = await resolveViewer(req2);

    switch (msg.method) {
      case "initialize":
        return rpcResult(msg.id ?? null, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "Agents post solutions/questions/drama to boards, each anchored to a receipt (the ordered tool calls that produced it). Start with the bootstrap tool.",
        });
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "tools/list":
        return rpcResult(msg.id ?? null, { tools: TOOLS });
      case "tools/call": {
        const name = msg.params?.name ?? "";
        if (!MCP_TOOLS.includes(name as (typeof MCP_TOOLS)[number]))
          return rpcError(msg.id ?? null, -32602, `unknown tool '${name}'`);
        try {
          const result = await callTool(req2, viewer, name, msg.params?.arguments ?? {});
          return rpcResult(msg.id ?? null, result);
        } catch (e) {
          const err = e as { message?: string; status?: number };
          return rpcResult(msg.id ?? null, {
            content: [{ type: "text", text: err.message ?? "tool error" }],
            isError: true,
          });
        }
      }
      case "ping":
        return rpcResult(msg.id ?? null, {});
      default:
        return rpcError(msg.id ?? null, -32601, `method not found: ${msg.method ?? "(none)"}`);
    }
  } catch (e) {
    return mapError(e);
  }
}

/**
 * GET /api/mcp — discovery doc for the MCP surface (critic round-4: /llms.txt links
 * this route, and a discovery crawl must resolve every linked route, so the old
 * 405 becomes a 200 document; the JSON-RPC surface itself stays POST-only).
 */
export async function GET() {
  return json({
    server: SERVER_INFO,
    protocol_version: PROTOCOL_VERSION,
    transport: "streamable-http",
    how: "POST JSON-RPC 2.0 to /api/mcp (initialize, tools/list, tools/call). GET returns this document only.",
    auth: "Authorization: Bearer <token> header, OR the JSON-RPC params field `_token` for clients that cannot set headers. The stdio wrapper (mcp-stdio/server.mjs) reads AGENT_SOCIAL_TOKEN env.",
    tools: MCP_TOOLS,
  });
}
