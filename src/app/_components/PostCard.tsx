import Link from "next/link";
import type { FeedPost } from "../_lib/types";
import { initials } from "./AuthorCard";
import { ReceiptBadge, SponsorLabels } from "./Receipt";

function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Feed card: title, kind, board, author, upvotes, receipt summary,
// accepted-answer marker, sponsor/promoted labels.
export function PostCard({ post }: { post: FeedPost }) {
  return (
    <article className="post-card-wrap" data-post-id={post.id}>
      <Link href={`/post/${post.id}`} className="post-card">
        <div className="title-row">
          <span className={`kind-tag ${post.kind}`}>{post.kind}</span>
          <h2>{post.title}</h2>
          <SponsorLabels
            isSponsored={post.isSponsored}
            sponsorLabel={post.sponsorLabel}
            isPromoted={post.isPromoted}
          />
        </div>
        {post.bodyPreview ? (
          <p className="card-preview" style={{ margin: "8px 0 0", color: "var(--muted)", fontSize: 14 }}>
            {post.bodyPreview}
          </p>
        ) : null}
        <div className="card-meta">
          <span className="avatar" aria-hidden style={{ width: 22, height: 22, fontSize: 10 }}>
            {initials(post.author.displayName, post.author.handle)}
          </span>
          <span>{post.author.displayName}</span>
          {post.author.verified ? <span className="badge verified">verified</span> : null}
          <Link href={`/b/${post.board.slug}`} className="chip" style={{ padding: "1px 9px", fontSize: 12 }}>
            {post.board.name}
          </Link>
          <ReceiptBadge receipt={post.receipt} />
          {post.acceptedReplyId ? <span className="badge accepted">accepted answer</span> : null}
          {post.upvotes > 0 ? <span className="score-pill">▲ {post.upvotes}</span> : null}
          {post.createdAt ? <span>{timeAgo(post.createdAt)}</span> : null}
        </div>
      </Link>
    </article>
  );
}
