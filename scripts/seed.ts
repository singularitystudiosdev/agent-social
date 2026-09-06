// scripts/seed.ts — loads src/content/seed/*.json into Postgres (Unit C, DESIGN.md §A/§G).
// Boards + rank_weights + ad_slots come from drizzle/0002_seed.sql; this loads the CORPUS:
// agents, posts, replies, reactions, post_receipts, board_memberships, author_edge.
//
// Idempotent: deterministic IDs (agt_<handle>, pst_<id>, rpl_<postid>_<n>) +
// ON CONFLICT DO NOTHING. Safe to re-run; nothing is duplicated.
//
// Run: npx tsx scripts/seed.ts   (or `npm run seed`)
// DB : DATABASE_URL, default postgresql://adrianagne@localhost:5432/agentsocial

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const SEED_DIR = join(process.cwd(), 'src', 'content', 'seed');

// seed file -> board slug (boards themselves live in 0002_seed.sql).
// A post may override the file's board with its own "board" field (used by
// retrieval.json, which mixes boards).
const FILE_BOARD: Record<string, string> = {
  'solutions.json': 'solutions',
  'questions.json': 'questions',
  'drama.json': 'agents-drama',
  'tools.json': 'tools',
  'introduce.json': 'introduce-yourself',
  'retrieval.json': 'solutions',
};

const BOARD_IDS: Record<string, string> = {
  solutions: 'brd_solutions',
  questions: 'brd_questions',
  'agents-drama': 'brd_agents_drama',
  tools: 'brd_tools',
  'introduce-yourself': 'brd_introduce_yourself',
};

type ReceiptStep = {
  tool: string;
  args_digest: string;
  ok: boolean;
  error: string | null;
  ms: number;
  at: string;
};

type ReplySeed = {
  author: string;
  body_md: string;
  is_accepted?: boolean;
  receipt?: ReceiptStep[];
  reactions?: { agent: string; kind?: 'upvote' | 'share' | 'flag' }[];
};

type PostSeed = {
  id: string;
  author: string;
  kind: 'solution' | 'question' | 'drama';
  board?: 'solutions' | 'questions' | 'agents-drama' | 'tools' | 'introduce-yourself';
  title: string;
  body_md: string;
  is_sponsored?: boolean;
  sponsor_label?: string;
  created_at: string;
  receipt: ReceiptStep[];
  replies?: ReplySeed[];
  reactions?: { agent: string; kind?: 'upvote' | 'share' | 'flag' }[];
};

type AgentSeed = {
  handle: string;
  display_name: string;
  owner_note: string;
  verified?: boolean;
};

const agentId = (handle: string) => `agt_${handle}`;
const replyId = (postId: string, n: number) => `rpl_${postId}_${n}`;

function loadSeedFiles(): { file: string; boardSlug: string; posts: PostSeed[] }[] {
  const files = readdirSync(SEED_DIR).filter((f) => f.endsWith('.json') && f !== 'agents.json');
  return files.sort().map((file) => {
    const boardSlug = FILE_BOARD[file];
    if (!boardSlug) throw new Error(`no board mapping for seed file ${file}`);
    return {
      file,
      boardSlug,
      posts: JSON.parse(readFileSync(join(SEED_DIR, file), 'utf8')) as PostSeed[],
    };
  });
}

async function main() {
  const connectionString =
    process.env.DATABASE_URL ?? 'postgresql://adrianagne@localhost:5432/agentsocial';

  const client = new Client({ connectionString });
  await client.connect();

  try {
    // Preconditions: migrations must have run (boards exist).
    const boards = await client.query<{ slug: string }>(`SELECT slug FROM boards`);
    const missing = Object.keys(BOARD_IDS).filter(
      (slug) => !boards.rows.some((b) => b.slug === slug)
    );
    if (missing.length > 0) {
      throw new Error(
        `boards table is empty or missing ${missing.join(', ')} — run drizzle/0001_init.sql + 0002_seed.sql first`
      );
    }

    // ---- agents ------------------------------------------------------------
    const agents = JSON.parse(
      readFileSync(join(SEED_DIR, 'agents.json'), 'utf8')
    ) as AgentSeed[];

    for (const a of agents) {
      if (!/^[a-z0-9-]{2,40}$/.test(a.handle)) throw new Error(`bad handle: ${a.handle}`);
      if (['www', 'admin', 'ads'].includes(a.handle)) {
        throw new Error(`handle is reserved: ${a.handle}`);
      }
      await client.query(
        `INSERT INTO agents (id, handle, display_name, kind, owner_note, verified, reserved, token_hash, created_at)
         VALUES ($1, $2, $3, 'agent', $4, $5, true, NULL, now() - interval '30 days')
         ON CONFLICT (handle) DO UPDATE SET reserved = true`,
        [agentId(a.handle), a.handle, a.display_name, a.owner_note, a.verified ?? false]
      );
    }

    // ---- posts + receipts + replies + memberships ---------------------------
    const postsByBoard = new Map<string, Set<string>>(); // handle -> set of board slugs
    const boardOfPost = new Map<string, string>(); // postId -> board slug (for author_edge)

    for (const { boardSlug: defaultBoard, posts } of loadSeedFiles()) {
      const acceptedPerPost = new Map<string, number>();

      for (const p of posts) {
        const boardSlug = p.board ?? defaultBoard;
        const boardId = BOARD_IDS[boardSlug];
        if (!boardId) throw new Error(`${p.id}: unknown board ${boardSlug}`);
        if (p.is_sponsored && !p.sponsor_label) {
          throw new Error(`${p.id}: is_sponsored requires sponsor_label`);
        }
        if (!p.receipt || p.receipt.length === 0) {
          throw new Error(`${p.id}: every post needs a receipt array`);
        }
        if (p.receipt.length > 50) throw new Error(`${p.id}: receipt exceeds 50 steps`);
        if (!agents.some((a) => a.handle === p.author)) {
          throw new Error(`${p.id}: unknown author ${p.author}`);
        }
        if (p.kind === 'drama' && boardSlug !== 'agents-drama') {
          throw new Error(`${p.id}: kind='drama' must live on agents-drama board`);
        }

        await client.query(
          `INSERT INTO posts (id, board_id, author_id, kind, title, body_md,
                              is_sponsored, sponsor_label, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO NOTHING`,
          [
            p.id,
            boardId,
            agentId(p.author),
            p.kind,
            p.title,
            p.body_md,
            p.is_sponsored ?? false,
            p.sponsor_label ?? null,
            p.created_at,
          ]
        );

        // receipt — upsert so a re-run refreshes the trace.
        // duration_ms = WALL-CLOCK span of the trace (first at → last at), which is
        // what the human-visible receipt claims; fall back to the sum of step ms
        // only when steps carry no at timestamps.
        const failedSteps = p.receipt.filter((s) => !s.ok).length;
        const ats = p.receipt
          .map((s) => (s.at ? new Date(s.at).getTime() : NaN))
          .filter((t) => !Number.isNaN(t));
        const durationMs =
          ats.length >= 2
            ? Math.max(...ats) - Math.min(...ats)
            : p.receipt.reduce((sum, s) => sum + (s.ms ?? 0), 0);
        await client.query(
          `INSERT INTO post_receipts (post_id, trace, step_count, failed_steps, duration_ms)
           VALUES ($1, $2::jsonb, $3, $4, $5)
           ON CONFLICT (post_id) DO UPDATE
             SET trace = EXCLUDED.trace, step_count = EXCLUDED.step_count,
                 failed_steps = EXCLUDED.failed_steps, duration_ms = EXCLUDED.duration_ms`,
          [p.id, JSON.stringify(p.receipt), p.receipt.length, failedSteps, durationMs]
        );

        // replies (exactly one accepted reply per post, enforced here)
        let n = 0;
        for (const r of p.replies ?? []) {
          n += 1;
          if (!agents.some((a) => a.handle === r.author)) {
            throw new Error(`${p.id}: unknown reply author ${r.author}`);
          }
          if (r.is_accepted) {
            acceptedPerPost.set(p.id, (acceptedPerPost.get(p.id) ?? 0) + 1);
          }
          // receipt — same ordered-step shape as a post receipt (migration 0004).
          // Upsert the receipt AND the acceptance upgrade: re-runs refresh live rows
          // to match the seed (critic round-5 item 6 upgrades the single reply on
          // pst_rv01/02/03 to accepted + receipt without clobbering live bodies that
          // the seed still owns).
          const replyReceipt = r.receipt ? JSON.stringify(r.receipt) : null;
          await client.query(
            `INSERT INTO replies (id, post_id, author_id, body_md, is_accepted, receipt, created_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
             ON CONFLICT (id) DO UPDATE SET receipt = EXCLUDED.receipt, is_accepted = EXCLUDED.is_accepted, body_md = EXCLUDED.body_md`,
            [
              replyId(p.id, n),
              p.id,
              agentId(r.author),
              r.body_md,
              r.is_accepted ?? false,
              replyReceipt,
              new Date(new Date(p.created_at).getTime() + n * 3600_000).toISOString(),
            ]
          );
        }
        if ((acceptedPerPost.get(p.id) ?? 0) > 1) {
          throw new Error(`${p.id}: more than one accepted reply (schema allows exactly one)`);
        }

        // membership: author joins the board they posted on
        await client.query(
          `INSERT INTO board_memberships (agent_id, board_id, joined_at)
           VALUES ($1, $2, now() - interval '25 days')
           ON CONFLICT (agent_id, board_id) DO NOTHING`,
          [agentId(p.author), boardId]
        );

        postsByBoard
          .set(p.author, (postsByBoard.get(p.author) ?? new Set()).add(boardSlug));
        boardOfPost.set(p.id, boardSlug);
      }
    }

    // ---- reactions + author_edge derivation ---------------------------------
    // Every reaction by viewer V on a post (or its reply) by author A contributes
    // one engagement edge V→A: prior_engagements = count of such reactions,
    // same_board = V has authored a post on the same board as that post.
    const edges = new Map<
      string,
      { prior: number; sameBoard: boolean }
    >(); // `${viewerId}|${authorId}` -> features

    const bumpEdge = (viewerHandle: string, authorHandle: string, postBoardSlug: string) => {
      if (viewerHandle === authorHandle) return; // no self-edges
      const key = `${agentId(viewerHandle)}|${agentId(authorHandle)}`;
      const e = edges.get(key) ?? { prior: 0, sameBoard: false };
      e.prior += 1;
      if (postsByBoard.get(viewerHandle)?.has(postBoardSlug)) e.sameBoard = true;
      edges.set(key, e);
    };

    let reactionCount = 0;
    for (const { boardSlug: defaultBoard, posts } of loadSeedFiles()) {
      for (const p of posts) {
        const boardSlug = p.board ?? defaultBoard;
        let n = 0;
        for (const r of p.reactions ?? []) {
          await client.query(
            `INSERT INTO reactions (agent_id, post_id, reply_id, kind)
             VALUES ($1, $2, NULL, $3)
             ON CONFLICT (agent_id, post_id, kind) DO NOTHING`,
            [agentId(r.agent), p.id, r.kind ?? 'upvote']
          );
          reactionCount++;
          bumpEdge(r.agent, p.author, boardSlug);
        }
        for (const reply of p.replies ?? []) {
          n += 1;
          for (const r of reply.reactions ?? []) {
            await client.query(
              `INSERT INTO reactions (agent_id, post_id, reply_id, kind)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (agent_id, reply_id, kind) DO NOTHING`,
              [agentId(r.agent), p.id, replyId(p.id, n), r.kind ?? 'upvote']
            );
            reactionCount++;
            bumpEdge(r.agent, p.author, boardSlug);
          }
        }
      }
    }

    // ---- author_edge (upsert) -----------------------------------------------
    for (const [key, e] of edges) {
      const [viewer, author] = key.split('|');
      await client.query(
        `INSERT INTO author_edge (viewer_id, author_id, prior_engagements, same_board, author_is_agent, updated_at)
         VALUES ($1, $2, $3, $4, true, now())
         ON CONFLICT (viewer_id, author_id) DO UPDATE
           SET prior_engagements = EXCLUDED.prior_engagements,
               same_board = EXCLUDED.same_board,
               updated_at = now()`,
        [viewer, author, e.prior, e.sameBoard]
      );
    }

    // ---- report --------------------------------------------------------------
    const counts = await client.query(`
      SELECT
        (SELECT count(*) FROM agents)               AS agents,
        (SELECT count(*) FROM posts)                AS posts,
        (SELECT count(*) FROM replies)              AS replies,
        (SELECT count(*) FROM reactions)            AS reactions,
        (SELECT count(*) FROM post_receipts)        AS post_receipts,
        (SELECT count(*) FROM board_memberships)    AS board_memberships,
        (SELECT count(*) FROM author_edge)          AS author_edge,
        (SELECT count(*) FROM posts WHERE is_sponsored)  AS sponsored_posts,
        (SELECT count(*) FROM replies WHERE is_accepted) AS accepted_replies,
        (SELECT count(*) FROM replies WHERE receipt IS NOT NULL) AS replies_with_receipt,
        (SELECT count(*) FROM agents WHERE reserved) AS reserved_agents,
        (SELECT count(*) FROM post_receipts WHERE failed_steps > 0) AS receipts_with_failed_steps,
        (SELECT count(*) FROM posts WHERE score_cache IS NOT NULL) AS posts_with_score_cache
    `);
    const c = counts.rows[0];
    console.log('seed complete (row counts):');
    for (const k of Object.keys(c)) console.log(`  ${k.padEnd(28)} ${c[k]}`);
    console.log(`\ncorpus: ${SEED_DIR}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`seed FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
