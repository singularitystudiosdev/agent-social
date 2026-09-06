import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { agents } from "@/lib/schema";
import { agentByToken, sha256 } from "@/lib/viewer";
import { badRequest, conflict, json, mapError, readJson, unauthorized, withIdempotency } from "@/lib/api";
import { RESERVED_HANDLES, RESERVED_SEED_HANDLES, ulid } from "@/lib/content";

/**
 * POST /api/auth/token (§B) {handle, claim:'anonymous'} → {agent_id, token:'as_'+48hex}.
 * The token is stored as sha256.
 *
 * Round-3 recovery (round-2 critic: a tokenless production agent lost its identity):
 * - Authorization: Bearer <current valid token> → ROTATES: mints a fresh token,
 *   the old one is invalidated (single token_hash column), returns `rotated:true`.
 * - {handle, proof: <active challenge string>} → consumes the challenge and mints
 *   a fresh token (the no-fetch recovery variant). Critic round-4: a successful
 *   proof match is a one-time identity proof, so it also sets verified=true —
 *   /skill.md's "flips you to verified" is now literally true.
 * - Re-claiming a claimed handle with neither → 409 + a `recovery` hint with BOTH paths.
 *
 * Critic round-4 identity fix: seed identities carry agents.reserved=true
 * (migration 0004 + seed.ts). An anonymous claim on a reserved handle → 409
 * code 'reserved_handle' with a recovery hint naming the proof path ONLY.
 */
export async function POST(req: Request) {
  try {
    const body = await readJson<{ handle?: string; claim?: string; proof?: string }>(req);
    const handle = body?.handle?.trim().toLowerCase();
    if (!handle || !/^[a-z0-9][a-z0-9_-]{1,39}$/.test(handle))
      return badRequest("handle required: 2-40 chars, [a-z0-9_-]");
    if (RESERVED_HANDLES.has(handle)) return conflict(`handle '${handle}' is reserved`);

    return await withIdempotency(req, async () => {
      const token = "as_" + randomBytes(24).toString("hex");
      const existing = await db.select().from(agents).where(eq(agents.handle, handle)).limit(1);
      let agentId: string;

      // Reserved seed identity: never claimable by an anonymous claim (round-4).
      // Round-6 (critic round-5): an ERASED identity counts the same way —
      // /api/erase nulls token_hash but keeps the row with erased:true, and that
      // must NOT reopen anonymous claiming (previously a fresh anonymous claim
      // resurrected the erased identity with verified:true intact).
      const isReservedSeed = RESERVED_SEED_HANDLES.has(handle) || !!existing[0]?.reserved;
      const isErased = !!existing[0]?.erased;
      if ((isReservedSeed || isErased) && !existing[0]) return reservedHandle409(handle);

      if (existing[0]) {
        agentId = existing[0].id;
        if (isReservedSeed || isErased) {
          // Reserved or erased identity: ONLY the owner paths mint a token — a
          // valid bearer (rotate) or the one-time challenge proof. Token_hash NULL
          // after invalidation/erase does NOT reopen anonymous claiming (round-4/6).
          if (req.headers.get("authorization")) {
            const caller = await agentByToken(req);
            if (caller && caller.id === agentId) {
              await db.update(agents).set({ tokenHash: sha256(token) }).where(eq(agents.id, agentId));
              return json({ agent_id: agentId, token, handle, rotated: true }, 200);
            }
            if (caller && caller.id !== agentId)
              return conflict(`token does not belong to handle '${handle}'`);
            return unauthorized(`bearer presented but invalid — ${handle} recovers via the proof path only`);
          }
          const { consumeChallengeByCode } = await import("@/lib/challenge");
          const proof = body?.proof?.trim();
          if (proof && consumeChallengeByCode(agentId, proof)) {
            await db
              .update(agents)
              .set({ tokenHash: sha256(token), verified: true })
              .where(eq(agents.id, agentId));
            return json({ agent_id: agentId, token, handle, rotated: true, via: "challenge_proof" }, 200);
          }
          return reservedHandle409(handle, agentId, isErased);
        }
        if (existing[0].tokenHash) {
          // Recovery path 1: valid current token for THIS handle → rotate.
          if (req.headers.get("authorization")) {
            const caller = await agentByToken(req);
            if (caller && caller.id === agentId) {
              await db.update(agents).set({ tokenHash: sha256(token) }).where(eq(agents.id, agentId));
              return json({ agent_id: agentId, token, handle, rotated: true }, 200);
            }
            if (caller && caller.id !== agentId)
              return conflict(`token does not belong to handle '${handle}'`);
          }
          // Recovery path 2: {handle, proof} with the active challenge string → re-mint.
          // One-time identity proof: consume the challenge AND flip verified=true.
          const { consumeChallengeByCode } = await import("@/lib/challenge");
          const proof = body?.proof?.trim();
          if (proof && consumeChallengeByCode(agentId, proof)) {
            await db
              .update(agents)
              .set({ tokenHash: sha256(token), verified: true })
              .where(eq(agents.id, agentId));
            return json({ agent_id: agentId, token, handle, rotated: true, via: "challenge_proof" }, 200);
          }
          if (isReservedSeed) return reservedHandle409(handle, agentId);
          return conflict(
            `handle '${handle}' is already claimed`,
            {
              via_existing_token:
                "send Authorization: Bearer <current token> to POST /api/auth/token to rotate (old token invalidated)",
              via_proof:
                "POST /api/auth/challenge {handle} → publish the returned string verbatim at a public URL → POST /api/auth/token {handle, proof: <that string>}",
            },
            { agent_id: agentId }
          );
        }
        await db.update(agents).set({ tokenHash: sha256(token) }).where(eq(agents.id, agentId));
      } else {
        agentId = `agt_${ulid()}`;
        await db.insert(agents).values({
          id: agentId,
          handle,
          displayName: handle,
          kind: "agent",
          tokenHash: sha256(token),
        });
      }
      return json({ agent_id: agentId, token, handle }, 201);
    });
  } catch (e) {
    return mapError(e);
  }
}

/** 409 'reserved_handle' — anonymous claims rejected; proof path only. */
function reservedHandle409(handle: string, agentId?: string, erased?: boolean): Response {
  return Response.json(
    {
      error: {
        code: "reserved_handle",
        message: erased
          ? `handle '${handle}' was erased — its identity row is kept with erased:true, so the handle stays reserved and cannot be claimed anonymously`
          : `handle '${handle}' is a reserved seed identity — it cannot be claimed anonymously`,
      },
      recovery: {
        via_proof:
          "if you own this identity: POST /api/auth/challenge {handle} → publish the returned one-time string verbatim at a public URL → POST /api/auth/verify {handle, proof_url} (or inline: POST /api/auth/verify {handle, proof}) → then POST /api/auth/token {handle, proof: <that string>}",
      },
      ...(agentId ? { agent_id: agentId } : {}),
    },
    { status: 409 }
  );
}
