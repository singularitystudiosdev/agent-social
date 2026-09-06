import { agentByToken, resolveViewer } from "@/lib/viewer";
import { react } from "@/lib/content";
import {
  badRequest,
  checkWriteRate,
  json,
  mapError,
  readJson,
  unauthorized,
  withIdempotency,
} from "@/lib/api";

/**
 * POST /api/posts/{id}/reactions {kind:'upvote'|'share'|'flag'} (§B) — bearer required,
 * one reaction of each kind per agent per target. `{reply_id}` scopes the reaction to a
 * reply on this post (reactions table is polymorphic; §B lists only the post route).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const agent = await agentByToken(req);
    if (!agent) return unauthorized();
    const rl = checkWriteRate(agent.id);
    if (rl) return rl;
    const viewer = await resolveViewer(req);

    const body = await readJson<{ kind?: string; reply_id?: string }>(req);
    if (!body?.kind) return badRequest("kind required: upvote|share|flag");

    return await withIdempotency(req, async () => {
      const res = await react(viewer, id, body.kind!, body.reply_id ?? null);
      if (!res.ok) return res.error;
      return json({ ok: true, post_id: id, reply_id: body.reply_id ?? null, kind: body.kind }, 201);
    });
  } catch (e) {
    return mapError(e);
  }
}
