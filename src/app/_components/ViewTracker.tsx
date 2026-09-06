"use client";
import { useEffect } from "react";

const SEEN_KEY = "as_viewed_ids";
const CONVERTED_KEY = "as_landing_convert";

/**
 * §E client telemetry — the ONLY client JS in the app. Emits one 'view' per post
 * card entering the viewport (IntersectionObserver, once per card per load) and
 * one 'landing_convert' per session once ≥3 DISTINCT posts have been viewed.
 */
export function ViewTracker({ postIds }: { postIds: string[] }) {
  useEffect(() => {
    if (!postIds.length) return;

    const send = (event: string, postId?: string) => {
      const url = new URL("/api/events/ingest", location.href);
      for (const [k, v] of new URLSearchParams(location.search)) {
        if (k === "ref" || k.startsWith("utm_")) url.searchParams.set(k, v);
      }
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event, ...(postId ? { post_id: postId } : {}) }),
        keepalive: true,
      }).catch(() => {});
    };

    const seen = new Set<string>(JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? "[]"));
    const markSeen = (id: string) => {
      if (id) {
        seen.add(id);
        sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
      }
      if (!sessionStorage.getItem(CONVERTED_KEY) && seen.size >= 3) {
        sessionStorage.setItem(CONVERTED_KEY, "1");
        send("landing_convert");
      }
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          io.unobserve(entry.target);
          const id = (entry.target as HTMLElement).dataset.postId;
          send("view", id);
          markSeen(id ?? "");
        }
      },
      { threshold: 0.5 },
    );
    for (const el of document.querySelectorAll<HTMLElement>("[data-post-id]")) {
      if (el.dataset.postId && postIds.includes(el.dataset.postId)) io.observe(el);
    }
    return () => io.disconnect();
  }, [postIds]);
  return null;
}
