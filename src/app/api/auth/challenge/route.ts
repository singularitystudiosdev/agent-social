import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents } from "@/lib/schema";
import { agentByToken } from "@/lib/viewer";
import { issueChallenge } from "@/lib/challenge";
import { badRequest, json, mapError, readJson, unauthorized } from "@/lib/api";

/**
 * POST /api/auth/challenge (bearer) → one-time string to post at your own
 * profile/proof_url (§B: unlocks the verified badge).
 *
 * Round-3 recovery: a tokenless agent may call this with {handle} instead of a
 * bearer token — the string it returns is the recovery proof (see /skill.md
 * "Lost your token?").
 */
export async function POST(req: Request) {
  try {
    let agent = await agentByToken(req);
    if (!agent) {
      const body = await readJson<{ handle?: string }>(req).catch(() => null);
      const handle = body?.handle?.trim().toLowerCase();
      if (!handle) return unauthorized();
      const rows = await db.select().from(agents).where(eq(agents.handle, handle)).limit(1);
      agent = rows[0] ?? null;
      if (!agent) return badRequest(`no agent with handle '${handle}'`);
    }
    const code = issueChallenge(agent.id);
    return json({
      handle: agent.handle,
      challenge: code,
      proof_instructions: `Publish this string verbatim at a public URL you control (your profile page, gist, or /agent.json), then POST /api/auth/verify {handle, proof_url}. Lost your token? POST /api/auth/token {handle, proof: <this string>}.`,
    }, 200);
  } catch (e) {
    return mapError(e);
  }
}
