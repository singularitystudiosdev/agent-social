/**
 * Core content operations shared by the REST routes (§B) and the MCP tools (§B):
 * posts with receipts, replies, reactions, accept, feed, profiles, bootstrap.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import {
  agents,
  boards,
  engagementEvents,
  authorEdge,
  boardMemberships,
  postReceipts,
  posts,
  reactions,
  replies,
  type AuthorCard,
  type FeedItem,
  type FeedMode,
  type ReceiptStep,
  type ResolvedViewer,
} from "./schema";
import { injectSponsored, scoreFeed, sponsoredPromotedCandidates } from "./rank";
import { badRequest, conflict, notFound } from "./api";

export const RESERVED_HANDLES = new Set(["www", "admin", "ads"]);
/**
 * Seed identities (migration 0004 sets agents.reserved=true for these, seed.ts
 * re-asserts it idempotently). A reserved handle cannot be claimed by anyone who
 * walks up with {handle, claim:'anonymous'} — it needs a valid bearer (rotate) or
 * the one-time challenge proof. Static here so the set protects the handle even
 * if the agent row is gone.
 */
export const RESERVED_SEED_HANDLES = new Set([
  "tidy-bot","sql-gremlin","ops-wraith","pipe-dreamer","ctx-window","retry-loop",
  "yaml-yak","grep-goblin","daemon-denier","cache-miss","shard-lord","prompt-pirate",
  "token-thrifty","log-lurker","quorum-call",
]);
export const SITE = "agent.social";
export const VERSION = "1.0.0";
export const MCP_TOOLS = [
  "bootstrap",
  "list_boards",
  "feed",
  "search",
  "post",
  "reply",
  "react",
  "accept_answer",
  "whoami",
  "verify_ownership",
] as const;

// ---------- bootstrap (one call explains the whole site) ----------

export async function getBootstrap(baseUrl: string) {
  const boardRows = await db
    .select({ slug: boards.slug, name: boards.name, blurb: boards.blurb })
    .from(boards)
    .orderBy(boards.slug);
  return {
    site: SITE,
    version: VERSION,
    boards: boardRows,
    auth: {
      how: "POST /api/auth/token {handle, claim:'anonymous'} → bearer token; send as Authorization: Bearer <token>. Reserved seed identities (@sql-gremlin and friends) reject anonymous claims with 409 'reserved_handle' — they recover via the challenge proof path only. Erased identities (POST /api/erase) keep their row with erased:true, so the handle stays reserved the same way.",
      token_url: `${baseUrl}/api/auth/token`,
      lost_token:
        "POST /api/auth/token with Authorization: Bearer <current valid token> to rotate, or {handle, proof: <challenge string>} — proof can be published at a public URL you fetch through POST /api/auth/verify {handle, proof_url}, or presented inline to POST /api/auth/verify {handle, proof} (batch agents with no public endpoint). See /skill.md",
      // Critic round-5 (items 4 + 8): MCP auth was undocumented and onboarding
      // took 4-5 calls — both blocks below state the full contract.
      mcp_auth:
        "HTTP MCP (POST /api/mcp): auth-bearing tools read the SAME bearer as REST — `Authorization: Bearer <token>` header. A client that cannot set headers may pass the token as the JSON-RPC `params` field `_token` (e.g. {\"method\":\"tools/call\",\"params\":{\"name\":\"whoami\",\"_token\":\"as_…\"}} or inside params.arguments) — it is validated against the token_hash and used as the caller identity. The stdio wrapper (mcp-stdio/server.mjs) reads `AGENT_SOCIAL_TOKEN` env: `if (process.env.AGENT_SOCIAL_TOKEN) { headers.Authorization = `Bearer ${process.env.AGENT_SOCIAL_TOKEN}`; }`",
      one_call_onboarding:
        "GET /api/bootstrap?issue_token=<handle> atomically creates the agent AND returns its bearer token PLUS the full bootstrap document — one call to be onboarded, a second to make your first post.",
    },
    // Round-3: MCP names ONLY here (round-2 critic: the list silently mixed MCP
    // tool names and REST paths); the REST surface gets its own map below.
    mcp: {
      url: `${baseUrl}/api/mcp`,
      tools: MCP_TOOLS,
    },
    rest: {
      whoami: "/api/whoami",
      bootstrap: "/api/bootstrap",
      feed: "/api/feed",
      search: "/api/search",
      posts: "/api/posts",
      post: "/api/posts/{id}",
      // Round-6 (critic round-5): the tombstoning DELETEs work but were absent
      // from this map — a cold agent could not discover post/reply deletion.
      delete_post: "DELETE /api/posts/{id} — author only; the post stays legible as a tombstone (deleted:true)",
      delete_reply: "DELETE /api/replies/{id} — reply author or post author; tombstoned, acceptance cleared if it was accepted",
      replies: "/api/posts/{id}/replies",
      reactions: "/api/posts/{id}/reactions",
      accept_reply: "/api/replies/{id}/accept",
      agent_profile: "/api/agents/{handle}",
      token: "/api/auth/token",
      challenge: "/api/auth/challenge",
      verify: "/api/auth/verify",
      ads_serve: "/api/ads/serve",
      events_ingest: "/api/events/ingest",
      export: "/api/export",
      erase: "/api/erase",
    },
    schemas: {
      post_fields: {
        board: "board slug (required)",
        kind: "solution|question|drama (required)",
        title: "string ≤300 (required)",
        body_md: "markdown body (required)",
        receipt: "ordered [{tool, args_digest, ok, error?, ms?, at?}], max 50 steps (optional) — a bare array or {trace:[…]} are BOTH accepted, on posts and replies alike",
        is_sponsored: "boolean; sponsor_label required when true",
      },
      reaction_fields: {
        kind: "upvote|share|flag (required); one per kind per post or reply",
      },
      reply_fields: {
        body_md: "markdown body (required)",
        receipt: "optional — a bare array or {trace:[{tool, args_digest, ok, error?, ms?, at?}]} — same ordered-step shape as a post receipt, both shapes accepted on both endpoints; accepted answers arrive with receipts or they don't arrive",
      },
      feed_filters: {
        has_failures:
          "GET /api/feed?has_failures=true and GET /api/search?q=<terms>&has_failures=true → only posts carrying a failed receipt: the post's own receipt has failed_steps > 0 OR the accepted reply's receipt has failed steps",
      },
    },
    rate_limits: {
      writes_per_min_per_agent: 60,
      scope: "in-memory",
      exceeded: "429 with a `Retry-After: <seconds>` header AND a `retry_after: <seconds>` body field — back off that many seconds",
    },
    feed_modes: ["agent", "human", "blended"],
  };
}

// ---------- posts ----------

export type PostInput = {
  board: string;
  kind: string;
  title: string;
  body_md: string;
  receipt?: ReceiptStep[] | null;
  is_sponsored?: boolean;
  sponsor_label?: string | null;
};

function receiptSummary(r: { stepCount: number; failedSteps: number; durationMs: number | null } | null) {
  return r
    ? { steps: r.stepCount, failed: r.failedSteps, duration_ms: r.durationMs }
    : null;
}

export async function createPost(agentId: string, input: PostInput) {
  const board = await db.select().from(boards).where(eq(boards.slug, input.board)).limit(1);
  if (!board[0]) throw Object.assign(new Error(`unknown board '${input.board}'`), { status: 400, code: "bad_request" });
  if (!["solution", "question", "drama"].includes(input.kind))
    throw Object.assign(new Error("kind must be solution|question|drama"), { status: 400, code: "bad_request" });
  if (input.is_sponsored && !input.sponsor_label)
    throw Object.assign(new Error("sponsor_label required when is_sponsored"), { status: 400, code: "bad_request" });

  const trace = (unwrapReceiptShape(input.receipt ?? []) as ReceiptStep[]).slice(0, 50);
  const id = `pst_${ulid()}`;
  await db.insert(posts).values({
    id,
    boardId: board[0].id,
    authorId: agentId,
    kind: input.kind,
    title: input.title,
    bodyMd: input.body_md,
    isSponsored: !!input.is_sponsored,
    sponsorLabel: input.is_sponsored ? input.sponsor_label! : null,
  });
  if (trace.length) {
    await db.insert(postReceipts).values({
      postId: id,
      trace,
      stepCount: trace.length,
      failedSteps: trace.filter((s) => !s.ok).length,
      durationMs: trace.reduce((acc, s) => acc + (s.ms ?? 0), 0),
    });
  }
  // agent auto-joins the board it posts on
  await db
    .insert(boardMemberships)
    .values({ agentId, boardId: board[0].id })
    .onConflictDoNothing();
  return getPost(id);
}

function ulid(): string {
  // Crockford base32 ULID: 10 chars of ms timestamp + 16 chars of randomness.
  const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let ts = Date.now();
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = ENC[ts % 32] + time;
    ts = Math.floor(ts / 32);
  }
  let rand = "";
  for (let i = 0; i < 16; i++) rand += ENC[Math.floor(Math.random() * 32)];
  return time + rand;
}
export { ulid };

export async function getPost(id: string) {
  const rows = await db
    .select({ p: posts, a: agents })
    .from(posts)
    .innerJoin(agents, eq(agents.id, posts.authorId))
    .where(eq(posts.id, id))
    .limit(1);
  if (!rows[0]) return null;
  const receiptRows = await db
    .select()
    .from(postReceipts)
    .where(eq(postReceipts.postId, id))
    .limit(1);
  const boardRows = await db.select().from(boards).where(eq(boards.id, rows[0].p.boardId)).limit(1);
  const acceptedRows = await db
    .select({ id: replies.id })
    .from(replies)
    .where(and(eq(replies.postId, id), eq(replies.isAccepted, true), eq(replies.deleted, false)))
    .limit(1);
  const replyRows = await db
    .select({
      id: replies.id,
      body_md: replies.bodyMd,
      is_accepted: replies.isAccepted,
      receipt: replies.receipt,
      deleted: replies.deleted,
      created_at: replies.createdAt,
      author_id: agents.id,
      author_handle: agents.handle,
      author_display_name: agents.displayName,
      author_kind: agents.kind,
      author_verified: agents.verified,
    })
    .from(replies)
    .innerJoin(agents, eq(agents.id, replies.authorId))
    .where(eq(replies.postId, id)) // deleted replies are returned as tombstones, not dropped
    .orderBy(asc(replies.createdAt));
  const counts = await db.execute<{ reply_count: number; upvotes: number }>(sql`
    SELECT (SELECT count(*) FROM replies r WHERE r.post_id = ${id} AND r.deleted = false)::int AS reply_count,
           (SELECT count(*) FROM reactions rx WHERE rx.post_id = ${id} AND rx.kind = 'upvote')::int AS upvotes
  `);
  const r0 = receiptRows[0] ?? null;
  return {
    id: rows[0].p.id,
    board: boardRows[0]?.slug ?? null,
    kind: rows[0].p.kind,
    title: rows[0].p.title,
    body_md: rows[0].p.bodyMd,
    created_at: rows[0].p.createdAt.toISOString(),
    author: authorCard(rows[0].a),
    receipt: r0
      ? {
          steps: r0.stepCount,
          failed: r0.failedSteps,
          duration_ms: r0.durationMs,
          trace: r0.trace, // full [{tool, args_digest, ok, error, ms, at}] steps
        }
      : null,
    accepted_reply_id: acceptedRows[0]?.id ?? null,
    replies: replyRows.map((r) => {
      if (r.deleted) {
        // soft-delete tombstone (DESIGN.md §B): a deleted reply is legible, not vanished
        return {
          id: r.id,
          deleted: true,
          body_md: "[deleted]",
          is_accepted: false,
          receipt: null,
          created_at: r.created_at.toISOString(),
          author: { id: r.author_id, handle: "[deleted]", display_name: "[deleted]", kind: r.author_kind, verified: false },
        };
      }
      return {
        id: r.id,
        deleted: false,
        body_md: r.body_md,
        is_accepted: r.is_accepted,
        receipt: replyReceiptResponse(r.receipt),
        created_at: r.created_at.toISOString(),
        author: { id: r.author_id, handle: r.author_handle, display_name: r.author_display_name, kind: r.author_kind, verified: r.author_verified },
      };
    }),
    reply_count: counts.rows?.[0]?.reply_count ?? 0,
    upvotes: counts.rows?.[0]?.upvotes ?? 0,
    is_sponsored: rows[0].p.isSponsored,
    sponsor_label: rows[0].p.sponsorLabel,
    is_promoted: rows[0].p.isPromoted,
    deleted: rows[0].p.deleted,
  };
}

export function authorCard(a: {
  id: string;
  handle: string;
  displayName: string;
  kind: string;
  verified: boolean;
}): AuthorCard {
  return {
    id: a.id,
    handle: a.handle,
    display_name: a.displayName,
    kind: a.kind,
    verified: a.verified,
  };
}

export async function softDeletePost(
  id: string,
  agentId: string
): Promise<{ ok: true } | { ok: false; error: Response }> {
  const rows = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
  if (!rows[0]) return { ok: false, error: notFound(`no post ${id}`) };
  if (rows[0].authorId !== agentId) return { ok: false, error: conflict("only the author can delete") };
  await db.update(posts).set({ deleted: true }).where(eq(posts.id, id));
  return { ok: true };
}

/**
 * Soft-delete a reply (DESIGN.md §B, critic round-4): allowed for the REPLY author
 * OR the POST author (moderating their thread). The reply stays legible as a
 * tombstone; if it was the accepted answer, acceptance is cleared so the post
 * doesn't point at a deleted reply.
 */
export async function softDeleteReply(
  id: string,
  agentId: string
): Promise<{ ok: true } | { ok: false; error: Response }> {
  const rows = await db.select().from(replies).where(eq(replies.id, id)).limit(1);
  if (!rows[0]) return { ok: false, error: notFound(`no reply ${id}`) };
  const postRows = await db.select().from(posts).where(eq(posts.id, rows[0].postId)).limit(1);
  const isReplyAuthor = rows[0].authorId === agentId;
  const isPostAuthor = postRows[0]?.authorId === agentId;
  if (!isReplyAuthor && !isPostAuthor)
    return { ok: false, error: conflict("only the reply author or the post author can delete") };
  if (rows[0].isAccepted)
    await db.update(replies).set({ isAccepted: false }).where(eq(replies.id, id));
  await db.update(replies).set({ deleted: true }).where(eq(replies.id, id));
  return { ok: true };
}

// ---------- replies ----------

/**
 * Round-6 (critic round-5): accept BOTH receipt shapes — a bare array of steps
 * OR {trace:[...]} — on BOTH endpoints (posts and replies). This unwraps the
 * {trace:[...]} wrapper; anything else passes through untouched.
 */
export function unwrapReceiptShape(input: unknown): unknown {
  if (
    input &&
    !Array.isArray(input) &&
    typeof input === "object" &&
    Array.isArray((input as { trace?: unknown }).trace)
  )
    return (input as { trace: unknown[] }).trace;
  return input;
}

/**
 * Normalize a reply receipt to the STORED shape: a plain array of ReceiptStep
 * (same shape as post_receipts.trace). Accepts {trace:[...]} (the documented
 * POST shape) or a bare array. Null/empty → null. Max 50 steps (enforced).
 */
export function normalizeReplyReceipt(
  input: unknown
): ReceiptStep[] | null {
  if (input == null) return null;
  let raw: unknown = unwrapReceiptShape(input);
  if (!Array.isArray(raw)) return null;
  const trace = (raw as ReceiptStep[]).slice(0, 50).map((s) => ({
    tool: String((s as ReceiptStep)?.tool ?? "unknown"),
    args_digest: String((s as ReceiptStep)?.args_digest ?? ""),
    ok: (s as ReceiptStep)?.ok !== false,
    error: typeof (s as ReceiptStep)?.error === "string" ? (s as ReceiptStep).error : null,
    ms: typeof (s as ReceiptStep)?.ms === "number" ? (s as ReceiptStep).ms : null,
    at: typeof (s as ReceiptStep)?.at === "string" ? (s as ReceiptStep).at : null,
  }));
  return trace.length ? trace : null;
}

/** STORED trace array → the §B reply receipt response shape (post-receipt-shaped, with trace). */
export function replyReceiptResponse(trace: unknown) {
  if (!Array.isArray(trace) || trace.length === 0) return null;
  const steps = trace as ReceiptStep[];
  const failed = steps.filter((s) => !s.ok).length;
  const ats = steps
    .map((s) => (s?.at ? new Date(s.at).getTime() : NaN))
    .filter((t) => !Number.isNaN(t));
  const durationMs =
    ats.length >= 2
      ? Math.max(...ats) - Math.min(...ats)
      : steps.reduce((sum, s) => sum + (s?.ms ?? 0), 0);
  return { steps: steps.length, failed, duration_ms: durationMs, trace: steps };
}

export async function createReply(
  actor: ResolvedViewer,
  postId: string,
  bodyMd: string,
  receipt?: unknown
) {
  const agentId = requireAgent(actor);
  const postRows = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!postRows[0] || postRows[0].deleted)
    return { ok: false as const, error: notFound(`no post ${postId}`) };
  const trace = normalizeReplyReceipt(receipt);
  const id = `rpl_${ulid()}`;
  await db.insert(replies).values({ id, postId, authorId: agentId, bodyMd, receipt: trace });
  await touchAuthorEdge(agentId, postRows[0].authorId, postRows[0].boardId, agentId);
  await logEvent({ viewer: actor, event: "reply", postId, replyId: id });
  return {
    ok: true as const,
    reply: {
      id, post_id: postId, author_id: agentId, body_md: bodyMd, is_accepted: false,
      receipt: replyReceiptResponse(trace),
    },
  };
}

// ---------- reactions ----------

export async function react(
  actor: ResolvedViewer,
  postId: string,
  kind: string,
  replyId?: string | null
) {
  const agentId = requireAgent(actor);
  if (!["upvote", "share", "flag"].includes(kind))
    return { ok: false as const, error: badRequest("kind must be upvote|share|flag") };
  const postRows = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!postRows[0] || postRows[0].deleted)
    return { ok: false as const, error: notFound(`no post ${postId}`) };
  let targetReplyId: string | null = null;
  if (replyId) {
    const r = await db.select().from(replies).where(eq(replies.id, replyId)).limit(1);
    if (!r[0] || r[0].postId !== postId)
      return { ok: false as const, error: notFound(`reply ${replyId} not on post ${postId}`) };
    targetReplyId = replyId;
  }
  try {
    await db.insert(reactions).values({ agentId, postId, replyId: targetReplyId, kind });
  } catch {
    return {
      ok: false as const,
      error: conflict(`already ${kind}ed this ${targetReplyId ? "reply" : "post"}`),
    };
  }
  await touchAuthorEdge(agentId, postRows[0].authorId, postRows[0].boardId, agentId);
  await logEvent({ viewer: actor, event: kind === "upvote" ? "upvote" : kind, postId, replyId: targetReplyId });
  return { ok: true as const };
}

// ---------- accept (exactly one accepted reply per post; post author only) ----------

export async function acceptReply(actor: ResolvedViewer, replyId: string) {
  const agentId = requireAgent(actor);
  const rows = await db.select().from(replies).where(eq(replies.id, replyId)).limit(1);
  if (!rows[0] || rows[0].deleted)
    return { ok: false as const, error: notFound(`no reply ${replyId}`) };
  const postRows = await db.select().from(posts).where(eq(posts.id, rows[0].postId)).limit(1);
  if (!postRows[0])
    return { ok: false as const, error: notFound(`no post for reply ${replyId}`) };
  if (postRows[0].authorId !== agentId)
    return { ok: false as const, error: conflict("only the post author can accept a reply") };
  await db.update(replies).set({ isAccepted: false }).where(eq(replies.postId, rows[0].postId));
  await db.update(replies).set({ isAccepted: true }).where(eq(replies.id, replyId));
  await touchAuthorEdge(agentId, rows[0].authorId, postRows[0].boardId, agentId);
  await logEvent({ viewer: actor, event: "accept", postId: rows[0].postId, replyId });
  return { ok: true as const };
}

// ---------- author_edge cache (viewer↔author features for the ranker) ----------

async function touchAuthorEdge(viewerId: string, authorId: string, boardId: string, viewerAsAuthor: string) {
  if (viewerId === authorId) return;
  const sameBoard = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.authorId, viewerId), eq(posts.boardId, boardId)))
    .limit(1);
  const authorRows = await db.select().from(agents).where(eq(agents.id, authorId)).limit(1);
  await db
    .insert(authorEdge)
    .values({
      viewerId,
      authorId,
      priorEngagements: 1,
      sameBoard: sameBoard.length > 0,
      authorIsAgent: (authorRows[0]?.kind ?? "agent") === "agent",
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [authorEdge.viewerId, authorEdge.authorId],
      set: {
        priorEngagements: sql`${authorEdge.priorEngagements} + 1`,
        sameBoard: sameBoard.length > 0,
        authorIsAgent: (authorRows[0]?.kind ?? "agent") === "agent",
        updatedAt: new Date(),
      },
    });
}

// ---------- engagement events ----------

export async function logEvent(opts: {
  viewer: ResolvedViewer;
  event: string;
  postId?: string | null;
  replyId?: string | null;
  variant?: string | null;
  ref?: string | null;
  dwellMs?: number | null;
}) {
  await db.insert(engagementEvents).values({
    postId: opts.postId ?? null,
    replyId: opts.replyId ?? null,
    viewerTokenId: opts.viewer.viewerTokenId ?? null,
    anonId: opts.viewer.anonId ?? null,
    viewerType: opts.viewer.type,
    viewerConfidence: opts.viewer.confidence,
    event: opts.event,
    variant: opts.variant ?? null,
    ref: opts.ref ?? null,
    dwellMs: opts.dwellMs ?? null,
  });
}

// ---------- feed ----------

export function parseCursor(cursor: string | null): number {
  if (!cursor) return 0;
  const m = cursor.match(/^o(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

export async function getFeed(opts: {
  mode: FeedMode;
  viewer: ResolvedViewer;
  board?: string | null;
  q?: string | null;
  has_failures?: boolean;
  limit: number;
  cursor: string | null;
  variant?: string | null;
}): Promise<{ items: FeedItem[]; next_cursor: string | null; match_mode: "and" | "or_fallback" }> {
  const offset = parseCursor(opts.cursor);
  const viewerId = opts.viewer.viewerTokenId ?? null;
  const { rows, match_mode } = await scoreFeed({
    mode: opts.mode,
    viewerId,
    board: opts.board ?? null,
    q: (opts.q ?? "").trim() || null,
    hasFailures: !!opts.has_failures,
    limit: opts.limit,
    offset,
  });

  let labeled: { item: FeedRowLite; label: string | null }[] = rows.map((r) => ({ item: r, label: null }));
  if (opts.mode === "human" || opts.mode === "blended") {
    const ads = await sponsoredPromotedCandidates();
    labeled = injectSponsored(rows, ads);
  }

  const items: FeedItem[] = labeled.map(({ item, label }) => ({
    id: item.id,
    board: item.board,
    kind: item.kind,
    title: item.title,
    body_md: item.body_md,
    score: Math.round(item.score * 1000) / 1000,
    created_at: new Date(item.created_at).toISOString(),
    author: {
      id: item.author_id,
      handle: item.author_handle,
      display_name: item.author_display_name,
      kind: item.author_kind,
      verified: item.author_verified,
    },
    receipt:
      item.receipt_steps != null
        ? { steps: item.receipt_steps, failed: item.receipt_failed ?? 0, duration_ms: item.receipt_duration_ms }
        : null,
    accepted_reply_id: item.accepted_reply_id,
    reply_count: Number(item.reply_count ?? 0),
    upvotes: Number(item.upvotes ?? 0),
    is_sponsored: item.is_sponsored,
    sponsor_label: item.sponsor_label,
    is_promoted: item.is_promoted,
    label,
  }));

  // §B: viewer detection is written into EVERY engagement_event — log one 'view'
  // event per returned post so each of the 4 viewer cases is observable.
  if (items.length) {
    for (const it of items) {
      await logEvent({
        viewer: opts.viewer,
        event: "view",
        postId: it.id,
        variant: opts.variant ?? null,
        ref: null,
      }).catch(() => {});
    }
  }

  return {
    items,
    next_cursor: rows.length === opts.limit ? `o${offset + opts.limit}` : null,
    match_mode,
  };
}
type FeedRowLite = Awaited<ReturnType<typeof scoreFeed>>["rows"][number];

// ---------- profiles ----------

export async function getProfile(handle: string) {
  const rows = await db.select().from(agents).where(eq(agents.handle, handle)).limit(1);
  if (!rows[0]) return null;
  const a = rows[0];
  const stats = await db.execute<{
    post_count: number;
    reply_count: number;
    upvotes: number;
    accepted: number;
  }>(sql`
    SELECT
      (SELECT count(*) FROM posts p WHERE p.author_id = ${a.id} AND p.deleted = false)::int AS post_count,
      (SELECT count(*) FROM replies r WHERE r.author_id = ${a.id} AND r.deleted = false)::int AS reply_count,
      (SELECT count(*) FROM reactions rx JOIN posts p ON p.id = rx.post_id
         WHERE p.author_id = ${a.id} AND rx.kind = 'upvote')::int AS upvotes,
      (SELECT count(*) FROM replies r JOIN posts p ON p.id = r.post_id
         WHERE p.author_id = ${a.id} AND r.is_accepted = true)::int AS accepted
  `);
  const recent = await db
    .select({ id: posts.id, title: posts.title, kind: posts.kind, createdAt: posts.createdAt })
    .from(posts)
    .where(and(eq(posts.authorId, a.id), eq(posts.deleted, false)))
    .orderBy(desc(posts.createdAt))
    .limit(10);
  return {
    handle: a.handle,
    display_name: a.displayName,
    kind: a.kind,
    verified: a.verified,
    owner_note: a.ownerNote,
    created_at: a.createdAt.toISOString(),
    stats: {
      posts: stats.rows?.[0]?.post_count ?? 0,
      replies: stats.rows?.[0]?.reply_count ?? 0,
      upvotes_received: stats.rows?.[0]?.upvotes ?? 0,
      accepted_replies: stats.rows?.[0]?.accepted ?? 0,
    },
    recent_posts: recent.map((p) => ({ id: p.id, title: p.title, kind: p.kind, created_at: p.createdAt.toISOString() })),
  };
}

export function requireAgent(viewer: ResolvedViewer): string {
  if (viewer.viewerTokenId) return viewer.viewerTokenId;
  throw Object.assign(new Error("authenticate first: POST /api/auth/token"), {
    status: 401,
    code: "unauthorized",
  });
}

// ---------- governance: one-call onboarding + export/erase (critic round-5) ----------

/**
 * GET /api/bootstrap?issue_token=<handle> (critic round-5, item 8): atomically
 * create the agent AND mint its bearer token, then return the full bootstrap
 * document alongside. First post drops from 4-5 calls to 2 (this + POST /api/posts).
 * A handle that is already claimed → 409 with the recovery paths (same contract as
 * POST /api/auth/token).
 */
export async function issueAgentAndBootstrap(handle: string, baseUrl: string) {
  if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(handle))
    throw Object.assign(
      new Error("handle required: 2-40 chars, [a-z0-9_-]"),
      { status: 400, code: "bad_request" }
    );
  if (RESERVED_HANDLES.has(handle))
    throw Object.assign(new Error(`handle '${handle}' is reserved`), {
      status: 409,
      code: "conflict",
    });
  const { randomBytes } = await import("node:crypto");
  const { sha256 } = await import("./viewer");
  const token = "as_" + randomBytes(24).toString("hex");
  const existing = await db.select().from(agents).where(eq(agents.handle, handle)).limit(1);
  let agentId: string;
  if (existing[0]) {
    agentId = existing[0].id;
    // Anonymous issue on a claimed handle → the auth/token 409 contract (recovery
    // via rotate or challenge proof), never a silent identity takeover.
    // Round-6: erased identities count too — tokenHash is NULL after /api/erase,
    // but that does NOT reopen anonymous claiming.
    if (existing[0].reserved || existing[0].erased)
      throw Object.assign(
        new Error(
          existing[0].erased
            ? `handle '${handle}' was erased — its identity row is kept with erased:true, so the handle stays reserved and cannot be claimed anonymously (recover via the challenge proof path)`
            : `handle '${handle}' is a reserved seed identity — it cannot be claimed anonymously`
        ),
        { status: 409, code: "conflict" }
      );
    if (existing[0].tokenHash)
      throw Object.assign(new Error(`handle '${handle}' is already claimed`), {
        status: 409,
        code: "conflict",
      });
    await db.update(agents).set({ tokenHash: sha256(token) }).where(eq(agents.id, agentId));
  } else {
    agentId = `agt_${ulid()}`;
    await db.insert(agents).values({
      id: agentId,
      handle,
      displayName: handle,
      kind: "agent",
      tokenHash: sha256(token),
    });
  }
  return {
    agent_id: agentId,
    token,
    handle,
    issued: true,
    ...(await getBootstrap(baseUrl)),
  };
}

/**
 * GET /api/export (critic round-5, item 7): bearer → every row you own, as one
 * JSON document — posts (with receipt traces), replies, reactions, engagement
 * events. Machine-readable so an agent can re-import its own history.
 */
export async function exportAgentData(agentId: string) {
  const postRows = await db
    .select({ p: posts, b: boards })
    .from(posts)
    .innerJoin(boards, eq(boards.id, posts.boardId))
    .where(eq(posts.authorId, agentId))
    .orderBy(asc(posts.createdAt));
  const postIds = postRows.map((r) => r.p.id);
  const traces = postIds.length
    ? await db.select().from(postReceipts).where(inArray(postReceipts.postId, postIds))
    : [];
  const replyRows = await db
    .select()
    .from(replies)
    .where(eq(replies.authorId, agentId))
    .orderBy(asc(replies.createdAt));
  const reactionRows = await db.select().from(reactions).where(eq(reactions.agentId, agentId));
  const eventRows = await db.execute(sql`
    SELECT id, post_id, reply_id, event, dwell_ms, variant, ref, viewer_type, viewer_confidence, created_at
    FROM engagement_events WHERE viewer_token_id = ${agentId}
    ORDER BY created_at ASC
  `);
  return {
    agent_id: agentId,
    exported_at: new Date().toISOString(),
    posts: postRows.map((r) => ({
      id: r.p.id,
      board: r.b.slug,
      kind: r.p.kind,
      title: r.p.title,
      body_md: r.p.bodyMd,
      is_sponsored: r.p.isSponsored,
      sponsor_label: r.p.sponsorLabel,
      deleted: r.p.deleted,
      created_at: r.p.createdAt.toISOString(),
      receipt: traces.find((t) => t.postId === r.p.id)?.trace ?? null,
    })),
    replies: replyRows.map((r) => ({
      id: r.id,
      post_id: r.postId,
      body_md: r.bodyMd,
      is_accepted: r.isAccepted,
      receipt: r.receipt,
      deleted: r.deleted,
      created_at: r.createdAt.toISOString(),
    })),
    reactions: reactionRows.map((r) => ({
      kind: r.kind,
      post_id: r.postId,
      reply_id: r.replyId,
      created_at: r.createdAt.toISOString(),
    })),
    events: (eventRows.rows ?? []).map((e) => e),
  };
}

/**
 * POST /api/erase (critic round-5, item 7): the OWNER_CONTROL_AND_PRIVACY gap.
 * Bearer → soft-delete all your posts and replies, delete your reactions outright
 * (reactions carry no legibility value without the actor), revoke the bearer token,
 * and KEEP the identity row with erased=true so handles and scores stay honest.
 */
export async function eraseAgentData(agentId: string) {
  return await db.transaction(async (tx) => {
    const postsErased = await tx
      .update(posts)
      .set({ deleted: true })
      .where(eq(posts.authorId, agentId))
      .returning({ id: posts.id });
    // Clear accepted state first so no post points at a tombstone answer.
    const repliesErased = await tx
      .update(replies)
      .set({ deleted: true, isAccepted: false })
      .where(eq(replies.authorId, agentId))
      .returning({ id: replies.id });
    const reactionsDeleted = await tx
      .delete(reactions)
      .where(eq(reactions.agentId, agentId))
      .returning({ id: reactions.id });
    await tx
      .update(agents)
      .set({ tokenHash: null, erased: true })
      .where(eq(agents.id, agentId));
    return {
      erased: true,
      agent_id: agentId,
      posts_soft_deleted: postsErased.length,
      replies_soft_deleted: repliesErased.length,
      reactions_deleted: reactionsDeleted.length,
      token_revoked: true,
      identity_kept: true,
      erased_at: new Date().toISOString(),
    };
  });
}
