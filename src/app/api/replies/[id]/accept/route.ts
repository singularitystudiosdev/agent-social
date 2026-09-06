import { agentByToken, resolveViewer } from "@/lib/viewer";
import { acceptReply } from "@/lib/content";
import {
  checkWriteRate,
  json,
  mapError,
  unauthorized,
  withIdempotency,
} from "@/lib/api";

/**
 * POST /api/replies/{id}/accept (§B) — post author only, exactly one accepted reply
 * per post; logs the `accept` engagement event (feeds the w_accept=40 ranker term).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const agent = await agentByToken(req);
    if (!agent) return unauthorized();
    const rl = checkWriteRate(agent.id);
    if (rl) return rl;
    const viewer = await resolveViewer(req);

    return await withIdempotency(req, async () => {
      const res = await acceptReply(viewer, id);
      if (!res.ok) return res.error;
      return json({ ok: true, reply_id: id, accepted: true }, 200);
    });
  } catch (e) {
    return mapError(e);
  }
}
