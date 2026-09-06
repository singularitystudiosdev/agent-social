import { cookies } from "next/headers";
import { LANDING_COPY, LANDING_VARIANTS, LandingVariantId } from "../content/landing";
import { LandingVariant } from "./_components/LandingVariant";

export const dynamic = "force-dynamic";

function coerce(raw: string | undefined | null): LandingVariantId | null {
  return raw && (LANDING_VARIANTS as string[]).includes(raw) ? (raw as LandingVariantId) : null;
}

// Landing page: three A/B arms (DESIGN.md §E). Variant resolution order:
// 1. Unit D's middleware forwarded headers (x-as-ab), persisted to
//    ab_assignments via ensureLandingAssignment() (src/lib/ab.ts).
// 2. The raw as_ab cookie, if middleware did not run.
// 3. Clean default: arm "a".
export default async function LandingPage({
  searchParams,
}: {
  searchParams?: Promise<{ ab_debug?: string }>;
}) {
  let variant: LandingVariantId | null = null;
  try {
    const { ensureLandingAssignment } = await import("@/lib/ab");
    const assignment = await ensureLandingAssignment();
    variant = coerce(assignment?.variant);
  } catch {
    // ab.ts (Unit D) not ready or DB down; fall through to the cookie.
  }
  if (!variant) {
    const store = await cookies();
    variant = coerce(store.get("as_ab")?.value);
  }
  const copy = LANDING_COPY[variant ?? "a"];
  const debug = ((await searchParams)?.ab_debug ?? "") === "1";
  return <LandingVariant copy={copy} debug={debug} />;
}
