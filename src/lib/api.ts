/**
 * Route plumbing shared by every /api route (DESIGN.md §B): JSON errors
 * `{error:{code,message}}`, in-memory idempotency via the idempotency_keys table,
 * and the 60 writes/min/agent in-memory rate limit.
 */
import { eq } from "drizzle-orm";
import { db } from "./db";
import { idempotencyKeys } from "./schema";

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "internal";

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function fail(code: ApiErrorCode, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

/**
 * Derive the ABSOLUTE origin a request was actually made through (§B bootstrap):
 * forwarded headers first (behind cloudflared / Vercel / any proxy the deployment
 * sees), then the Host header, and only then the raw req URL. Without this,
 * bootstrap advertises localhost origins on the live deployment.
 */
export function requestOrigin(req: Request): string {
  const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "")
    .split(",")[0]
    .trim();
  if (host) {
    const proto = (req.headers.get("x-forwarded-proto") ?? "").split(",")[0].trim();
    const local = host.startsWith("localhost") || host.startsWith("127.0.0.1");
    return `${proto || (local ? "http" : "https")}://${host}`;
  }
  return new URL(req.url).origin;
}

export const badRequest = (m: string) => fail("bad_request", m, 400);
export const unauthorized = (m = "Provide Authorization: Bearer <token> (POST /api/auth/token)") =>
  fail("unauthorized", m, 401);
export const notFound = (m: string) => fail("not_found", m, 404);
export const conflict = (m: string, hint?: Record<string, unknown>, extra?: Record<string, unknown>) =>
  Response.json(
    { error: { code: "conflict", message: m }, ...(hint ? { recovery: hint } : {}), ...(extra ?? {}) },
    { status: 409 }
  );
/**
 * 429 with machine-readable timing (critic round-5: "a strict client can only
 * guess"): every 429 carries a `Retry-After: <seconds>` header AND a `retry_after`
 * body field with the same integer, so both header-respecting and body-parsing
 * clients back off exactly one window instead of guessing.
 */
export const rateLimited = (m = "rate limit: 60 writes/min", retryAfterSeconds?: number) =>
  Response.json(
    {
      error: { code: "rate_limited" as ApiErrorCode, message: m },
      ...(retryAfterSeconds != null ? { retry_after: retryAfterSeconds } : {}),
    },
    {
      status: 429,
      headers: retryAfterSeconds != null ? { "Retry-After": String(retryAfterSeconds) } : undefined,
    }
  );

// ---- idempotency (mutating endpoints accept `Idempotency-Key`) ----

/**
 * If the request carries an Idempotency-Key we've already answered, replay the stored
 * response. Otherwise run `fn`, store its JSON on success (2xx), and return it.
 */
export async function withIdempotency(
  req: Request,
  fn: () => Promise<Response>
): Promise<Response> {
  const key = req.headers.get("idempotency-key");
  if (!key) return fn();
  const existing = await db
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, key))
    .limit(1);
  if (existing[0]?.response) {
    const stored = existing[0].response as { status?: number; body?: unknown };
    return Response.json(stored.body ?? stored, {
      status: stored.status ?? 200,
      headers: { "Idempotency-Replayed": "true" },
    });
  }
  const res = await fn();
  if (res.ok) {
    const body = await res.clone().json().catch(() => null);
    await db
      .insert(idempotencyKeys)
      .values({ key, response: { status: res.status, body } })
      .onConflictDoNothing();
  }
  return res;
}

// ---- rate limit: 60 writes/min/agent, in-memory (§B) ----

const WRITE_LIMIT = 60;
const WINDOW_MS = 60_000;
const globalForLimiter = globalThis as unknown as {
  __writeHits?: Map<string, number[]>;
};
const hits = (globalForLimiter.__writeHits ??= new Map<string, number[]>());

/** Returns null when allowed, or a 429 Response (with Retry-After / retry_after)
 * when the agent is over 60 writes/min. */
export function checkWriteRate(agentId: string): Response | null {
  const now = Date.now();
  const arr = (hits.get(agentId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= WRITE_LIMIT) {
    hits.set(agentId, arr);
    // The oldest hit inside the window leaves first — that's when one write slot
    // opens, so that's the honest backoff.
    const oldest = arr.length ? Math.min(...arr) : now;
    const retryAfter = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
    return rateLimited(undefined, retryAfter);
  }
  arr.push(now);
  hits.set(agentId, arr);
  return null;
}

/** Anonymous write callers get limiter keyed by IP to keep the endpoint honest. */
export function checkWriteRateKeyed(key: string): Response | null {
  return checkWriteRate(key);
}

export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/** Thrown-by-lib errors ({status, code}) → the §B `{error:{code,message}}` envelope. */
export function mapError(e: unknown): Response {
  const err = e as { status?: number; code?: ApiErrorCode; message?: string };
  if (err?.status && err?.code) return fail(err.code, err.message ?? "error", err.status);
  console.error(e);
  return fail("internal", "internal error", 500);
}

