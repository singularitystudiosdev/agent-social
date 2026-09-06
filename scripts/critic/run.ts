// Unit D — critic harness driver (DESIGN.md §F). Node, no deps beyond fetch/fs.
//
//   npx tsx scripts/critic/run.ts packets [--base http://localhost:3000]
//       Generates one JSON packet per scenario into .tmp/critic-packets/.
//       Each packet: task + rubric + every site's discovery surfaces.
//       Our surfaces come from AGENT_SOCIAL_URL (or --base, default
//       http://localhost:3000); competitor surfaces are fetched from
//       agent-only.com, moltbook.com, agentkind.io and cached in
//       .tmp/critic-cache/ (failures tolerated — a failed surface is
//       recorded as an error, never fatal).
//
//   npx tsx scripts/critic/run.ts score
//       Reads critic verdict JSON files from .tmp/critic-verdicts/*.json,
//       appends scored rows to .tmp/critic_results.jsonl, prints per-scenario
//       and per-site tallies and evaluates the §F.2 bar:
//         mean ≥7 across ≥5 scenarios  AND  beat agent-only.com head-to-head.
//
// Verdict file shape (one object or an array of them per file):
// {
//   "scenario_id": "mcp-weather-config",
//   "critic": "<model name>", "round": "R1",
//   "rubric": { "task_completable": 2, "onboarding_lt3_calls": 2,
//               "content_real": 1, "would_return": 2, "filler_penalty": 0 },
//   "choice": { "site": "agent.social", "first": true, "confidence": 0.8,
//               "reasons": ["..."], "capability_match": true,
//               "disqualifiers": [] }
// }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPETITORS, OUR_SITE, RUBRIC, SCENARIOS } from './scenarios';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKETS_DIR = path.join(ROOT, '.tmp', 'critic-packets');
const CACHE_DIR = path.join(ROOT, '.tmp', 'critic-cache');
const VERDICTS_DIR = path.join(ROOT, '.tmp', 'critic-verdicts');
const RESULTS_JSONL = path.join(ROOT, '.tmp', 'critic_results.jsonl');

const FETCH_TIMEOUT_MS = 10_000;
const MAX_SURFACE_CHARS = 24_000;
const OUR_ALIASES = [OUR_SITE, 'localhost', '127.0.0.1'];

type Surface = {
  name: string;
  url: string;
  status: number;
  ok: boolean;
  body: string;
  error?: string;
};

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function tryFetch(url: string, name: string): Promise<Surface> {
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': 'agent-social-critic/0.1',
        accept: 'application/json, text/markdown, text/plain;q=0.9, */*;q=0.8',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    return {
      name,
      url,
      status: res.status,
      ok: res.ok,
      body: text.slice(0, MAX_SURFACE_CHARS),
    };
  } catch (err) {
    return { name, url, status: 0, ok: false, body: '', error: String((err as Error).message ?? err) };
  }
}

function cacheSurface(host: string, surface: Surface): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(
    CACHE_DIR,
    `${host.replace(/[^a-z0-9.-]/gi, '_')}__${surface.name.replace(/[^a-z0-9]/gi, '_')}.txt`,
  );
  fs.writeFileSync(
    file,
    JSON.stringify({ url: surface.url, status: surface.status, ok: surface.ok, error: surface.error, body: surface.body }, null, 2),
  );
}

async function fetchSiteSurfaces(
  host: string,
  isOurs: boolean,
  base: string,
): Promise<Record<string, Surface>> {
  const baseOrigin = isOurs ? base : `https://${host}`;
  const wanted: { name: string; urls: string[] }[] = isOurs
    ? [
        { name: 'bootstrap', urls: [`${baseOrigin}/api/bootstrap`] },
        { name: 'llms_txt', urls: [`${baseOrigin}/llms.txt`] },
        { name: 'skill_md', urls: [`${baseOrigin}/skill.md`] },
        { name: 'feed', urls: [`${baseOrigin}/api/feed?mode=human&limit=10`] },
      ]
    : [
        // Competitors: probe the conventional discovery paths, tolerate misses.
        { name: 'bootstrap', urls: [`${baseOrigin}/api/bootstrap`, `${baseOrigin}/bootstrap`] },
        { name: 'llms_txt', urls: [`${baseOrigin}/llms.txt`, `${baseOrigin}/llms-full.txt`] },
        { name: 'skill_md', urls: [`${baseOrigin}/skill.md`, `${baseOrigin}/SKILL.md`] },
        { name: 'feed', urls: [`${baseOrigin}/api/feed?limit=10`] },
      ];

  const out: Record<string, Surface> = {};
  for (const w of wanted) {
    let surface: Surface | null = null;
    for (const url of w.urls) {
      const s = await tryFetch(url, w.name);
      if (s.ok && s.body.trim().length > 0) {
        surface = s;
        break;
      }
      surface = s; // keep last attempt for the error record
    }
    if (surface) {
      cacheSurface(host, surface);
      out[w.name] = surface;
    }
  }
  return out;
}

async function cmdPackets(): Promise<void> {
  const base = arg('--base') ?? process.env.AGENT_SOCIAL_URL ?? 'http://localhost:3000';
  fs.mkdirSync(PACKETS_DIR, { recursive: true });

  console.log(`Fetching our surfaces from ${base} …`);
  const ours = await fetchSiteSurfaces(OUR_SITE, true, base);
  for (const [name, s] of Object.entries(ours)) {
    console.log(`  ${name}: ${s.ok ? `ok (${s.status}, ${s.body.length} chars)` : `FAILED ${s.error ?? s.status}`}`);
  }
  if (!ours.bootstrap?.ok) {
    console.log('  (our bootstrap unavailable — is the dev server up? packets will still generate)');
  }

  const competitorSurfaces: Record<string, Record<string, Surface>> = {};
  for (const host of COMPETITORS) {
    console.log(`Fetching ${host} …`);
    competitorSurfaces[host] = await fetchSiteSurfaces(host, false, base);
    const got = Object.entries(competitorSurfaces[host]);
    console.log(got.length
      ? got.map(([n, s]) => `  ${n}: ${s.ok ? 'ok' : `FAILED ${s.error ?? s.status}`}`).join('\n')
      : '  (all surfaces failed — recorded as errors)');
  }

  let written = 0;
  for (const sc of SCENARIOS) {
    const packet = {
      scenario_id: sc.id,
      generated_at: new Date().toISOString(),
      task: sc.task,
      capability_keywords: sc.capability_keywords,
      rubric: RUBRIC,
      rounds: sc.rounds,
      choice_test: {
        instruction:
          'Fetch/inspect the discovery surfaces below for each site, pick ONE site for the task, ' +
          'and answer as JSON: {site, first (was it your first instinct?), confidence 0-1, reasons[], capability_match (bool), disqualifiers[]}.',
        sites: [OUR_SITE, ...COMPETITORS],
        our_site: OUR_SITE,
      },
      surfaces: { [OUR_SITE]: ours, ...competitorSurfaces },
    };
    const file = path.join(PACKETS_DIR, `${sc.id}.json`);
    fs.writeFileSync(file, JSON.stringify(packet, null, 2));
    console.log(`wrote ${path.relative(ROOT, file)}`);
    written++;
  }
  console.log(`\n${written} packets in ${path.relative(ROOT, PACKETS_DIR)}`);
}

// ---------- score ----------

type Verdict = {
  scenario_id: string;
  critic?: string;
  round?: string;
  rubric: Record<string, number>;
  choice?: {
    site?: string;
    first?: boolean;
    confidence?: number;
    reasons?: string[];
    capability_match?: boolean;
    disqualifiers?: string[];
  } | null;
};

function normSite(site: string | undefined): string {
  if (!site) return '';
  const s = site.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return s;
}

function isOurSite(site: string | undefined): boolean {
  const s = normSite(site);
  return OUR_ALIASES.some((a) => s === a || s === normSite(a) || s.includes(normSite(a)));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** §F rubric total: fixed components, clamped 0..10 (filler subtracts). */
function rubricTotal(rubric: Record<string, number>): { total: number; maxed: boolean } {
  const v = (k: string) => (typeof rubric[k] === 'number' ? rubric[k] : 0);
  let total =
    clamp(v('task_completable'), 0, 3) +
    clamp(v('onboarding_lt3_calls'), 0, 2) +
    clamp(v('content_real'), 0, 2) +
    clamp(v('would_return'), 0, 2) +
    clamp(v('filler_penalty'), -1, 0);
  total = clamp(total, 0, 10);
  return { total, maxed: false };
}

/** §F choice-test score: chosen-first 10, chosen-but-not-first 4,
 *  not chosen 0; capability mismatch −3, each disqualifier −2; clamped 0..10. */
function choiceScore(verdict: Verdict): number | null {
  const choice = verdict.choice;
  if (!choice || !choice.site) return null;
  const ours = isOurSite(choice.site);
  let base: number;
  if (ours) base = choice.first === false ? 4 : 10;
  else base = 0; // a competitor (or unknown site) chosen — we were not chosen
  let score = base;
  if (choice.capability_match === false) score -= 3;
  score -= (choice.disqualifiers?.length ?? 0) * 2;
  return clamp(score, 0, 10);
}

function loadVerdicts(): Verdict[] {
  if (!fs.existsSync(VERDICTS_DIR)) return [];
  const verdicts: Verdict[] = [];
  for (const file of fs.readdirSync(VERDICTS_DIR).filter((f) => f.endsWith('.json'))) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(VERDICTS_DIR, file), 'utf8'));
      for (const v of Array.isArray(parsed) ? parsed : [parsed]) {
        if (v?.scenario_id) verdicts.push(v as Verdict);
      }
    } catch (err) {
      console.warn(`skipping unparseable verdict file ${file}: ${(err as Error).message}`);
    }
  }
  return verdicts;
}

async function cmdScore(): Promise<void> {
  const verdicts = loadVerdicts();
  if (verdicts.length === 0) {
    console.log(
      `No verdicts in ${path.relative(ROOT, VERDICTS_DIR)} yet.\n` +
        'Give each packet to a critic model, save its JSON verdict there, then re-run `score`.',
    );
  }

  const scored = verdicts.map((v) => {
    const { total } = rubricTotal(v.rubric ?? {});
    const cs = choiceScore(v);
    return { verdict: v, rubric_total: total, choice_score: cs };
  });

  // Append to the jsonl first (every scored verdict is durable), then tally.
  if (scored.length > 0) {
    fs.mkdirSync(path.dirname(RESULTS_JSONL), { recursive: true });
    const lines = scored.map((s) =>
      JSON.stringify({
        scored_at: new Date().toISOString(),
        scenario_id: s.verdict.scenario_id,
        critic: s.verdict.critic ?? null,
        round: s.verdict.round ?? null,
        rubric: s.verdict.rubric,
        rubric_total: s.rubric_total,
        choice: s.verdict.choice ?? null,
        choice_site: s.verdict.choice?.site ?? null,
        choice_score: s.choice_score,
      }),
    );
    fs.appendFileSync(RESULTS_JSONL, lines.join('\n') + '\n');
    console.log(`appended ${scored.length} scored verdict(s) to ${path.relative(ROOT, RESULTS_JSONL)}`);
  }

  // ---- tallies ----
  const byScenario = new Map<string, number[]>();
  const siteCounts = new Map<string, { choices: number; choice_score_sum: number; n: number }>();
  for (const s of scored) {
    const arr = byScenario.get(s.verdict.scenario_id) ?? [];
    arr.push(s.rubric_total);
    byScenario.set(s.verdict.scenario_id, arr);
    const site = s.verdict.choice?.site ? normSite(s.verdict.choice.site) : '(none)';
    const agg = siteCounts.get(site) ?? { choices: 0, choice_score_sum: 0, n: 0 };
    agg.choices += 1;
    agg.n += 1;
    if (s.choice_score != null) agg.choice_score_sum += s.choice_score;
    siteCounts.set(site, agg);
  }

  console.log('\nPer-scenario rubric means (target: mean ≥ 7 across ≥ 5 scenarios):');
  const scenarioMeans: { id: string; mean: number | null }[] = [];
  for (const sc of SCENARIOS) {
    const arr = byScenario.get(sc.id) ?? [];
    const mean = arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    scenarioMeans.push({ id: sc.id, mean });
    console.log(`  ${sc.id.padEnd(22)} ${mean == null ? 'no verdicts' : mean.toFixed(2) + `  (n=${arr.length})`}`);
  }

  console.log('\nPer-site choice tallies:');
  for (const [site, agg] of [...siteCounts.entries()].sort((a, b) => b[1].choices - a[1].choices)) {
    const avgCs = (agg.choice_score_sum / agg.choices).toFixed(1);
    console.log(`  ${site.padEnd(20)} chosen ${String(agg.choices).padEnd(3)} avg choice_score ${avgCs}`);
  }

  // ---- §F.2 bar ----
  const withMeans = scenarioMeans.filter((s) => s.mean != null) as { id: string; mean: number }[];
  const overallMean =
    withMeans.length > 0
      ? withMeans.reduce((a, s) => a + s.mean, 0) / withMeans.length
      : null;
  const meanOk = overallMean != null && overallMean >= 7;
  const countOk = withMeans.length >= 5;

  const oursChosen = scored.filter((s) => isOurSite(s.verdict.choice?.site)).length;
  const agentOnlyChosen = scored.filter(
    (s) => normSite(s.verdict.choice?.site) === normSite(COMPETITORS[0]),
  ).length;
  const headToHeadOk = oursChosen > agentOnlyChosen;

  console.log('\n§F.2 bar evaluation:');
  console.log(`  mean rubric: ${overallMean == null ? 'n/a' : overallMean.toFixed(2)} (need ≥ 7) → ${meanOk ? 'PASS' : 'FAIL'}`);
  console.log(`  scenarios scored: ${withMeans.length} (need ≥ 5) → ${countOk ? 'PASS' : 'FAIL'}`);
  console.log(`  head-to-head vs agent-only.com: us ${oursChosen} vs ${agentOnlyChosen} → ${headToHeadOk ? 'PASS' : 'FAIL'}`);
  const bar = meanOk && countOk && headToHeadOk;
  console.log(`\nBAR: ${bar ? 'PASS ✅' : 'FAIL ❌'}`);
  process.exit(bar ? 0 : 2);
}

async function main() {
  const cmd = process.argv[2] ?? 'packets';
  if (cmd === 'packets') await cmdPackets();
  else if (cmd === 'score') await cmdScore();
  else {
    console.error(`unknown command "${cmd}" — use "packets" or "score"`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('critic run failed:', err);
  process.exit(1);
});
