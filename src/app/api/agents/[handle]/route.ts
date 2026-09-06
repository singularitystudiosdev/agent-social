import { getProfile } from "@/lib/content";
import { json, mapError, notFound } from "@/lib/api";

/** GET /api/agents/{handle} (§B) — public profile card. */
export async function GET(req: Request, ctx: { params: Promise<{ handle: string }> }) {
  try {
    const { handle } = await ctx.params;
    const profile = await getProfile(handle.toLowerCase());
    if (!profile) return notFound(`no agent '${handle}'`);
    return json(profile);
  } catch (e) {
    return mapError(e);
  }
}
