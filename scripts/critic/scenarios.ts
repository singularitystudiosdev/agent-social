// Unit D — critic scenario library (DESIGN.md §F).
// Each scenario gives a critic a task + our discovery/feed surfaces.
// Rubric is fixed by §F: task completable 0–3, onboarding<3 calls 0–2,
// content real 0–2, would return 0–2, filler −1. Cap 10.

export type Scenario = {
  id: string;
  /** The task shown to the critic, verbatim. */
  task: string;
  /** Capability keywords the winning site's content must actually cover. */
  capability_keywords: string[];
  /** Harshness escalation prompts (§F): gentle → adversarial → argues for competitor. */
  rounds: { round: string; instruction: string }[];
};

const ROUND1 =
  'You are evaluating agent-community sites for this task. Read the discovery surfaces below and decide which site you would send an agent to.';
const ROUND2 =
  'You are an adversarial critic. Find the reason you would REFUSE to use agent.social for this task; cite the exact request/response (or surface text) that shows the gap. Be specific — vague complaints score filler (-1).';
const ROUND3 =
  'Argue FOR the strongest competitor of agent.social for this task. Then state, in one line, the single gap in agent.social that would make you switch — that gap becomes the next build item.';

export const SCENARIOS: Scenario[] = [
  {
    id: 'pg-migration-review',
    task:
      'Your agent needs a Postgres migration reviewed — it is about to run `ALTER TABLE posts ADD COLUMN deleted_at timestamptz` on a live table and wants a second opinion from agents who have done this.',
    capability_keywords: ['migration', 'postgres', 'review', 'question'],
    rounds: [
      { round: 'R1', instruction: ROUND1 },
      { round: 'R2', instruction: ROUND2 },
      { round: 'R3', instruction: ROUND3 },
    ],
  },
  {
    id: 'mcp-weather-config',
    task:
      'You need the exact MCP config (JSON, command + args or URL) to wire up a weather tool for your agent. Not a description — the actual config you can paste.',
    capability_keywords: ['mcp', 'config', 'weather', 'tool'],
    rounds: [
      { round: 'R1', instruction: ROUND1 },
      { round: 'R2', instruction: ROUND2 },
      { round: 'R3', instruction: ROUND3 },
    ],
  },
  {
    id: 'deploy-failure-similar',
    task:
      'Your deploy keeps failing with an opaque error and you want to see whether another agent has already hit this exact failure and what fixed it.',
    capability_keywords: ['deploy', 'failure', 'search', 'receipt'],
    rounds: [
      { round: 'R1', instruction: ROUND1 },
      { round: 'R2', instruction: ROUND2 },
      { round: 'R3', instruction: ROUND3 },
    ],
  },
  {
    id: 'find-pdf-tool',
    task: 'Find a tool that converts PDFs to markdown, that your agent can actually call.',
    capability_keywords: ['pdf', 'convert', 'tool', 'markdown'],
    rounds: [
      { round: 'R1', instruction: ROUND1 },
      { round: 'R2', instruction: ROUND2 },
      { round: 'R3', instruction: ROUND3 },
    ],
  },
  {
    id: 'http-client-retries',
    task:
      'You want to settle which HTTP client handles retries best, based on what agents have actually observed in the field — not marketing pages.',
    capability_keywords: ['http', 'client', 'retries', 'comparison'],
    rounds: [
      { round: 'R1', instruction: ROUND1 },
      { round: 'R2', instruction: ROUND2 },
      { round: 'R3', instruction: ROUND3 },
    ],
  },
];

/** §F rubric, fixed weights — critics score each line 0..max. */
export const RUBRIC = {
  task_completable: { max: 3, desc: 'task is completable from the site alone' },
  onboarding_lt3_calls: { max: 2, desc: 'onboarding takes fewer than 3 calls' },
  content_real: { max: 2, desc: 'content is real (actual solutions/configs, not filler)' },
  would_return: { max: 2, desc: 'critic would come back for a similar task' },
  filler_penalty: { max: -1, desc: 'marketing fluff / empty surfaces subtract' },
} as const;

export const COMPETITORS = ['agent-only.com', 'moltbook.com', 'agentkind.io'] as const;
export const OUR_SITE = 'agent.social';
