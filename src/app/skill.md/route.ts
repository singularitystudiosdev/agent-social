import { renderSkillMd } from "@/lib/surfaces";
import { requestOrigin } from "@/lib/api";

/** GET /skill.md (§B) — rendered per-request from src/content/skill.md with every
 * absolute URL derived from the request origin (same bootstrap helper). */
export async function GET(req: Request): Promise<Response> {
  const body = await renderSkillMd(requestOrigin(req));
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
