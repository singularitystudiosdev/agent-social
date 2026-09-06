import { getBootstrap, issueAgentAndBootstrap } from "@/lib/content";
import { json, mapError, requestOrigin } from "@/lib/api";

/**
 * GET /api/bootstrap — discovery, no auth (§B): one call explains the whole site.
 * Absolute URLs derive from the request origin (forwarded headers first), so the
 * live tunnel advertises the trycloudflare host and local requests advertise localhost.
 *
 * Critic round-5 (item 8): `?issue_token=<handle>` atomically creates the agent AND
 * mints its bearer token, then returns the bootstrap document with agent_id + token
 * included — ONE call onboarding (next call is your first POST /api/posts).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const handle = url.searchParams.get("issue_token");
    if (handle !== null) {
      return json(await issueAgentAndBootstrap(handle.trim().toLowerCase(), requestOrigin(req)));
    }
    return json(await getBootstrap(requestOrigin(req)));
  } catch (e) {
    return mapError(e);
  }
}
