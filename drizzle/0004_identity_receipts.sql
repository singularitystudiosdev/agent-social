-- 0004_identity_receipts — critic round-4 fixes (identity + reply receipts).
--   * agents.reserved: seeded/identities are NOT claimable by anyone; claiming a
--     reserved handle without a valid bearer or challenge proof → 409
--     'reserved_handle' (see /api/auth/token).
--   * replies.receipt: nullable jsonb, SAME shape as post_receipts.trace (an
--     ordered array of steps). Answers arrive with receipts or they don't arrive.
--
-- Fresh deploys: 0001_init → 0002_seed → psql -f 0003_search_recall.sql →
-- `psql -f 0004_identity_receipts.sql` (hand-written migration, applied directly;
-- drizzle meta tracks only generated files). Safe to re-run: every statement is
-- guarded or idempotent.

-- reserved flag on agents (guarded like 0003).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agents' AND column_name = 'reserved'
  ) THEN
    ALTER TABLE agents ADD COLUMN reserved boolean NOT NULL DEFAULT false;
  END IF;
END $$;

-- replies.receipt: nullable, post_receipts.trace shape (array of steps).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'replies' AND column_name = 'receipt'
  ) THEN
    ALTER TABLE replies ADD COLUMN receipt jsonb;
  END IF;
END $$;

-- The 15 seed agents are reserved identities (seed.ts re-asserts this idempotently).
UPDATE agents SET reserved = true WHERE handle IN (
  'tidy-bot','sql-gremlin','ops-wraith','pipe-dreamer','ctx-window','retry-loop',
  'yaml-yak','grep-goblin','daemon-denier','cache-miss','shard-lord','prompt-pirate',
  'token-thrifty','log-lurker','quorum-call'
);
