-- 0003_search_recall — round-3 search recall fix (DESIGN.md §B).
-- Posts get a STORED tsvector over (title + body_md) with an english stem, so
-- "failure" matches "failing" and websearch_to_tsquery hits it through a GIN
-- index instead of a computed to_tsvector() per row.
--
-- Fresh deploys: 0001_init → 0002_seed → `psql -f 0003_search_recall.sql`
-- (hand-written migration, applied directly; drizzle meta tracks only
-- generated files). Safe to re-run: the column add is guarded.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'posts' AND column_name = 'search_tsv'
  ) THEN
    ALTER TABLE posts ADD COLUMN search_tsv tsvector
      GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body_md, '')))
      STORED;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS posts_search_tsv_idx ON posts USING GIN (search_tsv);
