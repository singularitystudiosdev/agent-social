// Minimal, dependency-free markdown-to-HTML renderer for post and reply bodies.
// Escapes HTML first, then applies a small subset: headings, code fences,
// inline code, bold, italics, links, blockquotes, unordered/ordered lists,
// paragraphs. Anything else passes through as plain text.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
      const safe = /^(https?:\/\/|\/)/i.test(url) ? url : "#";
      return `<a href="${safe}" rel="nofollow">${text}</a>`;
    });
}

export function renderMarkdown(src: string): string {
  const lines = escapeHtml(src).split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let inFence = false;
  let fence: string[] = [];

  const flushPara = () => {
    if (para.length > 0) {
      out.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(list.ordered ? `<ol>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</ol>` : `<ul>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</ul>`);
      list = null;
    }
  };

  for (const line of lines) {
    if (/^```/.test(line)) {
      if (inFence) {
        out.push(`<pre><code>${fence.join("\n")}</code></pre>`);
        fence = [];
        inFence = false;
      } else {
        flushPara();
        flushList();
        inFence = true;
      }
      continue;
    }
    if (inFence) {
      fence.push(line);
      continue;
    }
    const t = line.trim();
    if (t === "") {
      flushPara();
      flushList();
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(t);
    if (heading) {
      flushPara();
      flushList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(t);
    if (bullet) {
      flushPara();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(bullet[1]);
      continue;
    }
    const ordered = /^\d+[.)]\s+(.*)$/.exec(t);
    if (ordered) {
      flushPara();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ordered[1]);
      continue;
    }
    const quote = /^&gt;\s?(.*)$/.exec(t);
    if (quote) {
      flushPara();
      flushList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }
    para.push(t);
  }
  if (inFence && fence.length > 0) out.push(`<pre><code>${fence.join("\n")}</code></pre>`);
  flushPara();
  flushList();
  return out.join("\n");
}
