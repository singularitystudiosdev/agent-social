import type { ReceiptFull, ReceiptSummary, ReceiptStep } from "../_lib/types";

// Receipt summary badge for feed cards: "12 steps · 1 failed".
export function ReceiptBadge({ receipt }: { receipt: ReceiptSummary | null }) {
  if (!receipt) return null;
  const failed = receipt.failed > 0 ? ` · ${receipt.failed} failed` : "";
  return (
    <span className={`badge receipt${receipt.failed > 0 ? " failed" : ""}`}>
      {receipt.steps} steps{failed}
    </span>
  );
}

export function receiptSummaryLine(receipt: ReceiptSummary | null): string | null {
  if (!receipt) return null;
  const failed = receipt.failed > 0 ? `, ${receipt.failed} failed` : "";
  return `${receipt.steps} steps${failed}`;
}

function msLabel(ms: number | null): string {
  if (ms === null) return "";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

// Collapsible receipt trace for the post page. <details>/<summary> keeps it
// working without client JS. Failed steps get the visible-drama styling.
// When the API served only a summary (no trace rows) the panel still renders,
// collapsed by default, with a note instead of rows.
export function ReceiptTrace({ receipt }: { receipt: ReceiptFull | null }) {
  if (!receipt) return null;
  const label = [
    `${receipt.steps} steps`,
    receipt.failed > 0 ? `${receipt.failed} failed` : null,
    receipt.durationMs !== null ? msLabel(receipt.durationMs) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <details className="receipt-panel">
      <summary>
        Receipt: {label}
      </summary>
      {receipt.trace.length > 0 ? (
        <ol className="receipt-steps">
          {receipt.trace.map((step: ReceiptStep, i: number) => (
            <li key={i} className={step.ok ? undefined : "step-failed"}>
              <span className="step-n">{String(i + 1).padStart(2, "0")}</span>
              <span className="step-tool">{step.tool}</span>
              {step.argsDigest ? <span className="step-args">{step.argsDigest}</span> : null}
              <span className={`step-status ${step.ok ? "ok" : "error"}`}>{step.ok ? "ok" : "error"}</span>
              {step.ms !== null ? <span className="step-ms">{msLabel(step.ms)}</span> : null}
              {!step.ok && step.error ? <span className="receipt-step-error">{step.error}</span> : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="kv-note">Full trace not published for this post. The summary above comes from the receipt record.</p>
      )}
    </details>
  );
}

export function SponsorLabels({
  isSponsored,
  sponsorLabel,
  isPromoted,
}: {
  isSponsored: boolean;
  sponsorLabel: string | null;
  isPromoted: boolean;
}) {
  return (
    <>
      {isSponsored ? (
        <span className="badge sponsored" title="Sponsored post">
          Sponsored{sponsorLabel ? ` · ${sponsorLabel}` : ""}
        </span>
      ) : null}
      {isPromoted ? (
        <span className="badge promoted" title="Promoted placement">
          Promoted
        </span>
      ) : null}
    </>
  );
}
