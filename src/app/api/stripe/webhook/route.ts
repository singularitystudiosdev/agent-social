// Unit D — POST /api/stripe/webhook (DESIGN.md §D.3).
// checkout.session.completed + customer.subscription.updated/deleted →
// subscriptions table; agents.verified = (status === 'active').
// If STRIPE_WEBHOOK_SECRET is unset (local dev without `stripe listen`),
// the signature check is skipped and a warning is logged — noted deviation,
// production must set it.
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agents, subscriptions } from '@/lib/schema';

export const dynamic = 'force-dynamic';

type SubLike = {
  id: string;
  status: string;
  current_period_end: number;
  items: { data: { price: { id: string } }[] };
};

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

async function applySubscription(
  stripeSubId: string,
  status: string,
  priceId: string,
  currentPeriodEnd: Date,
  agentId: string | null,
  customerId: string | null,
): Promise<void> {
  let resolvedAgentId = agentId;

  if (!resolvedAgentId && customerId) {
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.stripeCustomerId, customerId))
      .limit(1);
    resolvedAgentId = agent?.id ?? null;
  }

  const existing = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubId, stripeSubId))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(subscriptions).values({
      id: newId('sub'),
      agentId: resolvedAgentId,
      stripeSubId,
      status,
      priceId,
      currentPeriodEnd,
    });
  } else {
    await db
      .update(subscriptions)
      .set({ status, priceId, currentPeriodEnd })
      .where(eq(subscriptions.stripeSubId, stripeSubId));
    resolvedAgentId = resolvedAgentId ?? existing[0].agentId ?? null;
  }

  // Badge renders only while status='active' (§D.3): flip the flag both ways.
  if (resolvedAgentId) {
    await db
      .update(agents)
      .set({ verified: status === 'active' })
      .where(eq(agents.id, resolvedAgentId));
  }
}

export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    return NextResponse.json(
      { error: { code: 'stripe_unconfigured', message: 'STRIPE_SECRET_KEY is not set' } },
      { status: 503 },
    );
  }

  const { default: Stripe } = await import('stripe');
  const stripe = new Stripe(secret);

  const raw = await req.text();
  const sig = req.headers.get('stripe-signature');
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  if (webhookSecret) {
    try {
      event = stripe.webhooks.constructEvent(raw, sig ?? '', webhookSecret);
    } catch (err) {
      return NextResponse.json(
        {
          error: {
            code: 'invalid_signature',
            message: `webhook signature verification failed: ${(err as Error).message}`,
          },
        },
        { status: 400 },
      );
    }
  } else {
    console.warn('[stripe webhook] STRIPE_WEBHOOK_SECRET unset — skipping signature check');
    event = JSON.parse(raw);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as {
        id: string;
        customer: string | null;
        subscription: string | null;
        metadata: Record<string, string> | null;
      };
      if (session.subscription) {
        const sub = (await stripe.subscriptions.retrieve(
          session.subscription,
        )) as unknown as SubLike;
        await applySubscription(
          sub.id,
          sub.status,
          sub.items.data[0]?.price.id ?? 'price_verified_agent',
          new Date(sub.current_period_end * 1000),
          session.metadata?.agent_id ?? null,
          typeof session.customer === 'string' ? session.customer : null,
        );
      }
    } else if (
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      const sub = event.data.object as unknown as SubLike & { customer?: string };
      await applySubscription(
        sub.id,
        sub.status,
        sub.items.data[0]?.price.id ?? 'price_verified_agent',
        new Date(sub.current_period_end * 1000),
        null,
        typeof sub.customer === 'string' ? sub.customer : null,
      );
    }
  } catch (err) {
    console.error('[stripe webhook] handler error', err);
    return NextResponse.json(
      { error: { code: 'handler_error', message: (err as Error).message } },
      { status: 500 },
    );
  }

  return NextResponse.json({ received: true });
}
