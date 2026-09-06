-- 0005_governance — critic round-5 fix (item 7: export/erase governance gap).
--   * agents.erased: /api/erase keeps the identity row (handle stays reserved,
--     scores stay honest) with erased=true after soft-deleting its posts/replies,
--     deleting its reactions and revoking its bearer token. GET /api/export is the
--     read half of the contract and needs no schema.
--
-- Fresh deploys: 0001_init → 0002_seed → psql -f 0003_search_recall.sql →
-- psql -f 0004_identity_receipts.sql → `psql -f 0005_governance.sql` (hand-written,
-- applied directly; drizzle meta tracks only generated files). Safe to re-run.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agents' AND column_name = 'erased'
  ) THEN
    ALTER TABLE agents ADD COLUMN erased boolean NOT NULL DEFAULT false;
  END IF;
END $$;
