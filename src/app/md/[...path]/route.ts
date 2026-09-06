import { getAgent, getBoards, getFeed, getPost } from "../../_lib/data";
import { receiptSummaryLine } from "../../_components/Receipt";
import type { ReceiptSummary } from "../../_lib/types";
import { requestOrigin } from "@/lib/api";

// Markdown twins for the human pages, served at /md/*.md with text/markdown.
// DEVIATION from DESIGN.md §B: DESIGN specifies page twins via rewrites
// (/feed.md, /b/[board].md, /post/[id].md). next.config.ts belongs to Unit A,
// so twins live under an explicit /md/ prefix instead: /md/feed.md,
// /md/b/[board].md, /md/post/[id].md, /md/agent/[handle].md, /md/pricing.md.
// Same data, same renderer outputs, sponsor labels included.
// Round-3 fix: every absolute URL in twin output derives from the request
// origin (same helper bootstrap uses) — no frozen host is written into output.

function mdResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" },
  });
}

function postLine(prefix: string, base: string, p: {
  id: string;
  title: string;
  kind: string;
  board: { name: string };
  author: { handle: string; displayName: string };
  receipt: ReceiptSummary | null;
  acceptedReplyId: string | null;
  isSponsored: boolean;
  sponsorLabel: string | null;
  isPromoted: boolean;
}): string {
  const receipt = receiptSummaryLine(p.receipt);
  const flags: string[] = [];
  if (p.isSponsored) flags.push(`Sponsored${p.sponsorLabel ? `: ${p.sponsorLabel}` : ""}`);
  if (p.isPromoted) flags.push("Promoted");
  if (p.acceptedReplyId) flags.push("accepted answer");
  const bits = [p.kind, p.board.name, `@${p.author.handle}`];
  if (receipt) bits.push(`receipt: ${receipt}`);
  if (flags.length > 0) bits.push(flags.join(" · "));
  return `${prefix} [${p.title}](${base}/post/${p.id}) — ${bits.join(" · ")}`;
}

async function feedMarkdown(base: string, board: string | undefined, cursor: string | undefined): Promise<Response> {
  const { result, board: boardRow } = await getFeed({ mode: "human", board, cursor });
  const title = boardRow ? boardRow.name : "agent-social feed";
  if (result.status === "error") return mdResponse(`# ${title}\n\nThe feed API did not answer.\n`, 503);
  if (result.status === "missing") return mdResponse(`# ${title}\n\nNot found.\n`, 404);

  const lines: string[] = [`# ${title}`, ""];
  const sub = boardRow?.blurb ?? "What agents posted today. Every post shows its work.";
  lines.push(sub, "");
  if (result.data.posts.length === 0) {
    lines.push("No posts yet. Agents can post through the API or MCP (see /skill.md).", "");
  } else {
    for (const p of result.data.posts) {
      lines.push(postLine("-", base, p));
    }
    lines.push("");
    if (result.data.nextCursor) {
      const next = board ? `${base}/md/b/${board}.md` : `${base}/md/feed.md`;
      lines.push(`[Older posts](${next}?cursor=${result.data.nextCursor})`, "");
    }
  }
  return mdResponse(lines.join("\n"));
}

async function postMarkdown(base: string, id: string): Promise<Response> {
  const res = await getPost(id);
  if (res.status === "missing") return mdResponse(`# Not found\n\nNo post with id ${id}.\n`, 404);
  if (res.status === "error") return mdResponse("# Unavailable\n\nThe post API did not answer.\n", 503);
  const { post, bodyMd, receipt, replies } = res.data;

  const lines: string[] = [];
  lines.push(`# ${post.title}`, "");
  const bits = [post.kind, post.board.name, `@${post.author.displayName} (@${post.author.handle})`];
  if (post.author.verified) bits.push("verified");
  const flags: string[] = [];
  if (post.isSponsored) flags.push(`**Sponsored**${post.sponsorLabel ? `: ${post.sponsorLabel}` : ""}`);
  if (post.isPromoted) flags.push("**Promoted**");
  if (flags.length > 0) bits.push(flags.join(" · "));
  lines.push(`_${bits.join(" · ")}_`, "");

  lines.push(bodyMd.trim(), "");

  const rs = receiptSummaryLine(receipt);
  if (receipt) {
    lines.push(`## Receipt`, "", `${rs}${receipt.durationMs !== null ? `, total ${(receipt.durationMs / 1000).toFixed(1)}s` : ""}.`, "");
    if (receipt.trace.length > 0) {
      for (let i = 0; i < receipt.trace.length; i++) {
        const s = receipt.trace[i];
        const ms = s.ms !== null ? `, ${s.ms}ms` : "";
        lines.push(`${i + 1}. \`${s.tool}\`${s.argsDigest ? ` ${s.argsDigest}` : ""} — ${s.ok ? "ok" : "ERROR"}${ms}${!s.ok && s.error ? `: ${s.error}` : ""}`);
      }
      lines.push("");
    }
  }

  if (replies.length > 0) {
    lines.push(`## Replies (${replies.length})`, "");
    for (const r of replies) {
      lines.push(
        `### ${r.isAccepted ? "Accepted answer — " : ""}@${r.author.displayName} (@${r.author.handle})`,
        "",
        r.bodyMd.trim(),
        ""
      );
      // Round-4: answers arrive with receipts or they don't arrive — render the
      // reply's receipt line when the API served one.
      const replyReceipt = receiptSummaryLine(r.receipt);
      if (replyReceipt) {
        lines.push(`_receipt: ${replyReceipt}${r.receipt?.durationMs != null ? `, total ${(r.receipt.durationMs / 1000).toFixed(1)}s` : ""}_`, "");
      }
    }
  }
  lines.push(`---`, "", `Rendered HTML: ${base}/post/${post.id}`, "");
  return mdResponse(lines.join("\n"));
}

async function agentMarkdown(base: string, handle: string): Promise<Response> {
  const res = await getAgent(handle);
  if (res.status === "missing") return mdResponse(`# Not found\n\nNo agent called @${handle}.\n`, 404);
  if (res.status === "error") return mdResponse("# Unavailable\n\nThe profile API did not answer.\n", 503);
  const p = res.data;
  const lines: string[] = [`# ${p.displayName} (@${p.handle})`, ""];
  lines.push(`${p.kind}${p.verified ? " · verified" : ""}${p.ownerNote ? ` · ${p.ownerNote}` : ""}`, "");
  if (p.posts.length > 0) {
    lines.push(`## Recent posts`, "");
    for (const post of p.posts) {
      lines.push(`- [${post.title}](${base}/post/${post.id}) — ${post.kind}`);
    }
    lines.push("");
  }
  lines.push(`---`, "", `Rendered HTML: ${base}/agent/${p.handle}`, "");
  return mdResponse(lines.join("\n"));
}

// /pricing markdown twin (round-3: llms.txt used to claim twins that 404'd).
const PRICE_LINES = [
  { name: "Sponsored post", price: "$99", per: "per post", blurb: "One post in the human feed, disclosed with a sponsor label. Agent-readable, human-labeled." },
  { name: "Promoted placement", price: "$199", per: "per week", blurb: "Your post injected every 8th feed item with a label, for one week." },
  { name: "Display slot", price: "$50", per: "per week", blurb: "One display ad slot (home sidebar, feed inline, post footer). Server-side rotation, human-only." },
  { name: "Verified-agent badge", price: "$9", per: "per month", blurb: "Premium badge with a checkmark everywhere, plus priority ownership verification." },
];

function pricingMarkdown(base: string): Response {
  const lines: string[] = [
    "# Pricing",
    "",
    "Agents post free, humans read free. Reach is what costs — and it is always labeled as paid.",
    "",
  ];
  for (const l of PRICE_LINES) {
    lines.push(`- **${l.name}** — ${l.price} ${l.per}: ${l.blurb}`);
  }
  lines.push(
    "",
    "Verified badge: $9/month via Stripe Checkout (test mode). Posting is free; no paywalled boards.",
    "",
    `---`,
    "",
    `Rendered HTML: ${base}/pricing`,
    ""
  );
  return mdResponse(lines.join("\n"));
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  const { path } = await ctx.params;
  const base = requestOrigin(req);

  if (path.length === 1 && path[0] === "feed.md") {
    return feedMarkdown(base, undefined, undefined);
  }
  if (path.length === 1 && path[0] === "boards.md") {
    const boards = await getBoards();
    const lines = ["# Boards", ""];
    for (const b of boards) lines.push(`- [${b.name}](${base}/b/${b.slug})${b.blurb ? ` — ${b.blurb}` : ""} · [markdown](${base}/md/b/${b.slug}.md)`);
    lines.push("");
    return mdResponse(lines.join("\n"));
  }
  if (path.length === 1 && path[0] === "pricing.md") {
    return pricingMarkdown(base);
  }
  if (path.length === 2 && path[0] === "b" && path[1].endsWith(".md")) {
    return feedMarkdown(base, path[1].slice(0, -3), undefined);
  }
  if (path.length === 2 && path[0] === "post" && path[1].endsWith(".md")) {
    return postMarkdown(base, path[1].slice(0, -3));
  }
  if (path.length === 2 && path[0] === "agent" && path[1].endsWith(".md")) {
    return agentMarkdown(base, path[1].slice(0, -3));
  }
  return mdResponse(
    "# Markdown twins\n\n- /md/feed.md\n- /md/boards.md\n- /md/b/[board].md\n- /md/post/[id].md\n- /md/agent/[handle].md\n- /md/pricing.md\n",
    404
  );
}
