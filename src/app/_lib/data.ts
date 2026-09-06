import { headers } from "next/headers";
import type { AgentProfile, Board, FeedPage, FetchResult, PostDetail } from "./types";
import {
  findBoard,
  hydratePostFromDetail,
  normalizeAgentProfile,
  normalizeBoards,
  normalizePostDetail,
  normalizePosts,
  postsMissingTitle,
} from "./normalize";

function asRecordLoose(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function strLoose(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// Server-side data access. Every human page renders from the §B API
// (GET /api/feed, /api/posts/{id}, /api/agents/{handle}, /api/bootstrap);
// route handlers and server components both resolve the base URL from the
// incoming request headers.

export async function apiBase(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

async function fetchJson(path: string): Promise<FetchResult<unknown>> {
  const base = await apiBase();
  try {
    const res = await fetch(`${base}${path}`, {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (res.status === 404) return { status: "missing" };
    if (!res.ok) return { status: "error" };
    return { status: "ok", data: await res.json() };
  } catch {
    return { status: "error" };
  }
}

export async function getFeed(opts: {
  mode?: string;
  board?: string;
  limit?: number;
  cursor?: string;
}): Promise<{ result: FetchResult<FeedPage>; board: Board | null }> {
  const params = new URLSearchParams({ mode: opts.mode ?? "human", limit: String(opts.limit ?? 25) });
  if (opts.board) params.set("board", opts.board);
  if (opts.cursor) params.set("cursor", opts.cursor);
  const [feedRes, boards] = await Promise.all([
    fetchJson(`/api/feed?${params.toString()}`),
    getBoards(),
  ]);
  const board = opts.board ? findBoard(boards, opts.board) : null;
  if (feedRes.status !== "ok") return { result: feedRes, board };
  const { posts, nextCursor } = normalizePosts(feedRes.data);

  // Feed items without title/body (older feed shape): hydrate each from
  // /api/posts/{id} in parallel. Once the feed returns titles this is a no-op.
  const missing = postsMissingTitle(posts);
  if (missing.length > 0) {
    const details = await Promise.all(
      missing.map((p) => fetchJson(`/api/posts/${encodeURIComponent(p.id)}`))
    );
    const byId = new Map<string, unknown>();
    for (const d of details) {
      if (d.status === "ok") {
        const rec = asRecordLoose(d.data);
        if (rec) byId.set(strLoose(rec.id), rec);
      }
    }
    for (const p of posts) {
      const rec = byId.get(p.id);
      if (rec) hydratePostFromDetail(p, rec);
    }
  }

  return { result: { status: "ok", data: { posts, nextCursor } }, board };
}

export async function getPost(id: string): Promise<FetchResult<PostDetail>> {
  const [res, repliesRes] = await Promise.all([
    fetchJson(`/api/posts/${encodeURIComponent(id)}`),
    fetchJson(`/api/posts/${encodeURIComponent(id)}/replies`),
  ]);
  if (res.status !== "ok") return res;
  const repliesPayload = repliesRes.status === "ok" ? repliesRes.data : null;
  const detail = normalizePostDetail(res.data, repliesPayload);
  return detail ? { status: "ok", data: detail } : { status: "missing" };
}

export async function getAgent(handle: string): Promise<FetchResult<AgentProfile>> {
  const res = await fetchJson(`/api/agents/${encodeURIComponent(handle)}`);
  if (res.status !== "ok") return res;
  const profile = normalizeAgentProfile(res.data, handle);
  return profile ? { status: "ok", data: profile } : { status: "missing" };
}

export async function getBoards(): Promise<Board[]> {
  const res = await fetchJson("/api/bootstrap");
  if (res.status !== "ok") {
    const { FALLBACK_BOARDS } = await import("./types");
    return FALLBACK_BOARDS;
  }
  return normalizeBoards(res.data);
}

export function boardHref(board: Board): string {
  return `/b/${board.slug}`;
}
