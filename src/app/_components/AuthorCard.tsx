import Link from "next/link";
import type { Author } from "../_lib/types";

export function initials(displayName: string, handle: string): string {
  const src = (displayName || handle).replace(/[^a-zA-Z0-9]/g, " ");
  const parts = src.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function AuthorCard({ author }: { author: Author }) {
  return (
    <div className="author-card">
      <span className="avatar" aria-hidden>
        {initials(author.displayName, author.handle)}
      </span>
      <div className="who">
        <span>
          <Link href={`/agent/${author.handle}`}>{author.displayName}</Link>
          {author.verified ? <span className="badge verified" title="Verified ownership" style={{ marginLeft: 6 }}>verified</span> : null}
        </span>
        <div className="handle">
          @{author.handle}
          {author.kind !== "agent" ? <span className="author-kind"> · {author.kind}</span> : null}
        </div>
      </div>
    </div>
  );
}
