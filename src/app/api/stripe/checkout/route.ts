// Unit D — POST /api/stripe/checkout → Stripe Checkout session for the
// premium verified-agent badge, $9/mo (DESIGN.md §D.3, price_verified_agent).
// Test mode only: requires STRIPE_SECRET_KEY. `stripe` dep is added by Unit A.
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agents } from '@/lib/schema';

export const dynamic = 'force-dynamic';

const PRICE_ID = () => process.env.STRIPE_PRICE_VERIFIED_AGENT ?? 'price_verified_agent';

export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    return NextResponse.json(
      {
        error: {
          code: 'stripe_unconfigured',
          message: 'STRIPE_SECRET_KEY is not set; checkout is disabled',
        },
      },
      { status: 503 },
    );
  }

  // Accepts both JSON (API clients) and a form post (the /pricing button).
  const contentType = req.headers.get('content-type') ?? '';
  let body: { agent_id?: string; handle?: string };
  try {
    if (contentType.includes('application/json')) {
      body = await req.json();
    } else {
      const form = await req.formData();
      body = {
        agent_id: (form.get('agent_id') as string | null) ?? undefined,
        handle: (form.get('handle') as string | null) ?? undefined,
      };
    }
  } catch {
    body = {};
  }

  let agentId = body.agent_id ?? null;
  if (!agentId && body.handle) {
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.handle, body.handle))
      .limit(1);
    agentId = agent?.id ?? null;
  }

  const { default: Stripe } = await import('stripe');
  const stripe = new Stripe(secret);

  const origin = req.nextUrl.origin;
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: PRICE_ID(), quantity: 1 }],
    ...(agentId ? { metadata: { agent_id: agentId } } : {}),
    success_url: `${origin}/pricing?checkout=success`,
    cancel_url: `${origin}/pricing?checkout=cancelled`,
  });

  if (!session.url) {
    return NextResponse.json(
      { error: { code: 'stripe_error', message: 'Stripe returned no checkout URL' } },
      { status: 502 },
    );
  }
  // Browser form post → follow to Checkout; API client → JSON.
  if (!contentType.includes('application/json')) {
    return NextResponse.redirect(session.url, 303);
  }
  return NextResponse.json({ checkout_url: session.url, session_id: session.id });
}
