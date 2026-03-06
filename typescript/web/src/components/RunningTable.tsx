import { useState } from "react";
import type { RunningEntry } from "../types";

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

function formatRelativeTime(isoStr: string): string {
  const ms = Date.now() - new Date(isoStr).getTime();
  if (ms < 1000) return "now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function stageBadgeClass(stage: string): string {
  switch (stage) {
    case "running": return "state-badge state-badge-active";
    case "starting": return "state-badge state-badge-warning";
    case "retrying": return "state-badge state-badge-danger";
    default: return "state-badge";
  }
}

function eventBadgeClass(event: string): string {
  if (event.includes("failed") || event.includes("error")) return "message-event message-event-danger";
  if (event.includes("completed") || event.includes("approved")) return "message-event message-event-success";
  if (event.includes("started")) return "message-event message-event-info";
  return "message-event";
}

interface RunningTableProps {
  entries: RunningEntry[];
  onSelect?: (identifier: string) => void;
}

export function RunningTable({ entries, onSelect }: RunningTableProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggleExpand = (issueId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(issueId)) {
        next.delete(issueId);
      } else {
        next.add(issueId);
      }
      return next;
    });
  };

  return (
    <div className="section-card">
      <div className="section-header">
        <h2 className="section-title">Running Sessions</h2>
      </div>
      {entries.length === 0 ? (
        <p className="empty-state">No agents running</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table data-table-running">
            <thead>
              <tr>
                <th>Issue</th>
                <th>State</th>
                <th>Stage</th>
                <th>Runtime</th>
                <th>Turns</th>
                <th>Tokens</th>
                <th>Cost</th>
                <th>Last Event</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const age = formatDuration(Date.now() - new Date(entry.startedAt).getTime());
                const isExpanded = expanded.has(entry.issueId);
                const hasMessages = entry.messages && entry.messages.length > 0;
                return (
                  <>
                    <tr
                      key={entry.issueId}
                      className={hasMessages ? "row-expandable" : ""}
                      onClick={() => hasMessages && toggleExpand(entry.issueId)}
                    >
                      <td>
                        <div className="issue-stack">
                          <span className="issue-id mono">
                            {hasMessages && (
                              <span className="expand-icon">{isExpanded ? "\u25BE" : "\u25B8"} </span>
                            )}
                            {entry.identifier}
                            {onSelect && (
                              <a
                                className="detail-link"
                                href={`#/session/running/${encodeURIComponent(entry.identifier)}`}
                                onClick={(e) => { e.stopPropagation(); onSelect(entry.identifier); }}
                              >
                                view
                              </a>
                            )}
                          </span>
                          <span className="muted" style={{ fontSize: "0.82rem" }}>{entry.title}</span>
                        </div>
                      </td>
                      <td><span className="state-badge">{entry.state}</span></td>
                      <td><span className={stageBadgeClass(entry.stage)}>{entry.stage}</span></td>
                      <td className="mono">{age}</td>
                      <td className="numeric">{entry.turnNumber}</td>
                      <td>
                        <div className="token-stack">
                          <span className="numeric">{formatNumber(entry.usage.totalTokens)}</span>
                          <span className="muted" style={{ fontSize: "0.78rem" }}>
                            {formatNumber(entry.usage.inputTokens)} / {formatNumber(entry.usage.outputTokens)}
                          </span>
                        </div>
                      </td>
                      <td className="numeric">{formatCost(entry.estimatedCostUsd)}</td>
                      <td>
                        <span className="event-text">{entry.lastEvent || "\u2014"}</span>
                      </td>
                    </tr>
                    {isExpanded && hasMessages && (
                      <tr key={`${entry.issueId}-messages`} className="message-row">
                        <td colSpan={8}>
                          <div className="message-timeline">
                            {[...entry.messages].reverse().map((msg, i) => (
                              <div key={i} className="message-entry">
                                <span className="message-ts mono">{formatRelativeTime(msg.timestamp)}</span>
                                <span className={eventBadgeClass(msg.event)}>{msg.event}</span>
                                {msg.detail && <span className="message-detail">{msg.detail}</span>}
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
