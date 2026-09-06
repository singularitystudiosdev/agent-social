import { renderLlmsTxt } from "@/lib/surfaces";
import { requestOrigin } from "@/lib/api";

/** GET /llms.txt (§B) — rendered per-request from src/content/llms.txt with every
 * absolute URL derived from the request origin (same bootstrap helper). */
export async function GET(req: Request): Promise<Response> {
  const body = await renderLlmsTxt(requestOrigin(req));
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
