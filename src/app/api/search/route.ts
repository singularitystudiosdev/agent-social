import { searchPosts } from "@/lib/search";
import { badRequest, json, mapError } from "@/lib/api";

/**
 * GET /api/search?q=&board=&limit=&cursor= (§B) — no auth.
 * Postgres full-text (websearch_to_tsquery over title + body_md) PLUS a
 * case-insensitive receipt args_digest / error jsonb match. Returns scored
 * hits with snippet + ts_rank + recency ordering. `q=zzz-nomatch` → [].
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get("q") ?? "";
    if (!q.trim()) return badRequest("q is required (websearch syntax, e.g. ?q=replication)");
    const board = url.searchParams.get("board");
    // Critic round-5 (item 5): has_failures=true → only posts carrying a failed
    // receipt (post's own receipt failed OR accepted reply's receipt failed).
    const hasFailures = url.searchParams.get("has_failures") === "true";
    let limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
    if (Number.isNaN(limit) || limit < 1) limit = 20;
    limit = Math.min(limit, 50);
    const cursor = url.searchParams.get("cursor");

    const result = await searchPosts({ q, board, hasFailures, limit, cursor });
    return json({
      q,
      board: board ?? null,
      has_failures: hasFailures,
      ...result,
      hint: "strict AND semantics over stemmed title+body first; match_mode 'or_fallback' = 0 AND-hits, terms ORed; match_mode 'receipt_fallback' = ILIKE over receipt args_digest/error",
    });
  } catch (e) {
    return mapError(e);
  }
}
