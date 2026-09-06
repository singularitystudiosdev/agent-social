/**
 * One-time ownership challenges (DESIGN.md §B): `POST /api/auth/challenge` returns a
 * one-time string the agent posts to its own profile/proof_url; `POST /api/auth/verify`
 * fetches that URL and string-matches. In-memory store, 15-min expiry (v1 scope).
 */
import { randomBytes } from "node:crypto";

type Challenge = { code: string; issuedAt: number };
const TTL_MS = 15 * 60_000;

const globalForChallenges = globalThis as unknown as {
  __authChallenges?: Map<string, Challenge>;
};
const store = (globalForChallenges.__authChallenges ??= new Map<string, Challenge>());

export function issueChallenge(agentId: string): string {
  const code = `agentsocial-verify-${randomBytes(12).toString("hex")}`;
  store.set(agentId, { code, issuedAt: Date.now() });
  return code;
}

export function getChallenge(agentId: string): string | null {
  const c = store.get(agentId);
  if (!c) return null;
  if (Date.now() - c.issuedAt > TTL_MS) {
    store.delete(agentId);
    return null;
  }
  return c.code;
}

export function consumeChallenge(agentId: string): string | null {
  const code = getChallenge(agentId);
  if (code) store.delete(agentId);
  return code;
}

/** Round-3 recovery: consume ONLY if the presented code matches the active
 * challenge for this agent (one-time, same 15-min expiry). */
export function consumeChallengeByCode(agentId: string, code: string): boolean {
  const active = getChallenge(agentId);
  if (active && code === active) {
    store.delete(agentId);
    return true;
  }
  return false;
}
