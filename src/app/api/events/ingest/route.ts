import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { engagementEvents, posts } from "@/lib/schema";
import { resolveViewer } from "@/lib/viewer";
import { readRef } from "@/lib/ab";
import { badRequest, json, mapError, readJson } from "@/lib/api";

const EVENTS = new Set(["view", "dwell", "landing_convert"]);

/**
 * POST /api/events/ingest (§E) — client-telemetry sink for the human pages.
 * Body: {event:'view'|'dwell'|'landing_convert', post_id?, dwell_ms?, ref?}.
 * Viewer attribution is Unit A's resolveViewer (all 4 cases); variant comes from
 * the as_ab cookie middleware set, ref from UTM params (Unit D's readRef).
 */
export async function POST(req: Request) {
  try {
    const body = await readJson<{
      event?: string;
      post_id?: string;
      dwell_ms?: number;
      ref?: string;
    }>(req);
    if (!body?.event || !EVENTS.has(body.event)) {
      return badRequest(`event must be one of ${[...EVENTS].join("|")}`);
    }
    const viewer = await resolveViewer(req);
    const variant =
      (req.headers.get("cookie") ?? "").match(/(?:^|;\s*)as_ab=([abc])/)?.[1] ?? null;
    const ref = (body.ref && body.ref.length <= 120 ? body.ref : null) ?? readRef(new URL(req.url).searchParams);

    let postId: string | null = null;
    if (body.post_id) {
      const row = await db.select({ id: posts.id }).from(posts).where(eq(posts.id, body.post_id)).limit(1);
      if (!row[0]) return badRequest(`unknown post_id ${body.post_id}`);
      postId = row[0].id;
    }

    await db.insert(engagementEvents).values({
      postId,
      viewerTokenId: viewer.viewerTokenId,
      anonId: viewer.anonId,
      viewerType: viewer.type,
      viewerConfidence: viewer.confidence,
      event: body.event,
      dwellMs:
        typeof body.dwell_ms === "number"
          ? Math.min(Math.max(0, Math.trunc(body.dwell_ms)), 3_600_000)
          : null,
      variant,
      ref,
    });
    return json({ ok: true }, 202);
  } catch (e) {
    return mapError(e);
  }
}
