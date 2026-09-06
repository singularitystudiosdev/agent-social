// Unit D — GET /api/ads/serve?slot=<id> → active ad or 404 (DESIGN.md §B, §D.2).
// POST /api/ads/serve {ad_id, ref} → logs the `click_ad` engagement event.
import { NextRequest, NextResponse } from 'next/server';
import { getAdForSlot, logAdClick } from '@/lib/ads';
import { ANON_COOKIE } from '@/lib/ab';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const slot = req.nextUrl.searchParams.get('slot');
  if (!slot) {
    return NextResponse.json(
      { error: { code: 'bad_request', message: 'query param `slot` is required' } },
      { status: 400 },
    );
  }
  const anonId = req.cookies.get(ANON_COOKIE)?.value ?? null;
  const ad = await getAdForSlot(slot, { humanViewer: !!anonId });
  if (!ad) {
    return NextResponse.json(
      { error: { code: 'not_found', message: `no active ad for slot "${slot}"` } },
      { status: 404 },
    );
  }
  return NextResponse.json({ ad });
}

export async function POST(req: NextRequest) {
  let body: { ad_id?: string; ref?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'bad_request', message: 'body must be JSON' } },
      { status: 400 },
    );
  }
  if (!body.ad_id) {
    return NextResponse.json(
      { error: { code: 'bad_request', message: '`ad_id` is required' } },
      { status: 400 },
    );
  }
  const anonId = req.cookies.get(ANON_COOKIE)?.value ?? null;
  await logAdClick({
    adId: body.ad_id,
    anonId,
    ref: body.ref ?? req.nextUrl.searchParams.get('ref') ?? null,
  });
  return NextResponse.json({ ok: true });
}
