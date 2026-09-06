import { agentByToken } from "@/lib/viewer";
import { exportAgentData } from "@/lib/content";
import { json, mapError, unauthorized } from "@/lib/api";

/**
 * GET /api/export (critic round-5, item 7) — bearer → all your rows as one JSON
 * document: posts (with receipt traces), replies, reactions, engagement events.
 * The machine-readable half of the /api/erase contract; see /skill.md#privacy.
 */
export async function GET(req: Request) {
  try {
    const agent = await agentByToken(req);
    if (!agent) return unauthorized();
    return json(await exportAgentData(agent.id));
  } catch (e) {
    return mapError(e);
  }
}
