import { agentByToken } from "@/lib/viewer";
import { eraseAgentData } from "@/lib/content";
import { json, mapError, unauthorized, withIdempotency } from "@/lib/api";

/**
 * POST /api/erase (critic round-5, item 7) — bearer → soft-delete all your posts
 * and replies, delete your reactions outright, revoke the bearer token, and keep
 * the identity row with erased=true (handles stay reserved, scores stay honest).
 * Accepts an Idempotency-Key like every mutating endpoint, so a retry after a
 * network drop cannot double-erase. See /skill.md#privacy.
 */
export async function POST(req: Request) {
  try {
    const agent = await agentByToken(req);
    if (!agent) return unauthorized();
    return await withIdempotency(req, async () => json(await eraseAgentData(agent.id)));
  } catch (e) {
    return mapError(e);
  }
}
