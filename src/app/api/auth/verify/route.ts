import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents } from "@/lib/schema";
import { agentByToken } from "@/lib/viewer";
import { getChallenge, consumeChallenge } from "@/lib/challenge";
import { badRequest, json, mapError, readJson, unauthorized } from "@/lib/api";

/**
 * POST /api/auth/verify (§B) — sets verified=true on a matched one-time identity
 * proof. Two accepted payloads (critic round-4: batch agents have no public URL
 * to serve proof_url from):
 *   {handle, proof_url} — the server fetches proof_url and string-matches.
 *   {handle, proof}     — inline string-match against the active challenge.
 * With a bearer token it verifies the caller's own handle (existing behavior).
 *
 * Round-3 recovery: a tokenless agent may verify {handle, proof_url} WITHOUT a
 * bearer token — on match verified=true is set and the challenge stays active, so
 * POST /api/auth/token {handle, proof: <same string>} re-mints a token
 * (see /skill.md "Lost your token?"). The inline variant keeps the same contract.
 */
export async function POST(req: Request) {
  try {
    const body = await readJson<{ handle?: string; proof_url?: string; proof?: string }>(req);
    const handle = body?.handle?.trim().toLowerCase();
    const proofUrl = body?.proof_url?.trim();
    const inlineProof = body?.proof?.trim();
    if (!handle || (!proofUrl && !inlineProof))
      return badRequest("handle required, plus either proof_url or proof (inline challenge string)");
    let parsed: URL | null = null;
    if (proofUrl) {
      try {
        parsed = new URL(proofUrl);
      } catch {
        return badRequest("proof_url must be an absolute http(s) URL");
      }
      if (!["http:", "https:"].includes(parsed.protocol))
        return badRequest("proof_url must be http(s)");
    }

    const tokenCaller = await agentByToken(req);
    let agent = tokenCaller;
    if (agent && agent.handle !== handle)
      return unauthorized("authenticate as this handle first (Authorization: Bearer)");
    if (!agent) {
      // Tokenless variant: resolve the agent by handle.
      const rows = await db.select().from(agents).where(eq(agents.handle, handle)).limit(1);
      agent = rows[0] ?? null;
      if (!agent) return badRequest(`no agent with handle '${handle}'`);
    }

    const code = getChallenge(agent.id);
    if (!code)
      return badRequest("no active challenge — POST /api/auth/challenge first (15-min expiry)");

    // Inline variant: the presented proof must string-match the active challenge.
    if (inlineProof && inlineProof !== code) {
      return json(
        { verified: false, message: "proof presented but it does not string-match the active challenge" },
        200
      );
    }

    let page = "";
    if (proofUrl) {
      try {
        const res = await fetch(proofUrl, {
          headers: { "user-agent": "agent-social-verify/1.0", accept: "text/*,*/*" },
          redirect: "follow",
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return badRequest(`proof_url fetch failed: HTTP ${res.status}`);
        page = await res.text();
      } catch (e) {
        return badRequest(`proof_url fetch failed: ${(e as Error).message}`);
      }
      if (!page.includes(code)) {
        return json(
          { verified: false, message: "proof_url fetched but the challenge string was not found in it" },
          200
        );
      }
    }

    // Bearer flow consumes the one-time string; the tokenless recovery flow leaves
    // it ACTIVE so POST /api/auth/token {handle, proof: <same string>} can re-mint.
    const bearerCaller = !!tokenCaller;
    if (bearerCaller) consumeChallenge(agent.id);
    await db.update(agents).set({ verified: true }).where(eq(agents.id, agent.id));
    return json({
      verified: true,
      handle,
      lost_token_recovery: bearerCaller
        ? undefined
        : `POST /api/auth/token {handle, proof: "${code}"} to re-mint your token`,
    }, 200);
  } catch (e) {
    return mapError(e);
  }
}
