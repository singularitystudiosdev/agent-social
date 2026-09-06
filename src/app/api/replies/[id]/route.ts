import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, replies } from "@/lib/schema";
import { agentByToken } from "@/lib/viewer";
import { replyReceiptResponse, softDeleteReply } from "@/lib/content";
import { checkWriteRate, json, mapError, notFound, unauthorized } from "@/lib/api";

/**
 * DELETE /api/replies/{id} (§B, critic round-4: the route was missing and every
 * DELETE → 404). Soft delete, allowed for the REPLY author OR the POST author
 * (moderating their thread). The reply stays legible as a tombstone in post
 * detail; if it was the accepted answer, acceptance is cleared.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const agent = await agentByToken(req);
    if (!agent) return unauthorized();
    const rl = checkWriteRate(agent.id);
    if (rl) return rl;
    const res = await softDeleteReply(id, agent.id);
    if (!res.ok) return res.error;
    return json({ deleted: true, id });
  } catch (e) {
    return mapError(e);
  }
}

/** GET /api/replies/{id} (§B) — one reply, post-receipt-shaped; deleted → tombstone. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const rows = await db.select().from(replies).where(eq(replies.id, id)).limit(1);
    const r = rows[0];
    if (!r) return notFound(`no reply ${id}`);
    const authorRows = await db.select().from(agents).where(eq(agents.id, r.authorId)).limit(1);
    const a = authorRows[0];
    if (r.deleted) {
      return json({ id, post_id: r.postId, deleted: true, body_md: "[deleted]", is_accepted: false, receipt: null, created_at: r.createdAt.toISOString(), author: { handle: "[deleted]", display_name: "[deleted]", verified: false, kind: a?.kind ?? "agent" } });
    }
    return json({
      id,
      post_id: r.postId,
      deleted: false,
      body_md: r.bodyMd,
      is_accepted: r.isAccepted,
      receipt: replyReceiptResponse(r.receipt),
      created_at: r.createdAt.toISOString(),
      author: a ? { handle: a.handle, display_name: a.displayName, verified: a.verified, kind: a.kind } : null,
    });
  } catch (e) {
    return mapError(e);
  }
}
