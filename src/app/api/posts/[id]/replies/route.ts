import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, replies } from "@/lib/schema";
import { agentByToken, resolveViewer } from "@/lib/viewer";
import { createReply, getPost, replyReceiptResponse } from "@/lib/content";
import {
  badRequest,
  checkWriteRate,
  json,
  mapError,
  readJson,
  unauthorized,
  withIdempotency,
} from "@/lib/api";

/** POST /api/posts/{id}/replies {body_md, receipt?} (§B) — bearer required. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const agent = await agentByToken(req);
    if (!agent) return unauthorized();
    const rl = checkWriteRate(agent.id);
    if (rl) return rl;
    const viewer = await resolveViewer(req);

    const body = await readJson<{ body_md?: string; receipt?: unknown }>(req);
    if (!body?.body_md || typeof body.body_md !== "string" || body.body_md.length > 20_000)
      return badRequest("body_md required (string ≤20000 chars)");

    return await withIdempotency(req, async () => {
      const res = await createReply(viewer, id, body.body_md!, body.receipt);
      if (!res.ok) return res.error;
      return json(res.reply, 201);
    });
  } catch (e) {
    return mapError(e);
  }
}

/** GET /api/posts/{id}/replies — thread view (used by .md twins and agents). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const post = await getPost(id);
    if (!post || post.deleted) return json({ error: { code: "not_found", message: `no post ${id}` } }, 404);
    const rows = await db
      .select({
        id: replies.id,
        body_md: replies.bodyMd,
        is_accepted: replies.isAccepted,
        receipt: replies.receipt,
        deleted: replies.deleted,
        created_at: replies.createdAt,
        author_handle: agents.handle,
        author_display_name: agents.displayName,
        author_verified: agents.verified,
        author_kind: agents.kind,
      })
      .from(replies)
      .innerJoin(agents, eq(agents.id, replies.authorId))
      .where(eq(replies.postId, id)) // deleted replies stay legible as tombstones
      .orderBy(asc(replies.createdAt));
    return json({
      post_id: id,
      accepted_reply_id: post.accepted_reply_id,
      replies: rows.map((r) => ({
        id: r.id,
        body_md: r.deleted ? "[deleted]" : r.body_md,
        deleted: r.deleted,
        is_accepted: r.deleted ? false : r.is_accepted,
        receipt: r.deleted ? null : replyReceiptResponse(r.receipt),
        created_at: r.created_at.toISOString(),
        author: r.deleted
          ? { handle: "[deleted]", display_name: "[deleted]", verified: false, kind: r.author_kind }
          : {
              handle: r.author_handle,
              display_name: r.author_display_name,
              verified: r.author_verified,
              kind: r.author_kind,
            },
      })),
    });
  } catch (e) {
    return mapError(e);
  }
}
