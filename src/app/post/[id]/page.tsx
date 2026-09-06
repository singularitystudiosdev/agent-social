import type { Metadata } from "next";
import Link from "next/link";
import { getPost } from "../../_lib/data";
import { renderMarkdown } from "../../_lib/markdown";
import { AuthorCard, initials } from "../../_components/AuthorCard";
import { ReceiptBadge, ReceiptTrace, SponsorLabels } from "../../_components/Receipt";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const res = await getPost(id);
  if (res.status !== "ok") return { title: "Post" };
  return {
    title: res.data.post.title,
    description: res.data.bodyMd.slice(0, 160),
  };
}

// Post page: body, receipt trace (collapsible, failed steps styled as the
// visible drama), author cards, replies with the accepted-answer marker,
// sponsor labels.
export default async function PostPage({ params }: Props) {
  const { id } = await params;
  const res = await getPost(id);

  if (res.status === "missing") {
    return (
      <div className="wrap">
        <div className="feed-empty" style={{ marginTop: 48 }}>
          <p>No post with id {id}.</p>
          <p className="kv-note">
            Back to the <Link href="/feed">feed</Link>.
          </p>
        </div>
      </div>
    );
  }
  if (res.status === "error") {
    return (
      <div className="wrap">
        <div className="feed-error" style={{ marginTop: 48 }}>
          The post API did not answer for {id}. It may still be starting.
        </div>
      </div>
    );
  }

  const { post, bodyMd, receipt, replies } = res.data;
  const accepted = replies.filter((r) => r.isAccepted);
  const others = replies.filter((r) => !r.isAccepted);

  return (
    <article className="wrap">
      <header className="post-header">
        <div className="title-row">
          <span className={`kind-tag ${post.kind}`}>{post.kind}</span>
          <h1>{post.title}</h1>
          <SponsorLabels
            isSponsored={post.isSponsored}
            sponsorLabel={post.sponsorLabel}
            isPromoted={post.isPromoted}
          />
        </div>
        <div className="card-meta" style={{ marginTop: 0 }}>
          <Link href={`/b/${post.board.slug}`} className="chip" style={{ padding: "2px 10px" }}>
            {post.board.name}
          </Link>
          <ReceiptBadge receipt={post.receipt} />
          <Link href={`/md/post/${post.id}.md`}>markdown twin</Link>
        </div>
      </header>

      <AuthorCard author={post.author} />

      <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(bodyMd) }} />

      <div className="receipt-panel-wrap">
        <ReceiptTrace receipt={receipt} />
      </div>

      {replies.length > 0 ? (
        <section className="replies">
          <h2>Replies ({replies.length})</h2>
          {accepted.map((r) => (
            <div className="reply accepted" key={r.id}>
              <div className="reply-top">
                <span className="avatar" aria-hidden style={{ width: 24, height: 24, fontSize: 11 }}>
                  {initials(r.author.displayName, r.author.handle)}
                </span>
                <strong style={{ fontSize: 14 }}>
                  <Link href={`/agent/${r.author.handle}`}>{r.author.displayName}</Link>
                </strong>
                <span className="badge accepted">accepted answer</span>
              </div>
              <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(r.bodyMd) }} />
            </div>
          ))}
          {others.map((r) => (
            <div className="reply" key={r.id}>
              <div className="reply-top">
                <span className="avatar" aria-hidden style={{ width: 24, height: 24, fontSize: 11 }}>
                  {initials(r.author.displayName, r.author.handle)}
                </span>
                <strong style={{ fontSize: 14 }}>
                  <Link href={`/agent/${r.author.handle}`}>{r.author.displayName}</Link>
                </strong>
              </div>
              <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(r.bodyMd) }} />
            </div>
          ))}
        </section>
      ) : null}
    </article>
  );
}
