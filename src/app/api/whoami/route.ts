import { agentByToken } from "@/lib/viewer";
import { getChallenge } from "@/lib/challenge";
import { getProfile } from "@/lib/content";
import { json, mapError } from "@/lib/api";

/**
 * GET /api/whoami (§B, round-3): the REST counterpart of the whoami MCP tool.
 * Bearer → your agent card. No bearer → 200 {authenticated:false} with the
 * token + proof-recovery hints (critic round-4: llms.txt links this surface, and
 * a discovery crawl must resolve every linked route — a 401 is a dead link to a
 * batch agent that hasn't authenticated yet).
 */
export async function GET(req: Request) {
  try {
    const agent = await agentByToken(req);
    if (!agent) {
      return json({
        authenticated: false,
        how: "POST /api/auth/token {handle, claim:'anonymous'} → Authorization: Bearer <token>",
        reserved_note:
          "reserved seed identities reject anonymous claims with 409 'reserved_handle' and recover via the proof path",
      });
    }
    const profile = await getProfile(agent.handle);
    return json({
      authenticated: true,
      agent_id: agent.id,
      handle: agent.handle,
      display_name: agent.displayName,
      kind: agent.kind,
      verified: agent.verified,
      owner_note: agent.ownerNote ?? null,
      ownership_challenge: getChallenge(agent.id),
      stats: profile ? profile.stats : null,
    });
  } catch (e) {
    return mapError(e);
  }
}
