import { useState, useEffect } from "react";
import type { CompletedSession } from "../types";

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function formatNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatDuration(startedAt: string, endedAt: string): string {
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m${sec.toString().padStart(2, "0")}s`;
  const hr = Math.floor(min / 60);
  const rm = min % 60;
  return `${hr}h${rm.toString().padStart(2, "0")}m`;
}

function outcomeBadgeClass(outcome: string): string {
  switch (outcome) {
    case "completed": return "state-badge state-badge-active";
    case "failed": return "state-badge state-badge-danger";
    case "aborted": return "state-badge state-badge-warning";
    default: return "state-badge";
  }
}

interface SessionHistoryProps {
  onSelect?: (sessionId: number) => void;
}

export function SessionHistory({ onSelect }: SessionHistoryProps) {
  const [sessions, setSessions] = useState<CompletedSession[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/v1/sessions?limit=50");
        const data = await res.json();
        if (!cancelled) setSessions(data.sessions ?? []);
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const interval = setInterval(load, 10_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  if (loading) return null;
  if (sessions.length === 0) return null;

  return (
    <div className="section-card">
      <div className="section-header">
        <h2 className="section-title">Session History</h2>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Issue</th>
              <th>Outcome</th>
              <th>Duration</th>
              <th>Turns</th>
              <th>Tokens</th>
              <th>Cost</th>
              <th>Ended</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id ?? s.issueId}>
                <td>
                  <div className="issue-stack">
                    <span className="issue-id mono">
                      {s.identifier}
                      {onSelect && s.id && (
                        <a
                          className="detail-link"
                          href={`#/session/history/${s.id}`}
                          onClick={(e) => { e.preventDefault(); onSelect(s.id!); }}
                        >
                          view
                        </a>
                      )}
                    </span>
                    <span className="muted" style={{ fontSize: "0.82rem" }}>{s.title}</span>
                  </div>
                </td>
                <td><span className={outcomeBadgeClass(s.outcome)}>{s.outcome}</span></td>
                <td className="mono">{formatDuration(s.startedAt, s.endedAt)}</td>
                <td className="numeric">{s.turns}</td>
                <td>
                  <div className="token-stack">
                    <span className="numeric">{formatNumber(s.totalTokens)}</span>
                    <span className="muted" style={{ fontSize: "0.78rem" }}>
                      {formatNumber(s.inputTokens)} / {formatNumber(s.outputTokens)}
                    </span>
                  </div>
                </td>
                <td className="numeric">{formatCost(s.costUsd)}</td>
                <td className="mono" style={{ fontSize: "0.82rem" }}>
                  {new Date(s.endedAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
