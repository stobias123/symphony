import type { Snapshot } from "../types";

function formatNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m${sec.toString().padStart(2, "0")}s`;
  const hr = Math.floor(min / 60);
  const rm = min % 60;
  return `${hr}h${rm.toString().padStart(2, "0")}m`;
}

interface MetricGridProps {
  snapshot: Snapshot;
}

export function MetricGrid({ snapshot }: MetricGridProps) {
  const runtime = formatDuration(Date.now() - new Date(snapshot.startedAt).getTime());
  const totalInput = snapshot.codexTotals.inputTokens + snapshot.cumulativeTotals.inputTokens;
  const totalOutput = snapshot.codexTotals.outputTokens + snapshot.cumulativeTotals.outputTokens;
  const totalTokens = snapshot.codexTotals.totalTokens + snapshot.cumulativeTotals.totalTokens;

  return (
    <div className="metric-grid">
      <div className="metric-card">
        <p className="metric-label">Running</p>
        <p className="metric-value numeric">{snapshot.running.length}</p>
        <p className="metric-detail muted">of {snapshot.polling.maxAgents} max</p>
      </div>
      <div className="metric-card">
        <p className="metric-label">Retrying</p>
        <p className="metric-value numeric">{snapshot.retrying.length}</p>
      </div>
      <div className="metric-card">
        <p className="metric-label">Total Tokens</p>
        <p className="metric-value numeric">{formatNumber(totalTokens)}</p>
        <p className="metric-detail muted">
          in: {formatNumber(totalInput)} &middot; out: {formatNumber(totalOutput)}
        </p>
      </div>
      <div className="metric-card">
        <p className="metric-label">Total Spend</p>
        <p className="metric-value numeric">{formatCost(snapshot.totalCostUsd)}</p>
        {snapshot.cumulativeTotals.sessionCount > 0 && (
          <p className="metric-detail muted">
            {snapshot.cumulativeTotals.sessionCount} sessions &middot; {formatCost(snapshot.cumulativeTotals.costUsd)} historical
          </p>
        )}
      </div>
      <div className="metric-card">
        <p className="metric-label">Runtime</p>
        <p className="metric-value mono">{runtime}</p>
      </div>
    </div>
  );
}
