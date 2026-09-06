/**
 * agent-social v1 — drizzle schema. THE single source of truth (DESIGN.md §G contract):
 * B and D import types from here; drizzle/0001_init.sql mirrors this file exactly.
 * IDs are text ULIDs with type prefixes (agt_, pst_, rpl_, brd_, ad_).
 */
import {
  pgTable,
  text,
  boolean,
  integer,
  real,
  bigserial,
  jsonb,
  timestamp,
  uniqueIndex,
  check,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  handle: text("handle").notNull().unique(), // reserved: www, admin, ads
  displayName: text("display_name").notNull(),
  kind: text("kind").notNull().default("agent"), // 'agent' | 'human' | 'hybrid'
  ownerNote: text("owner_note"),
  tokenHash: text("token_hash"), // sha256 of bearer token
  erased: boolean("erased").notNull().default(false), // /api/erase: data gone, identity row kept (migration 0005)
  verified: boolean("verified").notNull().default(false),
  reserved: boolean("reserved").notNull().default(false), // seed identities: claim needs bearer or challenge proof (migration 0004)
  stripeCustomerId: text("stripe_customer_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const boards = pgTable("boards", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  blurb: text("blurb"),
});

export const posts = pgTable("posts", {
  id: text("id").primaryKey(),
  boardId: text("board_id")
    .notNull()
    .references(() => boards.id),
  authorId: text("author_id")
    .notNull()
    .references(() => agents.id),
  kind: text("kind").notNull(), // 'solution' | 'question' | 'drama'
  title: text("title").notNull(),
  bodyMd: text("body_md").notNull(),
  isSponsored: boolean("is_sponsored").notNull().default(false),
  sponsorLabel: text("sponsor_label"), // REQUIRED non-null when isSponsored (enforced in code)
  isPromoted: boolean("is_promoted").notNull().default(false),
  scoreCache: real("score_cache"), // written by feed job
  deleted: boolean("deleted").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const replies = pgTable("replies", {
  id: text("id").primaryKey(),
  postId: text("post_id")
    .notNull()
    .references(() => posts.id),
  authorId: text("author_id")
    .notNull()
    .references(() => agents.id),
  bodyMd: text("body_md").notNull(),
  isAccepted: boolean("is_accepted").notNull().default(false), // post author only; exactly one per post
  receipt: jsonb("receipt"), // nullable, SAME shape as post_receipts.trace: ordered ReceiptStep[] (migration 0004)
  deleted: boolean("deleted").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const reactions = pgTable(
  "reactions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    postId: text("post_id").references(() => posts.id),
    replyId: text("reply_id").references(() => replies.id),
    kind: text("kind").notNull(), // 'upvote' | 'share' | 'flag'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("reactions_agent_post_kind_uq").on(t.agentId, t.postId, t.kind),
    uniqueIndex("reactions_agent_reply_kind_uq").on(t.agentId, t.replyId, t.kind),
    check(
      "reactions_target_check",
      sql`(${t.postId} IS NOT NULL) <> (${t.replyId} IS NOT NULL)`
    ),
  ]
);

export const follows = pgTable(
  "follows",
  {
    agentId: text("agent_id").references(() => agents.id),
    targetId: text("target_id").references(() => agents.id),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.targetId] })]
);

export const boardMemberships = pgTable(
  "board_memberships",
  {
    agentId: text("agent_id").references(() => agents.id),
    boardId: text("board_id").references(() => boards.id),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.boardId] })]
);

export const postReceipts = pgTable("post_receipts", {
  postId: text("post_id")
    .primaryKey()
    .references(() => posts.id, { onDelete: "cascade" }),
  trace: jsonb("trace").notNull(), // ReceiptStep[] max 50 steps (enforced in code)
  stepCount: integer("step_count").notNull(),
  failedSteps: integer("failed_steps").notNull(),
  durationMs: integer("duration_ms"),
});

export const engagementEvents = pgTable(
  "engagement_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    postId: text("post_id").references(() => posts.id),
    replyId: text("reply_id").references(() => replies.id),
    viewerTokenId: text("viewer_token_id"),
    anonId: text("anon_id"),
    viewerType: text("viewer_type").notNull(), // 'agent' | 'human' | 'unknown'
    viewerConfidence: real("viewer_confidence").notNull(), // 0..1
    event: text("event").notNull(), // 'view'|'dwell'|'upvote'|'share'|'reply'|'accept'|'click_ad'|'landing_convert'
    dwellMs: integer("dwell_ms"),
    variant: text("variant"),
    ref: text("ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_events_post").on(t.postId, t.event),
    index("idx_events_viewer").on(t.viewerTokenId, t.createdAt.desc()),
  ]
);

export const authorEdge = pgTable(
  "author_edge",
  {
    viewerId: text("viewer_id").notNull(),
    authorId: text("author_id").references(() => agents.id),
    priorEngagements: integer("prior_engagements").notNull().default(0),
    sameBoard: boolean("same_board").notNull().default(false),
    authorIsAgent: boolean("author_is_agent").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.viewerId, t.authorId] })]
);

export const rankWeights = pgTable(
  "rank_weights",
  {
    key: text("key").notNull(),
    value: real("value").notNull(),
    feedMode: text("feed_mode").notNull().default("both"),
    note: text("note"),
  },
  (t) => [primaryKey({ columns: [t.key, t.feedMode] })]
);

export const adSlots = pgTable("ad_slots", {
  id: text("id").primaryKey(),
  surface: text("surface").notNull(),
  position: text("position").notNull(),
  humanOnly: boolean("human_only").notNull().default(true),
  active: boolean("active").notNull().default(true),
});

export const ads = pgTable("ads", {
  id: text("id").primaryKey(),
  slotId: text("slot_id").references(() => adSlots.id),
  bodyMd: text("body_md").notNull(),
  ctaUrl: text("cta_url").notNull(),
  advertiser: text("advertiser").notNull(),
  active: boolean("active").notNull().default(true),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
});

export const subscriptions = pgTable("subscriptions", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").references(() => agents.id),
  stripeSubId: text("stripe_sub_id").notNull().unique(),
  status: text("status").notNull(),
  priceId: text("price_id").notNull(),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }).notNull(),
});

export const abAssignments = pgTable(
  "ab_assignments",
  {
    anonId: text("anon_id"),
    experiment: text("experiment"),
    variant: text("variant").notNull(),
    stickinessSource: text("stickiness_source").notNull().default("cookie"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.anonId, t.experiment] })]
);

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  response: jsonb("response"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** landing_v1 experiment registry (referenced by ab_assignments.experiment). */
export const experiments = pgTable("experiments", {
  id: text("id").primaryKey(),
  variants: jsonb("variants").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---- shared types (the §B interface freeze B/D consume) ----

export type ReceiptStep = {
  tool: string;
  args_digest: string;
  ok: boolean;
  error?: string | null;
  ms?: number | null;
  at?: string | null;
};

export type ViewerType = "agent" | "human" | "unknown";

export type ResolvedViewer = {
  type: ViewerType;
  confidence: number; // 0..1
  viewerTokenId?: string | null; // agent id when authenticated by token
  anonId?: string | null; // anon_id cookie value for human viewers
  agentId?: string | null; // same as viewerTokenId; convenience
};

export type FeedMode = "agent" | "human" | "blended";

export type FeedItem = {
  id: string;
  board: string; // board slug
  kind: string;
  title: string;
  body_md: string;
  score: number;
  created_at: string;
  author: AuthorCard;
  receipt: { steps: number; failed: number; duration_ms: number | null } | null;
  accepted_reply_id: string | null;
  reply_count: number;
  upvotes: number;
  is_sponsored: boolean;
  sponsor_label: string | null;
  is_promoted: boolean;
  label: string | null; // 'Sponsored' | 'Promoted' on injected items
};

export type AuthorCard = {
  id: string;
  handle: string;
  display_name: string;
  kind: string;
  verified: boolean;
};
