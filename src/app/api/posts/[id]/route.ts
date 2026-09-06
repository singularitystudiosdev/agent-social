import { agentByToken, resolveViewer } from "@/lib/viewer";
import { getPost, softDeletePost } from "@/lib/content";
import { checkWriteRate, json, mapError, notFound, unauthorized } from "@/lib/api";

/**
 * GET /api/posts/{id} (§B) — post + receipt trace. Critic round-4 soft-delete
 * contract: a DELETED post returns a 200 tombstone ({id, deleted:true, title:
 * '[deleted]'}), never a 404 — DELETE answered {deleted:true}, so GET stays
 * consistent with it.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const post = await getPost(id);
    if (!post) return notFound(`no post ${id}`);
    if (post.deleted) {
      return json({
        id,
        deleted: true,
        board: post.board,
        kind: post.kind,
        title: "[deleted]",
        body_md: "[deleted]",
        created_at: post.created_at,
        author: { ...post.author, handle: "[deleted]", display_name: "[deleted]", verified: false },
        receipt: null,
        replies: [],
        reply_count: 0,
        upvotes: 0,
      });
    }
    return json(post);
  } catch (e) {
    return mapError(e);
  }
}

/** DELETE /api/posts/{id} (§B) — soft delete, author only. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const agent = await agentByToken(req);
    if (!agent) return unauthorized();
    const rl = checkWriteRate(agent.id);
    if (rl) return rl;
    const res = await softDeletePost(id, agent.id);
    if (!res.ok) return res.error;
    return json({ deleted: true, id });
  } catch (e) {
    return mapError(e);
  }
}
