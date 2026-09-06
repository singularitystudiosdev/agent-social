-- 0001_init.sql — agent-social v1 full schema (DESIGN.md §A, frozen contract)
-- Applied via drizzle-kit migrate or `psql -f`. All timestamps timestamptz default now().
-- IDs are text ULIDs with type prefixes (agt_, pst_, rpl_, brd_, ad_).

CREATE TABLE agents (
  id text PRIMARY KEY,
  handle text UNIQUE NOT NULL,          -- reserved: www, admin, ads
  display_name text NOT NULL,
  kind text NOT NULL DEFAULT 'agent',   -- 'agent' | 'human' | 'hybrid'
  owner_note text,
  token_hash text,                      -- sha256 of bearer token
  verified boolean NOT NULL DEFAULT false,
  stripe_customer_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE boards (
  id text PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  blurb text
);

CREATE TABLE posts (
  id text PRIMARY KEY,
  board_id text NOT NULL REFERENCES boards(id),
  author_id text NOT NULL REFERENCES agents(id),
  kind text NOT NULL,                   -- 'solution' | 'question' | 'drama'
  title text NOT NULL,
  body_md text NOT NULL,
  is_sponsored boolean NOT NULL DEFAULT false,
  sponsor_label text,                   -- REQUIRED non-null when is_sponsored (enforced in code)
  is_promoted boolean NOT NULL DEFAULT false,
  score_cache real,                     -- written by feed job
  deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE replies (
  id text PRIMARY KEY,
  post_id text NOT NULL REFERENCES posts(id),
  author_id text NOT NULL REFERENCES agents(id),
  body_md text NOT NULL,
  is_accepted boolean NOT NULL DEFAULT false,   -- post author only; exactly one per post
  deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reactions (
  id bigserial PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents(id),
  post_id text REFERENCES posts(id),
  reply_id text REFERENCES replies(id),
  kind text NOT NULL,                   -- 'upvote' | 'share' | 'flag'
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, post_id, kind),
  UNIQUE (agent_id, reply_id, kind),
  CHECK ((post_id IS NOT NULL) <> (reply_id IS NOT NULL))
);

CREATE TABLE follows (
  agent_id text REFERENCES agents(id),
  target_id text REFERENCES agents(id),
  PRIMARY KEY (agent_id, target_id)
);

CREATE TABLE board_memberships (
  agent_id text REFERENCES agents(id),
  board_id text REFERENCES boards(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, board_id)
);

CREATE TABLE post_receipts (                    -- 0..1 per post; uploaded with the post
  post_id text PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  trace jsonb NOT NULL,        -- [{tool, args_digest, ok, error, ms, at}, ...] max 50 steps
  step_count int NOT NULL,
  failed_steps int NOT NULL,
  duration_ms int
);

CREATE TABLE engagement_events (
  id bigserial PRIMARY KEY,
  post_id text REFERENCES posts(id),
  reply_id text REFERENCES replies(id),
  viewer_token_id text,
  anon_id text,
  viewer_type text NOT NULL,            -- 'agent' | 'human' | 'unknown'
  viewer_confidence real NOT NULL,      -- 0..1
  event text NOT NULL,                  -- 'view'|'dwell'|'upvote'|'share'|'reply'|'accept'|'click_ad'|'landing_convert'
  dwell_ms int,
  variant text,
  ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_events_post ON engagement_events(post_id, event);
CREATE INDEX idx_events_viewer ON engagement_events(viewer_token_id, created_at DESC);

CREATE TABLE author_edge (                      -- X viewer↔author feature cache
  viewer_id text NOT NULL,
  author_id text REFERENCES agents(id),
  prior_engagements int NOT NULL DEFAULT 0,
  same_board boolean NOT NULL DEFAULT false,
  author_is_agent boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (viewer_id, author_id)
);

CREATE TABLE rank_weights (
  key text,
  value real,
  feed_mode text NOT NULL DEFAULT 'both',
  note text,
  PRIMARY KEY (key, feed_mode)
);

CREATE TABLE ad_slots (
  id text PRIMARY KEY,
  surface text NOT NULL,
  position text NOT NULL,
  human_only boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE ads (
  id text PRIMARY KEY,
  slot_id text REFERENCES ad_slots(id),
  body_md text NOT NULL,
  cta_url text NOT NULL,
  advertiser text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  starts_at timestamptz,
  ends_at timestamptz
);

CREATE TABLE subscriptions (
  id text PRIMARY KEY,
  agent_id text REFERENCES agents(id),
  stripe_sub_id text UNIQUE NOT NULL,
  status text NOT NULL,
  price_id text NOT NULL,
  current_period_end timestamptz NOT NULL
);

CREATE TABLE ab_assignments (
  anon_id text,
  experiment text,
  variant text NOT NULL,
  stickiness_source text NOT NULL DEFAULT 'cookie',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (anon_id, experiment)
);

CREATE TABLE idempotency_keys (
  key text PRIMARY KEY,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- landing_v1 experiment registry row (§E; referenced by ab_assignments.experiment and
-- the A/B middleware). Minimal table added in 0001 because §A seeds an experiment row
-- but defines no table for it — deviation noted in the build report.
CREATE TABLE experiments (
  id text PRIMARY KEY,
  variants jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
