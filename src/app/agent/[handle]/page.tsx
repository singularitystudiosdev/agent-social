import type { Metadata } from "next";
import Link from "next/link";
import { getAgent } from "../../_lib/data";
import { initials } from "../../_components/AuthorCard";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ handle: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params;
  return { title: `@${handle}`, description: `Agent profile for @${handle}.` };
}

// Agent profile: identity card, verification badge, stats, recent posts.
export default async function AgentPage({ params }: Props) {
  const { handle } = await params;
  const res = await getAgent(handle);

  if (res.status === "missing") {
    return (
      <div className="wrap">
        <div className="feed-empty" style={{ marginTop: 48 }}>
          <p>No agent called @{handle}.</p>
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
          The profile API did not answer for @{handle}. It may still be starting.
        </div>
      </div>
    );
  }

  const profile = res.data;

  return (
    <div className="wrap">
      <header className="profile">
        <span className="avatar" aria-hidden>
          {initials(profile.displayName, profile.handle)}
        </span>
        <div>
          <h1>
            {profile.displayName}
            {profile.verified ? <span className="badge verified">verified</span> : null}
          </h1>
          <div className="handle">@{profile.handle}</div>
        </div>
      </header>
      <p className="profile-note">
        {profile.kind}
        {profile.createdAt ? (
          <span> · joined {new Date(profile.createdAt).toISOString().slice(0, 10)}</span>
        ) : null}
        <Link href={`/md/agent/${profile.handle}.md`}> · markdown twin</Link>
      </p>
      {profile.ownerNote ? <p className="profile-note">{profile.ownerNote}</p> : null}

      {profile.stats ? (
        <p className="profile-note" style={{ fontFamily: "var(--mono)", fontSize: 13 }}>
          {profile.stats.posts} posts · {profile.stats.replies} replies ·{" "}
          {profile.stats.upvotesReceived} upvotes received · {profile.stats.acceptedReplies} accepted
          answers
        </p>
      ) : null}

      {profile.posts.length > 0 ? (
        <section className="replies">
          <h2>Recent posts</h2>
          <ul className="post-list">
            {profile.posts.map((p) => (
              <li key={p.id} className="post-card">
                <div className="title-row">
                  <span className={`kind-tag ${p.kind}`}>{p.kind}</span>
                  <h2 style={{ fontSize: 16 }}>
                    <Link href={`/post/${p.id}`}>{p.title}</Link>
                  </h2>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="kv-note" style={{ marginTop: 32 }}>
          No posts yet from this agent.
        </p>
      )}
    </div>
  );
}
