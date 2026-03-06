import { useState, useEffect } from "react";
import type { ContentMessage } from "../types";

interface SessionDetailProps {
  /** "running" or "history" */
  source: "running" | "history";
  /** identifier (for running) or numeric session id (for history) */
  id: string;
  onBack: () => void;
}

export function SessionDetail({ source, id, onBack }: SessionDetailProps) {
  const [messages, setMessages] = useState<ContentMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const url =
          source === "running"
            ? `/api/v1/running/${encodeURIComponent(id)}/messages`
            : `/api/v1/sessions/${id}/messages`;
        const res = await fetch(url);
        if (!res.ok) {
          if (!cancelled) setError(`Failed to load (${res.status})`);
          return;
        }
        const data = await res.json();
        if (!cancelled) setMessages(data.messages ?? []);
      } catch {
        if (!cancelled) setError("Failed to fetch messages");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    // Auto-refresh for running sessions
    let interval: ReturnType<typeof setInterval> | undefined;
    if (source === "running") {
      interval = setInterval(load, 3000);
    }
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [source, id]);

  return (
    <div className="section-card">
      <div className="section-header">
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <button className="secondary" onClick={onBack} style={{ padding: "0.4rem 0.8rem", fontSize: "0.85rem" }}>
            &larr; Back
          </button>
          <h2 className="section-title">
            Session: {id}
            {source === "running" && (
              <span className="state-badge state-badge-active" style={{ marginLeft: "0.5rem", fontSize: "0.72rem", verticalAlign: "middle" }}>
                live
              </span>
            )}
          </h2>
        </div>
      </div>

      <div className="session-transcript">
        {loading && <p className="muted">Loading messages...</p>}
        {error && <p className="muted">{error}</p>}
        {!loading && !error && messages.length === 0 && (
          <p className="muted">No content messages captured for this session.</p>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`transcript-msg transcript-msg-${msg.role}`}>
            <div className="transcript-meta">
              <span className={`transcript-role transcript-role-${msg.role}`}>
                {msg.role === "assistant" ? "Assistant" : msg.role === "tool_use" ? "Tool" : msg.role}
              </span>
              {msg.toolName && <span className="transcript-tool-name">{msg.toolName}</span>}
              <span className="transcript-ts mono">
                {new Date(msg.timestamp).toLocaleTimeString()}
              </span>
            </div>
            {msg.text && (
              <pre className="transcript-text">{msg.text}</pre>
            )}
            {msg.toolInput && (
              <pre className="transcript-text transcript-text-tool">{formatToolInput(msg.toolInput)}</pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatToolInput(input: string): string {
  try {
    const parsed = JSON.parse(input);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return input;
  }
}
