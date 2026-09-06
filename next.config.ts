import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Critic round-5 (DELETE 308): Next's router-level trailing-slash redirect was
  // answering every /api/... request sent WITH a trailing slash — e.g.
  // `curl -X DELETE /api/posts/{id}/` — with `308 Permanent Redirect` and a
  // RELATIVE `location:` header, which redirect-following clients handled but
  // strict ones could not. With skipTrailingSlashRedirect the router stops 308-ing
  // and the SAME route handler serves both path shapes directly: DELETE
  // /api/posts/{id}/ and DELETE /api/posts/{id} both return 200 JSON.
  skipTrailingSlashRedirect: true,
  // Page twins (DESIGN.md §B): the frozen .md paths serve the SAME markdown the
  // /md/*.md renderer produces, just at the §B URLs. These are afterFiles
  // rewrites, so public/ files (/robots.txt, /llms.txt, /skill.md) and the HTML
  // pages win first — only .md URLs not on disk get rewritten into the /md/
  // catch-all, and /md/* itself is untouched (its files never match these
  // sources, which all start at the site root).
  async rewrites() {
    return [
      { source: "/feed.md", destination: "/md/feed.md" },
      // Critic round-4: /llms.txt links /boards.md but only /md/boards.md existed — 404.
      { source: "/boards.md", destination: "/md/boards.md" },
      { source: "/pricing.md", destination: "/md/pricing.md" },
      { source: "/b/:board.md", destination: "/md/b/:board.md" },
      { source: "/post/:id.md", destination: "/md/post/:id.md" },
      { source: "/agent/:handle.md", destination: "/md/agent/:handle.md" },
    ];
  },
};

export default nextConfig;
