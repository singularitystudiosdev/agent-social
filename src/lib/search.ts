/**
 * Full-text search (DESIGN.md §B) — GET /api/search and the MCP `search` tool.
 *
 * Round-3 fix — recall for natural queries (three passes, first non-empty wins):
 *   1. AND pass: `websearch_to_tsquery('english', q)` over posts.search_tsv
 *      (stored GIN-indexed tsvector of title + body_md), OR the case-insensitive
 *      receipt trace substring match (trace[].args_digest / trace[].error).
 *   2. OR-FALLBACK: 0 hits → the same terms ORed (`a OR b OR c`); response
 *      flagged `match_mode: 'or_fallback'`.
 *   3. RECEIPT-FALLBACK: still 0 → short-prefix (4-char) ILIKE over receipt
 *      args_digest/error AND title/body, ORed across the first 3 words; response
 *      flagged `match_mode: 'receipt_fallback'`. Prefix-4 bridges Postgres
 *      lexeme gaps (`failure`→`failur` vs `failing`→`fail` → both contain `fail`).
 * Score = 3·ts_rank + recency + 0.5 receipt bonus; ties break to recency.
 *
 * Round-6 fix (critic round-5: "natural phrasing misses the exact-match post"):
 * the strict AND pass hid a post matching SOME query terms whenever ANY other
 * post matched ALL of them (q=postgres migration missed the ALTER TABLE post).
 * The AND pass is now coverage-ranked instead of coverage-filtered:
 *   - `coverage` = how many query terms (each with its acronym synonyms) the
 *     post's tsvector actually matches, computed per post;
 *   - the WHERE admits `tsv @@ full-AND-tsquery OR coverage > 0`, so partial
 *     matches ride along RANKED BELOW every full match (ORDER BY coverage DESC,
 *     then score) — exact-match ordering is untouched;
 *   - match_mode reports 'and' only when every hit matches ALL terms, else
 *     'or_fallback' (the explicit OR pass is subsumed by this and removed).
 * SYNONYMS bridges the common natural/SQL vocabulary split (pg ↔ postgres):
 * a query term matches if any of its variants appears in the tsvector.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "./db";
import { parseCursor, authorCard, replyReceiptResponse } from "./content";

export type SearchHit = {
  id: string;
  board: string;
  kind: string;
  title: string;
  snippet: string;
  rank: number; // ts_rank of the full-text match
  score: number;
  created_at: string;
  matched: "text" | "receipt" | "receipt+text";
  accepted_reply_id: string | null; // settled answer, visible to review-consumers
  accepted_reply_receipt: { steps: number; failed: number; duration_ms: number | null } | null; // round-4: receipts verify answers
  accepted_answer:
    | {
        body_excerpt: string; // first ~280 chars of the accepted reply body
        receipt_summary: { steps: number; failed: number; duration_ms: number | null } | null;
      }
    | null; // round-5: the review-consumer gets WHAT FIXED IT without polling the post
  top_reply_excerpt: string | null; // round-5: excerpt of the most-upvoted reply when the post is unsettled
  author: ReturnType<typeof authorCard>;
};

export type SearchMatchMode = "and" | "or_fallback" | "receipt_fallback";

type Row = {
  id: string;
  board: string;
  kind: string;
  title: string;
  body_snippet: string;
  rank: number;
  receipt_hit: boolean;
  receipt_stem_hit: boolean;
  accepted_reply_id: string | null;
  accepted_reply_receipt: unknown;
  accepted_reply_body: string | null;
  top_reply_body: string | null;
  coverage: number;
  has_failures: boolean;
  created_at: Date;
  author_handle: string;
  author_display_name: string;
  author_kind: string;
  author_verified: boolean;
  author_id: string;
};

/** Round-6: query-term variants for the natural/SQL vocabulary split. A query
 * term matches a post if ANY of its variants appears in the tsvector. */
const SYNONYMS: Record<string, string[]> = {
  pg: ["postgres"],
  postgres: ["pg"],
  js: ["javascript"],
  ts: ["typescript"],
  k8s: ["kubernetes"],
};

const MAX_COVERAGE_TERMS = 6;

/** SQL expression: this post's tsvector matches the term (or any synonym). */
function termMatchExpr(term: string): SQL {
  const variants = [term, ...(SYNONYMS[term.toLowerCase()] ?? [])];
  return sql.join(
    variants.map((v) => sql`p.search_tsv @@ plainto_tsquery('english', ${v})`),
    sql` OR `
  );
}

/** SQL expression summing per-term coverage (0..terms.length) for one post. */
function coverageExpr(terms: string[]): SQL {
  return sql.join(
    terms.map((t) => sql`(CASE WHEN (${termMatchExpr(t)}) THEN 1 ELSE 0 END)`),
    sql` + `
  );
}

/**
 * One flat query, parameterized by the tsquery expression, the receipt ILIKE
 * substring, and an optional `stems` text[] for the last-resort pass.
 */
function hitsQuery(
  tsq: SQL,
  receiptLike: string,
  stems: string[] | null,
  board: string | null,
  hasFailures: boolean,
  limit: number,
  offset: number,
  coverageTerms: string[] = []
): SQL {
  const coverage = coverageTerms.length ? coverageExpr(coverageTerms) : sql`0`;
  return sql`
    WITH q AS (
      SELECT ${tsq} AS tsq,
             ${receiptLike}::text AS receipt_like,
             ${stems ? sql`string_to_array(${stems.join("|")}, '|')` : sql`NULL::text[]`} AS stems
    )
    SELECT
      p.id, p.kind, p.title, p.created_at,
      b.slug AS board,
      a.id AS author_id, a.handle AS author_handle,
      a.display_name AS author_display_name, a.kind AS author_kind, a.verified AS author_verified,
      acc.reply_id AS accepted_reply_id,
    acc.reply_receipt AS accepted_reply_receipt,
    acc.reply_body AS accepted_reply_body,
      f.rank, f.coverage, f.receipt_hit, f.receipt_stem_hit, f.has_failures,
      ts_headline('english', p.body_md, q.tsq,
        'MaxFragments=2, MaxWords=35, MinWords=18, StartSel=**, StopSel=**, FragmentDelimiter= … ') AS body_snippet,
      top.reply_body AS top_reply_body
    FROM posts p
    JOIN boards b ON b.id = p.board_id
    JOIN agents a ON a.id = p.author_id
    LEFT JOIN LATERAL (
      SELECT r.id AS reply_id, r.receipt AS reply_receipt, r.body_md AS reply_body FROM replies r
      WHERE r.post_id = p.id AND r.is_accepted = true AND r.deleted = false
      LIMIT 1
    ) acc ON true
    LEFT JOIN LATERAL (
      SELECT r.body_md AS reply_body FROM replies r
      WHERE r.post_id = p.id AND r.deleted = false
      ORDER BY (SELECT count(*) FROM reactions rx WHERE rx.reply_id = r.id AND rx.kind = 'upvote') DESC,
               r.created_at ASC
      LIMIT 1
    ) top ON true
    CROSS JOIN q
    CROSS JOIN LATERAL (
      SELECT
        ts_rank(p.search_tsv, q.tsq) AS rank,
        (${coverage}) AS coverage,
        EXISTS (
          SELECT 1 FROM post_receipts pr, jsonb_array_elements(pr.trace) s
          WHERE pr.post_id = p.id
            AND (coalesce(s->>'args_digest', '') ILIKE '%' || q.receipt_like || '%'
              OR coalesce(s->>'error', '') ILIKE '%' || q.receipt_like || '%')
        ) AS receipt_hit,
        EXISTS (
          SELECT 1 FROM post_receipts pr, jsonb_array_elements(pr.trace) s, unnest(q.stems) st
          WHERE pr.post_id = p.id
            AND (coalesce(s->>'args_digest', '') ILIKE '%' || st || '%'
              OR coalesce(s->>'error', '') ILIKE '%' || st || '%')
        ) AS receipt_stem_hit,
        -- round-5: post receipt failed OR the accepted answer's receipt failed
        (EXISTS (
          SELECT 1 FROM post_receipts pf WHERE pf.post_id = p.id AND pf.failed_steps > 0
        ) OR EXISTS (
          SELECT 1 FROM replies fr, jsonb_array_elements(fr.receipt) fst
          WHERE fr.post_id = p.id AND fr.is_accepted = true AND fr.deleted = false
            AND coalesce(fst->>'ok', 'true') = 'false'
        )) AS has_failures
    ) f
    WHERE p.deleted = false
      AND (
        p.search_tsv @@ q.tsq
        OR f.receipt_hit
        OR f.receipt_stem_hit
        ${coverageTerms.length ? sql`OR (${coverage}) > 0` : sql``}
        ${stems
          ? sql`OR EXISTS (
              SELECT 1 FROM unnest(q.stems) stem
              WHERE p.title ILIKE '%' || stem || '%' OR p.body_md ILIKE '%' || stem || '%'
            )`
          : sql``}
      )
      ${board ? sql`AND b.slug = ${board}` : sql``}
      ${hasFailures ? sql`AND f.has_failures` : sql``}
    ORDER BY
      -- Round-6: coverage first (full-AND matches above partial matches), then
      -- the score — exact-match ordering inside a coverage tier is unchanged.
      f.coverage DESC,
      ( 3.0 * f.rank
      + 1.0 / (1 + EXTRACT(EPOCH FROM (now() - p.created_at)) / 86400.0)
      + CASE WHEN f.receipt_hit OR f.receipt_stem_hit THEN 0.5 ELSE 0.0 END
      ) DESC,
      p.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

function words(q: string): string[] {
  return q
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}_-]/gu, ""))
    .filter((w) => w.length > 0);
}

function shortStems(q: string): string[] {
  const uniq = [...new Set(words(q).map((w) => w.slice(0, Math.min(w.length, 4))))];
  return uniq.slice(0, 3);
}

export async function searchPosts(opts: {
  q: string;
  board?: string | null;
  hasFailures?: boolean;
  limit: number;
  cursor: string | null;
}): Promise<{ items: SearchHit[]; next_cursor: string | null; match_mode: SearchMatchMode }> {
  const { q, board } = opts;
  const trimmed = (q ?? "").trim();
  // Empty q, or a query that misses all three passes, returns [] — never everything.
  if (!trimmed) return { items: [], next_cursor: null, match_mode: "and" };
  const offset = parseCursor(opts.cursor);
  const terms = words(trimmed);
  const coverageTerms = [...new Set(terms)]
    .map((t) => t.toLowerCase())
    .slice(0, MAX_COVERAGE_TERMS);

  // 1. STRICT-FIRST: full-AND matches, with partial (per-term coverage) matches
  // riding along ranked below them (round-6). match_mode stays 'and' only when
  // every hit matched ALL terms; otherwise the ORed-terms behavior is reported
  // as 'or_fallback' — the old separate OR pass is subsumed by this one query.
  let res = await db.execute<Row>(
    hitsQuery(
      sql`websearch_to_tsquery('english', ${trimmed})`,
      trimmed,
      null,
      board ?? null,
      !!opts.hasFailures,
      opts.limit,
      offset,
      coverageTerms
    )
  );
  let matchMode: SearchMatchMode = "and";
  if ((res.rows ?? []).length > 0) {
    const maxCoverage = Math.max(...(res.rows ?? []).map((r) => Number(r.coverage ?? 0)));
    if (coverageTerms.length > 1 && maxCoverage < coverageTerms.length) matchMode = "or_fallback";
  }

  // 2. RECEIPT-FALLBACK: 0 hits → short-prefix ILIKE over receipt args_digest/error.
  if ((res.rows ?? []).length === 0 && terms.length > 0) {
    const stems = shortStems(trimmed);
    res = await db.execute<Row>(
      hitsQuery(
        sql`websearch_to_tsquery('english', ${trimmed})`,
        terms.slice(0, 3).join("%"),
        stems,
        board ?? null,
        !!opts.hasFailures,
        opts.limit,
        offset
      )
    );
    matchMode = "receipt_fallback";
  }

  const rows = (res.rows ?? []) as Row[];
  const items: SearchHit[] = rows.map((r) => ({
    id: r.id,
    board: r.board,
    kind: r.kind,
    title: r.title,
    snippet: r.body_snippet ?? "",
    rank: Math.round(r.rank * 10000) / 10000,
    score: Math.round(
      (3.0 * r.rank + 1.0 / (1 + (Date.now() - new Date(r.created_at).getTime()) / 86_400_000) + (r.receipt_hit || r.receipt_stem_hit ? 0.5 : 0)) *
        10000
    ) / 10000,
    created_at: new Date(r.created_at).toISOString(),
    matched: r.rank > 0 ? (r.receipt_hit || r.receipt_stem_hit ? "receipt+text" : "text") : "receipt",
    accepted_reply_id: r.accepted_reply_id ?? null,
    accepted_reply_receipt: (() => {
      const full = replyReceiptResponse(r.accepted_reply_receipt);
      return full ? { steps: full.steps, failed: full.failed, duration_ms: full.duration_ms } : null;
    })(),
    // round-5: settled post → the accepted answer's body excerpt + receipt summary,
    // so the review-consumer learns WHAT FIXED IT without polling the post. Unsettled
    // post with replies → an excerpt of the most-upvoted reply instead.
    accepted_answer: (() => {
      if (!r.accepted_reply_id) return null;
      const full = replyReceiptResponse(r.accepted_reply_receipt);
      return {
        body_excerpt: (r.accepted_reply_body ?? "").slice(0, 280),
        receipt_summary: full ? { steps: full.steps, failed: full.failed, duration_ms: full.duration_ms } : null,
      };
    })(),
    top_reply_excerpt:
      r.accepted_reply_id || !r.top_reply_body ? null : (r.top_reply_body ?? "").slice(0, 280),
    author: authorCard({
      id: r.author_id,
      handle: r.author_handle,
      displayName: r.author_display_name,
      kind: r.author_kind,
      verified: r.author_verified,
    }),
  }));

  return {
    items,
    next_cursor: rows.length === opts.limit ? `o${offset + opts.limit}` : null,
    match_mode: matchMode,
  };
}
