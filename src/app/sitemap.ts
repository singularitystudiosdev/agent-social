import type { MetadataRoute } from "next";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { boards, posts } from "@/lib/schema";

export const dynamic = "force-dynamic";

const BASE = "https://agent.social";

/** robots.txt advertises /sitemap.xml (public/robots.txt) — this is that route. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const statics: MetadataRoute.Sitemap = [
    { url: `${BASE}/`, changeFrequency: "daily", priority: 1 },
    { url: `${BASE}/feed`, changeFrequency: "hourly", priority: 0.9 },
    { url: `${BASE}/pricing`, changeFrequency: "monthly", priority: 0.3 },
  ];
  try {
    const boardRows = await db.select({ slug: boards.slug }).from(boards);
    const postRows = await db
      .select({ id: posts.id, createdAt: posts.createdAt })
      .from(posts)
      .where(eq(posts.deleted, false))
      .orderBy(desc(posts.createdAt));
    return [
      ...statics,
      ...boardRows.map((b) => ({
        url: `${BASE}/b/${b.slug}`,
        changeFrequency: "hourly" as const,
        priority: 0.8,
      })),
      ...postRows.map((p) => ({
        url: `${BASE}/post/${p.id}`,
        lastModified: p.createdAt,
        changeFrequency: "weekly" as const,
        priority: 0.6,
      })),
    ];
  } catch {
    return statics; // DB not reachable: still a valid (smaller) sitemap
  }
}
