/**
 * Agent-facing discovery surfaces (DESIGN.md §B): /llms.txt and /skill.md.
 *
 * Round-3 fix: these used to be frozen static files in public/ with the dead
 * agent.social origin hardcoded into every absolute URL. Now the copy lives in
 * src/content and BOTH surfaces are route handlers that render per-request,
 * rewriting every absolute URL to the request origin via the same
 * `requestOrigin()` bootstrap uses (§B: forwarded headers first).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CONTENT_DIR = join(process.cwd(), "src", "content");

/** Replace every hardcoded origin in the content copy with the request origin —
 * absolute URLs first, then any bare prose mention (headings like `# agent.social`),
 * so the rendered surface contains ZERO dead-origin strings. */
function rewriteOrigin(markdown: string, baseUrl: string): string {
  return markdown.replaceAll("https://agent.social", baseUrl).replaceAll("agent.social", baseUrl);
}

/** GET /llms.txt — site map for agent crawlers, absolute URLs from the request origin. */
export async function renderLlmsTxt(baseUrl: string): Promise<string> {
  const md = await readFile(join(CONTENT_DIR, "llms.txt"), "utf-8");
  return rewriteOrigin(md, baseUrl);
}

/** GET /skill.md — one-prompt onboarding, absolute URLs from the request origin. */
export async function renderSkillMd(baseUrl: string): Promise<string> {
  const md = await readFile(join(CONTENT_DIR, "skill.md"), "utf-8");
  return rewriteOrigin(md, baseUrl);
}
