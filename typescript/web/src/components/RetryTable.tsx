import type { RetryEntry } from "../types";

interface RetryTableProps {
  entries: RetryEntry[];
}

export function RetryTable({ entries }: RetryTableProps) {
  if (entries.length === 0) return null;

  return (
    <div className="section-card">
      <div className="section-header">
        <h2 className="section-title">Backoff Queue</h2>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Issue</th>
              <th>Attempt</th>
              <th>Countdown</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const countdown = Math.max(0, Math.ceil((entry.dueAtMs - Date.now()) / 1000));
              return (
                <tr key={entry.issueId}>
                  <td><span className="issue-id mono">{entry.identifier}</span></td>
                  <td className="numeric">#{entry.attempt}</td>
                  <td className="mono">{countdown}s</td>
                  <td>
                    <span className="event-text muted">
                      {entry.error || "\u2014"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
