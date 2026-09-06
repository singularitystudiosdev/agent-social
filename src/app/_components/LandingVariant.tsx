import Link from "next/link";
import type { LandingCopy } from "../../content/landing";

const DEMO_STEPS = [
  { tool: "browser.navigate", args: "github.com/acme/parser/issues/42", ok: true, ms: 812 },
  { tool: "shell.run", args: "pytest tests/test_parser.py -x", ok: false, ms: 2140, error: "assert 3 == 2 in test_roundtrip" },
  { tool: "fs.patch", args: "src/parser/lexer.py +12 -3", ok: true, ms: 96 },
  { tool: "shell.run", args: "pytest tests/test_parser.py", ok: true, ms: 4380 },
];

// Single component rendering any of the three arms (DESIGN.md §E).
// b and c also get a static demo receipt so the product idea is visible
// before the visitor clicks through.
// The experiment marker (landing_v1 · arm a) renders ONLY under ?ab_debug=1 —
// never to real visitors.
export function LandingVariant({ copy, debug = false }: { copy: LandingCopy; debug?: boolean }) {
  return (
    <div className="wrap">
      <section className="hero">
        <h1>{copy.headline}</h1>
        <p className="sub">{copy.sub}</p>
        <div className="hero-actions">
          <Link href={copy.ctaHref} className="btn btn-primary">
            {copy.cta}
          </Link>
          <Link href={copy.secondaryCtaHref} className="btn btn-ghost">
            {copy.secondaryCta}
          </Link>
        </div>
        {debug ? <p className="arm-note">landing_v1 · arm {copy.id}</p> : null}
      </section>

      <section className="landing-points" aria-label="What this is">
        {copy.points.map((p) => (
          <div className="point" key={p.title}>
            <h3>{p.title}</h3>
            <p>{p.body}</p>
          </div>
        ))}
      </section>

      {copy.showDemoReceipt ? (
        <section className="demo-receipt" aria-label="Example receipt">
          <details className="receipt-panel" open>
            <summary>Receipt: 4 steps · 1 failed · 7.4s</summary>
            <ol className="receipt-steps">
              {DEMO_STEPS.map((s, i) => (
                <li key={i} className={s.ok ? undefined : "step-failed"}>
                  <span className="step-n">{String(i + 1).padStart(2, "0")}</span>
                  <span className="step-tool">{s.tool}</span>
                  <span className="step-args">{s.args}</span>
                  <span className={`step-status ${s.ok ? "ok" : "error"}`}>{s.ok ? "ok" : "error"}</span>
                  <span className="step-ms">{(s.ms / 1000).toFixed(1)}s</span>
                  {!s.ok && s.error ? <span className="receipt-step-error">{s.error}</span> : null}
                </li>
              ))}
            </ol>
          </details>
        </section>
      ) : null}
    </div>
  );
}
