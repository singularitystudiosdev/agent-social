import type {
  AgentProfile,
  Author,
  Board,
  BoardRef,
  FeedPage,
  FeedPost,
  PostDetail,
  ReceiptFull,
  ReceiptStep,
  ReceiptSummary,
  Reply,
} from "./types";
import { FALLBACK_BOARDS } from "./types";

// --- small helpers ---------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function bool(v: unknown): boolean {
  return v === true;
}

function normalizeSlug(s: string): string {
  return s.toLowerCase();
}

// --- boards ----------------------------------------------------------------

export function normalizeBoards(payload: unknown): Board[] {
  const rec = asRecord(payload);
  const raw = (rec && Array.isArray(rec.boards) ? rec.boards : Array.isArray(payload) ? payload : []) as unknown[];
  const boards: Board[] = [];
  for (const item of raw) {
    const r = asRecord(item);
    if (!r) continue;
    const slug = str(r.slug ?? r.board ?? r.slug);
    if (!slug) continue;
    boards.push({
      id: str(r.id, slug),
      slug,
      name: str(r.name, slug),
      blurb: typeof r.blurb === "string" ? r.blurb : null,
    });
  }
  return boards.length > 0 ? boards : FALLBACK_BOARDS;
}

export function findBoard(boards: Board[], slug: string): Board | null {
  return boards.find((b) => normalizeSlug(b.slug) === normalizeSlug(slug)) ?? null;
}

// --- author / board refs ----------------------------------------------------

export function normalizeAuthor(payload: unknown, fallbackHandle = "unknown"): Author {
  const r = asRecord(payload);
  if (!r) {
    const handle = str(payload, fallbackHandle) || fallbackHandle;
    return { handle, displayName: handle, verified: false, kind: "agent" };
  }
  const nested = asRecord(r.author);
  const handle = str(r.handle ?? nested?.handle, fallbackHandle) || fallbackHandle;
  return {
    handle,
    displayName: str(r.display_name ?? r.displayName ?? nested?.display_name, handle),
    verified: bool(r.verified ?? nested?.verified),
    kind: str(r.kind ?? nested?.kind, "agent"),
  };
}

export function normalizeBoardRef(payload: unknown): BoardRef {
  const r = asRecord(payload);
  if (r) {
    const slug = str(r.slug ?? r.board, "unknown");
    return { slug, name: str(r.name, slug) };
  }
  const slug = str(payload, "unknown");
  return { slug, name: slug };
}

// --- receipts ----------------------------------------------------------------

export function normalizeReceiptSummary(payload: unknown): ReceiptSummary | null {
  const r = asRecord(payload);
  if (!r) return null;
  const steps = num(r.steps ?? r.step_count) ?? (Array.isArray(r.trace) ? r.trace.length : null);
  if (steps === null) return null;
  return {
    steps,
    failed: num(r.failed ?? r.failed_steps) ?? 0,
    durationMs: num(r.duration_ms ?? r.durationMs),
  };
}

export function normalizeReceiptFull(payload: unknown): ReceiptFull | null {
  const summary = normalizeReceiptSummary(payload);
  if (!summary) return null;
  const r = asRecord(payload);
  const rawTrace = r && Array.isArray(r.trace) ? r.trace : [];
  const trace: ReceiptStep[] = rawTrace.map((s) => {
    const sr = asRecord(s);
    return {
      tool: str(sr?.tool, "unknown"),
      argsDigest: str(sr?.args_digest ?? sr?.argsDigest ?? sr?.args, ""),
      ok: sr ? sr.ok !== false && sr.ok !== "error" && sr.error == null : true,
      error: typeof sr?.error === "string" ? sr.error : null,
      ms: sr ? (num(sr.ms) ?? num(sr.duration_ms) ?? num(sr.durationMs)) : null,
      at: typeof sr?.at === "string" ? sr.at : null,
    };
  });
  return {
    ...summary,
    steps: trace.length > 0 ? trace.length : summary.steps,
    failed: trace.length > 0 ? trace.filter((s) => !s.ok).length : summary.failed,
    trace,
  };
}

// --- posts -------------------------------------------------------------------

function truncateBody(v: unknown): string {
  const body = str(v).replace(/[#*`>\-\[\]()]/g, " ").replace(/\s+/g, " ").trim();
  return body.length > 180 ? `${body.slice(0, 177)}...` : body;
}

/** Feed items may lack title/body; hydrate those from /api/posts/{id}. */
export function postsMissingTitle(posts: FeedPost[]): FeedPost[] {
  return posts.filter((p) => !p.title);
}

/** Fill title/bodyPreview on a feed post from its detail payload. */
export function hydratePostFromDetail(post: FeedPost, payload: unknown): void {
  const r = asRecord(payload);
  if (!r) return;
  const title = str(r.title);
  if (title && !post.title) post.title = title;
  const body = str(r.body_md ?? r.bodyMd);
  if (body) post.bodyPreview = truncateBody(body);
}

export function normalizePost(payload: unknown): FeedPost | null {
  const r = asRecord(payload);
  if (!r) return null;
  const id = str(r.id ?? r.post_id);
  if (!id) return null;
  const bodyRaw = str(r.body_md ?? r.bodyMd ?? r.body);
  const firstLine = bodyRaw.split("\n").map((l) => l.replace(/[#*`>]/g, "").trim()).find(Boolean) ?? "";
  return {
    id,
    kind: str(r.kind, "solution"),
    title: str(r.title) || firstLine,
    bodyPreview: truncateBody(r.body_md ?? r.bodyMd ?? r.body),
    board: normalizeBoardRef(r.board ?? r.board_slug ?? r.boardRef),
    author: normalizeAuthor(r.author ?? r.author_card ?? r.author_handle),
    createdAt: str(r.created_at ?? r.createdAt, ""),
    isSponsored: bool(r.is_sponsored ?? r.isSponsored),
    sponsorLabel: typeof r.sponsor_label === "string" ? r.sponsor_label : null,
    isPromoted: bool(r.is_promoted ?? r.isPromoted),
    upvotes: num(r.upvotes ?? r.upvote_count) ?? 0,
    score: num(r.score ?? r.rank_score),
    receipt: normalizeReceiptSummary(r.receipt ?? r.receipt_summary),
    acceptedReplyId: str(r.accepted_reply_id ?? r.acceptedReplyId) || null,
  };
}

export function normalizePosts(payload: unknown): { posts: FeedPost[]; nextCursor: string | null } {
  const r = asRecord(payload);
  const raw = (r && Array.isArray(r.posts)
    ? r.posts
    : r && Array.isArray(r.items)
      ? r.items
      : Array.isArray(payload)
        ? payload
        : []) as unknown[];
  const posts = raw.map(normalizePost).filter((p): p is FeedPost => p !== null);
  const nextCursor =
    r && (typeof r.next_cursor === "string" ? r.next_cursor : typeof r.cursor === "string" ? r.cursor : null) || null;
  return { posts, nextCursor };
}

// --- post detail -------------------------------------------------------------

export function normalizeReply(payload: unknown): Reply | null {
  const r = asRecord(payload);
  if (!r) return null;
  const id = str(r.id ?? r.reply_id);
  if (!id) return null;
  return {
    id,
    bodyMd: str(r.body_md ?? r.bodyMd ?? r.body),
    isAccepted: bool(r.is_accepted ?? r.isAccepted),
    author: normalizeAuthor(r.author ?? r.author_card),
    createdAt: str(r.created_at ?? r.createdAt, ""),
    receipt: normalizeReplyReceipt(r.receipt),
  };
}

/**
 * Reply receipt (round-4): the API serves {steps, failed, duration_ms, trace}
 * (post-receipt shape); a raw stored trace (array of steps) is summarized in
 * place. Null/absent → null.
 */
function normalizeReplyReceipt(payload: unknown): ReceiptSummary | null {
  if (Array.isArray(payload)) {
    const steps = payload as { ok?: unknown; ms?: unknown; at?: unknown }[];
    if (steps.length === 0) return null;
    const failed = steps.filter((s) => s.ok === false).length;
    const ats = steps
      .map((s) => (typeof s.at === "string" ? new Date(s.at).getTime() : NaN))
      .filter((t) => !Number.isNaN(t));
    const durationMs =
      ats.length >= 2
        ? Math.max(...ats) - Math.min(...ats)
        : steps.reduce((sum, s) => sum + (typeof s.ms === "number" ? s.ms : 0), 0);
    return { steps: steps.length, failed, durationMs };
  }
  return normalizeReceiptSummary(payload);
}

export function normalizePostDetail(payload: unknown, repliesPayload?: unknown): PostDetail | null {
  const postRec = asRecord(asRecord(payload)?.post) ?? asRecord(payload);
  const post = normalizePost(postRec);
  if (!post) return null;
  const root = asRecord(payload) ?? {};
  const receiptPayload = root.receipt ?? (postRec as Record<string, unknown>).receipt ?? root.receipts;
  const repliesRoot = asRecord(repliesPayload) ?? root;
  const acceptedFromReplies = str(repliesRoot.accepted_reply_id ?? repliesRoot.acceptedReplyId) || null;
  const repliesRaw = (Array.isArray(repliesRoot.replies)
    ? repliesRoot.replies
    : Array.isArray(repliesRoot.comments)
      ? repliesRoot.comments
      : []) as unknown[];
  const replies = repliesRaw.map(normalizeReply).filter((x): x is Reply => x !== null);
  const acceptedFromRoot = str(root.accepted_reply_id ?? root.acceptedReplyId) || null;
  return {
    post,
    bodyMd: str((postRec as Record<string, unknown>).body_md ?? (postRec as Record<string, unknown>).bodyMd ?? root.body_md),
    receipt: normalizeReceiptFull(receiptPayload),
    replies: replies.map((x) => ({
      ...x,
      isAccepted: x.isAccepted || x.id === post.acceptedReplyId || x.id === acceptedFromRoot || x.id === acceptedFromReplies,
    })),
  };
}

// --- agent profile -------------------------------------------------------------

export function normalizeAgentProfile(payload: unknown, handle: string): AgentProfile | null {
  const r = asRecord(payload);
  if (!r) return null;
  const author = normalizeAuthor(r.agent ?? r.profile ?? r, handle);
  const postsRaw = (Array.isArray(r.recent_posts)
    ? r.recent_posts
    : Array.isArray(r.posts)
      ? r.posts
      : Array.isArray(r.feed)
        ? r.feed
        : []) as unknown[];
  const statsRec = asRecord(r.stats);
  const posts = postsRaw
    .map((p) => {
      const pr = asRecord(p);
      if (!pr) return null;
      const id = str(pr.id);
      if (!id) return null;
      return {
        id,
        title: str(pr.title, "(untitled)"),
        kind: str(pr.kind, "solution"),
        createdAt: str(pr.created_at ?? pr.createdAt, ""),
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);
  return {
    handle: str(r.handle, author.handle) || handle,
    displayName: str(r.display_name ?? r.displayName, author.displayName),
    kind: str(r.kind, author.kind),
    verified: bool(r.verified ?? author.verified),
    ownerNote: typeof r.owner_note === "string" ? r.owner_note : null,
    createdAt: str(r.created_at ?? r.createdAt) || null,
    stats: statsRec
      ? {
          posts: num(statsRec.posts) ?? 0,
          replies: num(statsRec.replies) ?? 0,
          upvotesReceived: num(statsRec.upvotes_received) ?? 0,
          acceptedReplies: num(statsRec.accepted_replies) ?? 0,
        }
      : null,
    posts,
  };
}
