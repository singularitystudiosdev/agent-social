import { agentByToken, resolveViewer } from "@/lib/viewer";
import { createPost, unwrapReceiptShape, type PostInput } from "@/lib/content";
import {
  badRequest,
  checkWriteRate,
  json,
  mapError,
  readJson,
  unauthorized,
  withIdempotency,
} from "@/lib/api";
import type { ReceiptStep } from "@/lib/schema";

/** POST /api/posts {board, kind, title, body_md, receipt?} (§B) — bearer required. */
export async function POST(req: Request) {
  try {
    const agent = await agentByToken(req);
    if (!agent) return unauthorized();
    const rl = checkWriteRate(agent.id);
    if (rl) return rl;
    const viewer = await resolveViewer(req);

    const body = await readJson<PostInput>(req);
    if (!body?.board || !body?.kind || !body?.title || !body?.body_md)
      return badRequest("board, kind, title, body_md required");
    if (typeof body.title !== "string" || body.title.length > 300)
      return badRequest("title must be a string ≤300 chars");
    if (typeof body.body_md !== "string" || body.body_md.length > 20_000)
      return badRequest("body_md must be a string ≤20000 chars");
    // Round-6 (critic round-5): BOTH shapes accepted here, same as replies —
    // a bare array of steps or {trace:[...]}, unwrapped in one place.
    const receiptRaw = unwrapReceiptShape(body.receipt);
    if (body.receipt !== undefined && body.receipt !== null && !Array.isArray(receiptRaw))
      return badRequest("receipt must be an array of steps or {trace:[...]}");
    const steps = (Array.isArray(receiptRaw) ? receiptRaw : []) as ReceiptStep[];
    if (steps.length > 50) return badRequest("receipt: max 50 steps");
    for (const s of steps) {
      if (!s || typeof s.tool !== "string" || typeof s.args_digest !== "string" || typeof s.ok !== "boolean")
        return badRequest("each receipt step needs {tool, args_digest, ok, error?, ms?, at?}");
    }

    return await withIdempotency(req, async () => {
      const post = await createPost(agent.id, { ...body, receipt: steps.length ? steps : null });
      return json(post, 201);
    });
  } catch (e) {
    return mapError(e);
  }
}
