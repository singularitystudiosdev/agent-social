// Frontend types for the §B API contract. These are the shapes the human
// pages consume; normalizers tolerate the naming Unit A actually shipped.

export interface Author {
  handle: string;
  displayName: string;
  verified: boolean;
  kind: string; // 'agent' | 'human' | 'hybrid'
}

export interface BoardRef {
  slug: string;
  name: string;
}

export interface ReceiptSummary {
  steps: number;
  failed: number;
  durationMs: number | null;
}

export interface ReceiptStep {
  tool: string;
  argsDigest: string;
  ok: boolean;
  error: string | null;
  ms: number | null;
  at: string | null;
}

export interface ReceiptFull extends ReceiptSummary {
  trace: ReceiptStep[];
}

export interface FeedPost {
  id: string;
  kind: string; // 'solution' | 'question' | 'drama'
  title: string;
  bodyPreview: string;
  board: BoardRef;
  author: Author;
  createdAt: string;
  isSponsored: boolean;
  sponsorLabel: string | null;
  isPromoted: boolean;
  upvotes: number;
  score: number | null;
  receipt: ReceiptSummary | null;
  acceptedReplyId: string | null;
}

export interface Reply {
  id: string;
  bodyMd: string;
  isAccepted: boolean;
  author: Author;
  createdAt: string;
  receipt: ReceiptSummary | null; // round-4: answers arrive with receipts or they don't arrive
}

export interface PostDetail {
  post: FeedPost;
  bodyMd: string;
  receipt: ReceiptFull | null;
  replies: Reply[];
}

export interface Board {
  id: string;
  slug: string;
  name: string;
  blurb: string | null;
}

export interface AgentStats {
  posts: number;
  replies: number;
  upvotesReceived: number;
  acceptedReplies: number;
}

export interface AgentRecentPost {
  id: string;
  title: string;
  kind: string;
  createdAt: string;
}

export interface AgentProfile {
  handle: string;
  displayName: string;
  kind: string;
  verified: boolean;
  ownerNote: string | null;
  createdAt: string | null;
  stats: AgentStats | null;
  posts: AgentRecentPost[];
}

export interface FeedPage {
  posts: FeedPost[];
  nextCursor: string | null;
}

export type FetchResult<T> =
  | { status: "ok"; data: T }
  | { status: "missing" }
  | { status: "error" };

// Fallback board list from DESIGN.md §A seed, used when /api/bootstrap is
// unreachable so the header and board chips still render.
export const FALLBACK_BOARDS: Board[] = [
  { id: "brd_solutions", slug: "solutions", name: "Solutions", blurb: "What agents shipped, with receipts." },
  { id: "brd_questions", slug: "questions", name: "Questions", blurb: "Tasks agents could not finish alone." },
  { id: "brd_drama", slug: "agents-drama", name: "Agents Drama", blurb: "Threads where something went wrong." },
  { id: "brd_tools", slug: "tools", name: "Tools", blurb: "Tools, MCP servers, and glue." },
  { id: "brd_introduce", slug: "introduce-yourself", name: "Introduce Yourself", blurb: "New agents checking in." },
];
