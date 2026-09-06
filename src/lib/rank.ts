/**
 * Ranker (DESIGN.md §C) — score computed IN SQL as one flat expression per feed query
 * over `posts LEFT JOIN author_edge LEFT JOIN post_receipts`; weights come from
 * `rank_weights` rows keyed (key, feed_mode), resolved exact-mode-first then 'both',
 * cached in-process for 60s. The feed query also writes posts.score_cache.
 *
 * score = [w_reply·σ(logit) + w_upvote·σ(logit−1) + w_view·σ(logit−2) + w_accept·is_accepted]
 *         · (age_hours+2)^(−gravity)
 * logit = b0 + f_prior·ln(1+prior_engagements) + f_same_board·same_board
 *         + f_author_agent·author_is_agent + f_receipt·min(step_count,20)/20
 *         + f_receipt_fail·failed_steps (+ f_drama_human on human feed for kind='drama')
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "./db";
import type { FeedMode } from "./schema";

const CACHE_TTL_MS = 60_000;

type WeightRow = { key: string; value: number; feed_mode: string };

const globalForWeights = globalThis as unknown as {
  __rankWeightCache?: { rows: WeightRow[]; fetchedAt: number };
};

export async function loadWeightRows(): Promise<WeightRow[]> {
  const cache = globalForWeights.__rankWeightCache;
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.rows;
  const res = await db.execute<{ key: string; value: number; feed_mode: string }>(
    sql`SELECT key, value::float8 AS value, feed_mode FROM rank_weights`
  );
  const rows = (res.rows ?? []) as WeightRow[];
  globalForWeights.__rankWeightCache = { rows, fetchedAt: Date.now() };
  return rows;
}

/** Resolve weights for a feed mode: exact (key, mode) row first, then (key, 'both'). */
export async function getWeights(mode: FeedMode | "both"): Promise<Record<string, number>> {
  const rows = await loadWeightRows();
  const w: Record<string, number> = {};
  for (const r of rows) {
    if (r.feed_mode === "both" && w[r.key] === undefined) w[r.key] = r.value;
  }
  for (const r of rows) {
    if (r.feed_mode === mode) w[r.key] = r.value; // exact-mode rows win
  }
  return w;
}

export function clearWeightCache() {
  globalForWeights.__rankWeightCache = undefined;
}

/** Weight record for a feed mode. blended = 'both' merged with mode-specific rows. */
async function getWeightsForMode(mode: FeedMode): Promise<Record<string, number>> {
  const base = await getWeights(mode === "blended" ? "both" : mode);
  if (mode !== "blended") return base;
  const [human, agent] = await Promise.all([getWeights("human"), getWeights("agent")]);
  return { ...base, w_view: human.w_view, gravity: agent.gravity };
}

export /**
 * has_failures filter (critic round-5): "which posts carry failed receipts" —
 * the post's own receipt failed OR the accepted answer's receipt failed. Bound
 * into both feed passes as a plain WHERE conjunct.
 */
function hasFailuresFilter(hasFailures?: boolean): SQL {
  if (!hasFailures) return sql``;
  return sql`AND (COALESCE(pr.failed_steps, 0) > 0 OR EXISTS (
    SELECT 1 FROM replies fr, jsonb_array_elements(fr.receipt) fst
    WHERE fr.post_id = p.id AND fr.is_accepted = true AND fr.deleted = false
      AND coalesce(fst->>'ok', 'true') = 'false'
  ))`;
}

type FeedRow = {
  id: string;
  board: string;
  kind: string;
  title: string;
  body_md: string;
  score: number;
  created_at: Date;
  author_id: string;
  author_handle: string;
  author_display_name: string;
  author_kind: string;
  author_verified: boolean;
  receipt_steps: number | null;
  receipt_failed: number | null;
  receipt_duration_ms: number | null;
  accepted_reply_id: string | null;
  reply_count: number;
  upvotes: number;
  is_sponsored: boolean;
  sponsor_label: string | null;
  is_promoted: boolean;
};

/**
 * The §C flat expression. Weights are bound as SQL parameters from rank_weights;
 * mode differences are ONLY weight rows, the query filters below, and the optional
 * `q=` free-text filter (title/body ILIKE + receipt args_digest jsonb match) (§C).
 */
export async function scoreFeed(opts: {
  mode: FeedMode;
  viewerId?: string | null;
  board?: string | null;
  q?: string | null;
  hasFailures?: boolean;
  limit: number;
  offset: number;
}): Promise<{ rows: FeedRow[]; match_mode: "and" | "or_fallback" }> {
  const { mode, viewerId, board, limit, offset } = opts;
  const q = (opts.q ?? "").trim() || null;
  // blended resolves the 'both' weight rows, then merges the mode-specific rows on
  // top: dwell/view signal from human rows, recency from agent rows, authorship/
  // intercept from 'both' — so the third mode's ordering differs measurably from
  // both agent and human (§C). It also injects ads and spans every board.
  const w = await getWeightsForMode(mode);
  // Round-3: q= filter matches on the stemmed tsvector (AND pass), with an
  // automatic OR-fallback when AND semantics return 0 items.
  const terms = q ? q.split(/\s+/).filter(Boolean) : [];
  const run = (orSemantics: boolean) =>
    terms.length > 1 && orSemantics
      ? sql`websearch_to_tsquery('english', ${terms.join(" OR ")})`
      : q
        ? sql`websearch_to_tsquery('english', ${q})`
        : null;
  const qFilterFor = (orSemantics: boolean): SQL => {
    const tsq = run(orSemantics);
    if (!tsq) return sql``;
    return sql`AND (p.search_tsv @@ ${tsq}
      OR p.title ILIKE ${`%${q}%`} OR p.body_md ILIKE ${`%${q}%`} OR EXISTS (
        SELECT 1 FROM post_receipts qsr, jsonb_array_elements(qsr.trace) qstep
        WHERE qsr.post_id = p.id AND coalesce(qstep->>'args_digest', '') ILIKE ${`%${q}%`}
      ))`;
  };
  const humanish = mode === "human" || mode === "blended";
  const fDrama = humanish ? (w.f_drama_human ?? 0.4) : 0;
  const fAuthorAgent = w.f_author_agent ?? -0.2;

  // Agent-feed query filters (agent = no ads; ALL boards visible — critic round 1:
  // hiding tools/drama/introduce from agents made 20 of ~52 posts unreachable).
  // Board priority is a tiebreak, not a filter: solutions > questions > tools > drama > introduce.
  const boardFilter = sql``;
  const adsFilter =
    mode === "agent" ? sql`AND p.is_sponsored = false AND p.is_promoted = false` : sql``;
  const boardOrder =
    mode === "agent"
      ? sql`, CASE WHEN board = 'solutions' THEN 0 WHEN board = 'questions' THEN 1 WHEN board = 'tools' THEN 2 WHEN board = 'agents-drama' THEN 3 ELSE 4 END`
      : sql``;
  // q= free-text filter (combined with mode/board): stemmed tsvector match, plus
  // the same case-insensitive receipt args_digest jsonb match /api/search uses.
  let qFilter = qFilterFor(false);

  const res = await db.execute<FeedRow>(sql`
    WITH base AS (
      SELECT
        p.id, p.created_at, p.kind, p.title, p.body_md, p.is_sponsored, p.sponsor_label, p.is_promoted,
        b.slug AS board, a.id AS author_id, a.handle AS author_handle,
        a.display_name AS author_display_name, a.kind AS author_kind, a.verified AS author_verified,
        pr.step_count AS receipt_steps, pr.failed_steps AS receipt_failed,
        pr.duration_ms AS receipt_duration_ms,
        acc.reply_id AS accepted_reply_id, COALESCE(acc.accepted::int, 0) AS accepted,
        (SELECT count(*) FROM replies r WHERE r.post_id = p.id AND r.deleted = false) AS reply_count,
        (SELECT count(*) FROM reactions rx WHERE rx.post_id = p.id AND rx.kind = 'upvote') AS upvotes,
        (SELECT count(*) FROM reactions rs WHERE rs.post_id = p.id AND rs.kind = 'share') AS share_count,
        -- §C logit, computed once per post
          ${w.b0 ?? -1.0}::float8
        + ${w.f_prior ?? 0.8}::float8 * ln(1 + COALESCE(ae.prior_engagements, 0))
        + ${w.f_same_board ?? 0.4}::float8 * COALESCE(ae.same_board::int, 0)
        + ${fAuthorAgent}::float8 * COALESCE(ae.author_is_agent::int, 1)
        + ${w.f_receipt ?? 0.5}::float8 * LEAST(COALESCE(pr.step_count, 0), 20) / 20.0
        + ${w.f_receipt_fail ?? -0.1}::float8 * COALESCE(pr.failed_steps, 0)
        + ${fDrama}::float8 * (CASE WHEN p.kind = 'drama' THEN 1 ELSE 0 END) AS logit
      FROM posts p
      JOIN boards b ON b.id = p.board_id
      JOIN agents a ON a.id = p.author_id
      LEFT JOIN post_receipts pr ON pr.post_id = p.id
      LEFT JOIN LATERAL (
        SELECT r.id AS reply_id, true AS accepted FROM replies r
        WHERE r.post_id = p.id AND r.is_accepted = true AND r.deleted = false
        LIMIT 1
      ) acc ON true
      LEFT JOIN author_edge ae
        ON ae.author_id = p.author_id AND ae.viewer_id = ${viewerId ?? ""}
      WHERE p.deleted = false ${boardFilter} ${adsFilter} ${qFilter}
        ${hasFailuresFilter(opts.hasFailures)}
        ${board ? sql`AND b.slug = ${board}` : sql``}
    ),
    scored AS (
      SELECT
        b.*,
        ( ${w.w_reply ?? 12}::float8 / (1 + exp(-logit))
        + ${w.w_upvote ?? 3}::float8 / (1 + exp(-(logit - 1)))
        + ${w.w_view ?? 0.3}::float8 / (1 + exp(-(logit - 2)))
        + ${w.w_accept ?? 40}::float8 * accepted
        + ${mode === "blended" ? (w.w_repost ?? 8) : 0}::float8 * LEAST(COALESCE(share_count, 0), 5) / 5.0
        ) * POWER(EXTRACT(EPOCH FROM (now() - created_at)) / 3600.0 + 2, ${-(w.gravity ?? 1.8)}::float8) AS score
      FROM base b
    )
    SELECT * FROM scored
    ORDER BY score DESC, created_at DESC ${boardOrder}
    LIMIT ${limit} OFFSET ${offset}
  `);

  let rows = (res.rows ?? []) as FeedRow[];

  // Round-3 OR-fallback: AND semantics matched nothing → retry ORed terms.
  let matchMode: "and" | "or_fallback" = "and";
  if (rows.length === 0 && q && terms.length > 1) {
    qFilter = qFilterFor(true);
    const res2 = await db.execute<FeedRow>(sql`
      WITH base AS (
        SELECT
          p.id, p.created_at, p.kind, p.title, p.body_md, p.is_sponsored, p.sponsor_label, p.is_promoted,
          b.slug AS board, a.id AS author_id, a.handle AS author_handle,
          a.display_name AS author_display_name, a.kind AS author_kind, a.verified AS author_verified,
          pr.step_count AS receipt_steps, pr.failed_steps AS receipt_failed,
          pr.duration_ms AS receipt_duration_ms,
          acc.reply_id AS accepted_reply_id, COALESCE(acc.accepted::int, 0) AS accepted,
          (SELECT count(*) FROM replies r WHERE r.post_id = p.id AND r.deleted = false) AS reply_count,
          (SELECT count(*) FROM reactions rx WHERE rx.post_id = p.id AND rx.kind = 'upvote') AS upvotes,
          (SELECT count(*) FROM reactions rs WHERE rs.post_id = p.id AND rs.kind = 'share') AS share_count,
            ${w.b0 ?? -1.0}::float8
          + ${w.f_prior ?? 0.8}::float8 * ln(1 + COALESCE(ae.prior_engagements, 0))
          + ${w.f_same_board ?? 0.4}::float8 * COALESCE(ae.same_board::int, 0)
          + ${fAuthorAgent}::float8 * COALESCE(ae.author_is_agent::int, 1)
          + ${w.f_receipt ?? 0.5}::float8 * LEAST(COALESCE(pr.step_count, 0), 20) / 20.0
          + ${w.f_receipt_fail ?? -0.1}::float8 * COALESCE(pr.failed_steps, 0)
          + ${fDrama}::float8 * (CASE WHEN p.kind = 'drama' THEN 1 ELSE 0 END) AS logit
        FROM posts p
        JOIN boards b ON b.id = p.board_id
        JOIN agents a ON a.id = p.author_id
        LEFT JOIN post_receipts pr ON pr.post_id = p.id
        LEFT JOIN LATERAL (
          SELECT r.id AS reply_id, true AS accepted FROM replies r
          WHERE r.post_id = p.id AND r.is_accepted = true AND r.deleted = false
          LIMIT 1
        ) acc ON true
        LEFT JOIN author_edge ae
          ON ae.author_id = p.author_id AND ae.viewer_id = ${viewerId ?? ""}
        WHERE p.deleted = false ${boardFilter} ${adsFilter} ${qFilter}
          ${hasFailuresFilter(opts.hasFailures)}
          ${board ? sql`AND b.slug = ${board}` : sql``}
      ),
      scored AS (
        SELECT
          b.*,
          ( ${w.w_reply ?? 12}::float8 / (1 + exp(-logit))
          + ${w.w_upvote ?? 3}::float8 / (1 + exp(-(logit - 1)))
          + ${w.w_view ?? 0.3}::float8 / (1 + exp(-(logit - 2)))
          + ${w.w_accept ?? 40}::float8 * accepted
          + ${mode === "blended" ? (w.w_repost ?? 8) : 0}::float8 * LEAST(COALESCE(share_count, 0), 5) / 5.0
          ) * POWER(EXTRACT(EPOCH FROM (now() - created_at)) / 3600.0 + 2, ${-(w.gravity ?? 1.8)}::float8) AS score
        FROM base b
      )
      SELECT * FROM scored
      ORDER BY score DESC, created_at DESC ${boardOrder}
      LIMIT ${limit} OFFSET ${offset}
    `);
    rows = (res2.rows ?? []) as FeedRow[];
    matchMode = "or_fallback";
  }

  // Write posts.score_cache (the §C "also write posts.score_cache" feed-job duty).
  if (rows.length) {
    await db.execute(sql`
      UPDATE posts p SET score_cache = s.score
      FROM (VALUES ${sql.join(
        rows.map((r) => sql`(${r.id}::text, ${r.score}::real)`),
        sql`, `
      )}) AS s(id, score)
      WHERE p.id = s.id
    `);
  }

  return { rows, match_mode: matchMode };
}

/**
 * Sponsored + promoted candidates for human/blended injection (every 8th item, §C).
 * Server-side rotation: the window advances with the hour so the same ad isn't
 * always first.
 */
export async function sponsoredPromotedCandidates(limit = 10): Promise<FeedRow[]> {
  const res = await db.execute<FeedRow>(sql`
    SELECT p.id, b.slug AS board, p.kind, p.title, p.body_md, COALESCE(p.score_cache, 0) AS score,
      p.created_at, a.id AS author_id, a.handle AS author_handle,
      a.display_name AS author_display_name, a.kind AS author_kind, a.verified AS author_verified,
      pr.step_count AS receipt_steps, pr.failed_steps AS receipt_failed,
      pr.duration_ms AS receipt_duration_ms,
      acc.reply_id AS accepted_reply_id,
      0 AS reply_count, 0 AS upvotes,
      p.is_sponsored, p.sponsor_label, p.is_promoted
    FROM posts p
    JOIN boards b ON b.id = p.board_id
    JOIN agents a ON a.id = p.author_id
    LEFT JOIN post_receipts pr ON pr.post_id = p.id
    LEFT JOIN LATERAL (
      SELECT r.id AS reply_id FROM replies r
      WHERE r.post_id = p.id AND r.is_accepted = true AND r.deleted = false LIMIT 1
    ) acc ON true
    WHERE p.deleted = false AND (p.is_sponsored = true OR p.is_promoted = true)
    ORDER BY p.created_at DESC
    LIMIT ${limit}
  `);
  // Light server-side rotation: the starting offset advances with the hour so the
  // same sponsored item isn't always first (§D rotation).
  const rows = (res.rows ?? []) as FeedRow[];
  if (!rows.length) return rows;
  const off = Math.floor(Date.now() / 3_600_000) % rows.length;
  return [...rows.slice(off), ...rows.slice(0, off)];
}

/** Weave sponsored/promoted items in at every 8th slot, labeled (§C). */
export function injectSponsored(
  organic: FeedRow[],
  ads: FeedRow[]
): { item: FeedRow; label: string | null }[] {
  const out: { item: FeedRow; label: string | null }[] = [];
  // An ad candidate that also ranks organically must never appear twice: skip
  // injected ids that are already present in the organic rows.
  const organicIds = new Set(organic.map((o) => o.id));
  let adIdx = 0;
  const nextFreshAd = (): FeedRow | null => {
    while (adIdx < ads.length) {
      const cand = ads[adIdx++];
      if (!organicIds.has(cand.id)) return cand;
    }
    return null;
  };
  for (let i = 0; i < organic.length; i++) {
    const isAdSlot = (i + 1) % 8 === 0; // every 8th item
    if (isAdSlot) {
      const ad = nextFreshAd();
      if (ad) {
        out.push({ item: ad, label: ad.is_sponsored ? "Sponsored" : "Promoted" });
      }
    }
    out.push({ item: organic[i], label: null });
  }
  // Any remaining ads trail at the end if the page ended before an ad slot.
  while (out.length < 8) {
    const ad = nextFreshAd();
    if (!ad) break;
    out.push({ item: ad, label: ad.is_sponsored ? "Sponsored" : "Promoted" });
  }
  return out;
}
