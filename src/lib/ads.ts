// Unit D — display ad slot fill + click logging (DESIGN.md §D.2).
// Server-side rotation: every eligible ad is served in turn; the pick is
// deterministic per (hour bucket, ad id) hash so the same hour serves the
// same ad per slot (cacheable) but the rotation moves every hour.
import { and, eq, lte, or, isNull, gt } from 'drizzle-orm';
import { db } from './db';
import { adSlots, ads, engagementEvents } from './schema';

export type ServedAd = {
  id: string;
  slot_id: string;
  advertiser: string;
  body_md: string;
  cta_url: string;
  /** POST /api/ads/serve {ad_id, ref} to log the click_ad event before nav. */
  click_endpoint: string;
};

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export async function getAdForSlot(
  slotId: string,
  opts: { humanViewer?: boolean } = {},
): Promise<ServedAd | null> {
  const [slot] = await db
    .select()
    .from(adSlots)
    .where(and(eq(adSlots.id, slotId), eq(adSlots.active, true)))
    .limit(1);
  if (!slot) return null;
  if (slot.humanOnly && !opts.humanViewer) return null;

  const eligible = await db
    .select()
    .from(ads)
    .where(
      and(
        eq(ads.slotId, slotId),
        eq(ads.active, true),
        or(isNull(ads.startsAt), lte(ads.startsAt, new Date())),
        or(isNull(ads.endsAt), gt(ads.endsAt, new Date())),
      ),
    );
  if (eligible.length === 0) return null;

  const bucket = Math.floor(Date.now() / (60 * 60 * 1000));
  const pick = eligible
    .map((ad) => ({ ad, h: hash32(`${bucket}:${ad.id}`) }))
    .sort((x, y) => x.h - y.h)[0].ad;

  return {
    id: pick.id,
    slot_id: slotId,
    advertiser: pick.advertiser,
    body_md: pick.bodyMd,
    cta_url: pick.ctaUrl,
    click_endpoint: '/api/ads/serve',
  };
}

/** D.2: `click_ad` events logged with `ref`. */
export async function logAdClick(opts: {
  adId: string;
  slotId?: string | null;
  anonId?: string | null;
  viewerTokenId?: string | null;
  ref?: string | null;
}): Promise<void> {
  await db.insert(engagementEvents).values({
    anonId: opts.anonId ?? null,
    viewerTokenId: opts.viewerTokenId ?? null,
    viewerType: opts.anonId ? 'human' : 'unknown',
    viewerConfidence: opts.anonId ? 0.95 : 0.1,
    event: 'click_ad',
    ref: opts.ref ?? opts.slotId ?? null,
  });
}
