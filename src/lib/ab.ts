// Unit D — A/B assignment persistence + conversion logging (DESIGN.md §E).
// Middleware (edge) cannot reach Postgres, so the ab_assignments upsert runs
// here, invoked from the landing/feed server components.
//
// Expected contract from Unit A:
//   src/lib/db.ts      → export const db  (drizzle instance)
//   src/lib/schema.ts  → abAssignments, engagementEvents tables with
//                        camelCase property names matching the §A SQL.
import { headers as nextHeaders } from 'next/headers';
import { db } from './db';
import { abAssignments, engagementEvents } from './schema';

export type Variant = 'a' | 'b' | 'c';
export const LANDING_EXPERIMENT = 'landing_v1';
export const AB_COOKIE = 'as_ab';
export const ANON_COOKIE = 'as_anon';
const VARIANTS: Variant[] = ['a', 'b', 'c'];

export type AbAssignment = {
  variant: Variant;
  anonId: string;
  source: 'cookie' | 'param' | 'new';
};

/** Read the assignment middleware stashed on forwarded request headers. */
export async function readAssignmentFromHeaders(h?: Headers): Promise<AbAssignment | null> {
  const hdrs = h ?? (await nextHeaders());
  const raw = hdrs.get('x-as-ab');
  const anonId = hdrs.get('x-as-anon');
  if (!raw || !VARIANTS.includes(raw as Variant) || !anonId) return null;
  const src = hdrs.get('x-as-ab-source');
  const source: AbAssignment['source'] =
    src === 'param' || src === 'new' || src === 'cookie' ? src : 'cookie';
  return { variant: raw as Variant, anonId, source };
}

/** Upsert the ab_assignments row (anon_id, experiment) → variant. Idempotent. */
export async function recordAssignment(
  anonId: string,
  variant: Variant,
  source: AbAssignment['source'] = 'cookie',
): Promise<void> {
  await db
    .insert(abAssignments)
    .values({
      anonId,
      experiment: LANDING_EXPERIMENT,
      variant,
      stickinessSource: source === 'param' ? 'param' : source,
    })
    .onConflictDoNothing(); // PK (anon_id, experiment): first assignment wins
}

/**
 * Call from the landing (and feed) server components: persists the variant
 * middleware assigned and returns it so the page can render its arm.
 * Returns null when middleware did not run (e.g. direct /api hit).
 */
export async function ensureLandingAssignment(): Promise<AbAssignment | null> {
  const assignment = await readAssignmentFromHeaders();
  if (!assignment) return null;
  await recordAssignment(assignment.anonId, assignment.variant, assignment.source);
  return assignment;
}

/** Log the §E conversion: human visitor viewed ≥3 posts. variant + ref kept. */
export async function logLandingConvert(opts: {
  anonId: string;
  variant: Variant;
  ref?: string | null;
  postsViewed?: number;
}): Promise<void> {
  await db.insert(engagementEvents).values({
    anonId: opts.anonId,
    viewerType: 'human',
    viewerConfidence: 0.95,
    event: 'landing_convert',
    variant: opts.variant,
    ref: opts.ref ?? null,
    dwellMs: opts.postsViewed != null ? opts.postsViewed : null,
  });
}

/** `?utm_*` / `?ref=` capture — stored as engagement_events.ref (§E). */
export function readRef(searchParams: URLSearchParams): string | null {
  const ref =
    searchParams.get('ref') ??
    searchParams.get('utm_content') ??
    searchParams.get('utm_source');
  return ref && ref.length <= 120 ? ref : ref ? ref.slice(0, 120) : null;
}
