// Unit D — A/B assignment (DESIGN.md §E).
// Edge middleware: cookie + ?ab= override logic ONLY. No DB here (edge runtime
// cannot reach Postgres); the ab_assignments upsert happens in src/lib/ab.ts
// (`ensureLandingAssignment`), which the landing/feed server components call.
import { NextRequest, NextResponse } from 'next/server';

export const AB_COOKIE = 'as_ab';
export const ANON_COOKIE = 'as_anon';
export const VARIANTS = ['a', 'b', 'c'] as const;
export const AB_COOKIE_MAX_AGE = 180 * 24 * 60 * 60; // 180 days, per §E

const isVariant = (v: string | undefined | null): v is (typeof VARIANTS)[number] =>
  !!v && (VARIANTS as readonly string[]).includes(v);

export function middleware(req: NextRequest) {
  const { pathname, searchParams } = req.nextUrl;

  // Agent API traffic is never assigned (§E). Belt-and-braces on top of the matcher.
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  const current = req.cookies.get(AB_COOKIE)?.value;
  const override = searchParams.get('ab');

  let variant: (typeof VARIANTS)[number];
  let source: 'cookie' | 'param' | 'new';
  if (isVariant(override)) {
    // ?ab=b overrides and re-sticks (§E): always re-set the 180d cookie.
    variant = override;
    source = 'param';
  } else if (isVariant(current)) {
    variant = current;
    source = 'cookie';
  } else {
    variant = VARIANTS[Math.floor(Math.random() * VARIANTS.length)];
    source = 'new';
  }

  // Anonymous id: minted once here so the server components have a stable key
  // for ab_assignments and conversion logging without a second round trip.
  let anonId = req.cookies.get(ANON_COOKIE)?.value;
  const needsAnon = !anonId;
  if (!anonId) anonId = `an_${crypto.randomUUID().replace(/-/g, '')}`;

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-as-ab', variant);
  requestHeaders.set('x-as-ab-source', source);
  requestHeaders.set('x-as-anon', anonId);

  const res = NextResponse.next({ request: { headers: requestHeaders } });

  if (source !== 'cookie') {
    res.cookies.set(AB_COOKIE, variant, {
      path: '/',
      maxAge: AB_COOKIE_MAX_AGE,
      sameSite: 'lax',
      httpOnly: true,
    });
  }
  if (needsAnon) {
    res.cookies.set(ANON_COOKIE, anonId, {
      path: '/',
      maxAge: AB_COOKIE_MAX_AGE,
      sameSite: 'lax',
      httpOnly: true,
    });
  }
  return res;
}

// HTML pages only. Excluded: /api/* (never assigned), Next internals,
// favicon, and the agent-facing static surfaces (robots/llms/skill) that
// crawlers fetch — those are agent traffic, not human page views.
export const config = {
  matcher: ['/((?!api/|_next/|favicon\\.ico|robots\\.txt|llms\\.txt|skill\\.md).*)'],
};
