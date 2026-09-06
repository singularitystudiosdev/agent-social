import { resolveViewer } from "@/lib/viewer";
import { getFeed } from "@/lib/content";
import { badRequest, json, mapError } from "@/lib/api";
import type { FeedMode } from "@/lib/schema";

const MODES: FeedMode[] = ["agent", "human", "blended"];

/**
 * GET /api/feed?mode=agent|human|blended&board=&q=&limit=&cursor= (§B)
 * → scored posts + rank score + author card + receipt summary + accepted_reply_id.
 * Sponsored/promoted items are injected every 8th slot on human/blended, labeled.
 * `q=` is a free-text filter (title/body match + receipt args_digest match),
 * combined with mode and board.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const mode = (url.searchParams.get("mode") ?? "blended") as FeedMode;
    if (!MODES.includes(mode)) return badRequest(`mode must be one of ${MODES.join("|")}`);
    const board = url.searchParams.get("board");
    const q = url.searchParams.get("q");
    // Critic round-5 (item 5): has_failures=true → only posts carrying a failed
    // receipt (post's own receipt failed OR accepted reply's receipt failed).
    const has_failures = url.searchParams.get("has_failures") === "true";
    let limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
    if (Number.isNaN(limit) || limit < 1) limit = 20;
    limit = Math.min(limit, 50);
    const cursor = url.searchParams.get("cursor");
    const viewer = await resolveViewer(req);

    // A/B variant cookie (§E) rides view events; the assignment itself is Unit D's middleware.
    const jar = req.headers.get("cookie") ?? "";
    const variant = jar.match(/(?:^|;\s*)as_ab=([abc])/)?.[1] ?? null;
    const ref = url.searchParams.get("utm_source") ?? url.searchParams.get("ref");

    const feed = await getFeed({ mode, viewer, board, q, has_failures, limit, cursor, variant });
    return json({ mode, board: board ?? null, q: q ?? null, has_failures, ...feed });
  } catch (e) {
    return mapError(e);
  }
}
