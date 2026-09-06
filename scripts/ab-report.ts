// Unit D — scripts/ab-report.ts (DESIGN.md §E).
// Prints per-variant: assignment counts, landing_convert counts, view counts,
// and conversion rate. Run: npx tsx scripts/ab-report.ts
// Reads DATABASE_URL (default: local dev DB).
import { sql } from 'drizzle-orm';
import { db } from '../src/lib/db';

const VARIANTS = ['a', 'b', 'c'] as const;

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const res = await db.execute(query);
  // node-postgres returns {rows}, postgres.js returns the array directly.
  const anyRes = res as unknown as { rows?: unknown[] };
  return (Array.isArray(res) ? res : (anyRes.rows ?? [])) as T[];
}

async function main() {
  const assignments = await rows<{ variant: string; n: string | number }>(
    sql`select variant, count(*)::text as n
        from ab_assignments
        where experiment = 'landing_v1'
        group by variant`,
  );
  const converts = await rows<{ variant: string | null; n: string | number }>(
    sql`select variant, count(*)::text as n
        from engagement_events
        where event = 'landing_convert'
        group by variant`,
  );
  const views = await rows<{ variant: string | null; n: string | number }>(
    sql`select variant, count(*)::text as n
        from engagement_events
        where event = 'view' and variant is not null
        group by variant`,
  );

  const byVariant = (rs: { variant: string | null; n: string | number }[], v: string) =>
    Number(rs.find((r) => r.variant === v)?.n ?? 0);

  console.log('agent.social — landing_v1 A/B report\n');
  console.log('variant | assigned | converts | views | conv rate');
  console.log('--------+----------+----------+-------+----------');
  let totalAssigned = 0;
  let totalConverts = 0;
  for (const v of VARIANTS) {
    const a = byVariant(assignments, v);
    const c = byVariant(converts, v);
    const vw = byVariant(views, v);
    totalAssigned += a;
    totalConverts += c;
    const rate = a > 0 ? ((c / a) * 100).toFixed(1) + '%' : '—';
    console.log(`${v.padEnd(7)} | ${String(a).padEnd(8)} | ${String(c).padEnd(8)} | ${String(vw).padEnd(5)} | ${rate}`);
  }
  console.log('--------+----------+----------+-------+----------');
  console.log(
    `TOTAL   | ${String(totalAssigned).padEnd(8)} | ${String(totalConverts).padEnd(8)} |`,
  );
  if (totalAssigned === 0) {
    console.log('\n(no assignments yet — visit / with a fresh browser or ?ab=a|b|c)');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('ab-report failed:', err.message);
  process.exit(1);
});
