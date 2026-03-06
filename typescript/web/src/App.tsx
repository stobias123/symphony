import { useState, useEffect, useCallback } from "react";
import { useSnapshot } from "./hooks/useSnapshot";
import { HeroCard } from "./components/HeroCard";
import { MetricGrid } from "./components/MetricGrid";
import { RunningTable } from "./components/RunningTable";
import { RetryTable } from "./components/RetryTable";
import { SessionHistory } from "./components/SessionHistory";
import { SessionDetail } from "./components/SessionDetail";

type Route =
  | { page: "dashboard" }
  | { page: "session"; source: "running" | "history"; id: string };

function parseHash(): Route {
  const hash = window.location.hash;
  // #/session/running/:identifier
  const runningMatch = hash.match(/^#\/session\/running\/(.+)$/);
  if (runningMatch) return { page: "session", source: "running", id: decodeURIComponent(runningMatch[1]!) };
  // #/session/history/:id
  const historyMatch = hash.match(/^#\/session\/history\/(.+)$/);
  if (historyMatch) return { page: "session", source: "history", id: historyMatch[1]! };
  return { page: "dashboard" };
}

export function App() {
  const { snapshot, connected } = useSnapshot();
  const [route, setRoute] = useState<Route>(parseHash);

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigateTo = useCallback((r: Route) => {
    if (r.page === "dashboard") {
      window.location.hash = "";
    } else {
      window.location.hash = `#/session/${r.source}/${encodeURIComponent(r.id)}`;
    }
  }, []);

  const onSelectRunning = useCallback((identifier: string) => {
    navigateTo({ page: "session", source: "running", id: identifier });
  }, [navigateTo]);

  const onSelectHistory = useCallback((sessionId: number) => {
    navigateTo({ page: "session", source: "history", id: String(sessionId) });
  }, [navigateTo]);

  if (!snapshot) {
    return (
      <div className="app-shell">
        <div className="dashboard-shell">
          <HeroCard connected={false} provider="..." />
          <p className="muted">Connecting...</p>
        </div>
      </div>
    );
  }

  if (route.page === "session") {
    return (
      <div className="app-shell">
        <div className="dashboard-shell">
          <HeroCard connected={connected} provider={snapshot.provider} />
          <SessionDetail
            source={route.source}
            id={route.id}
            onBack={() => navigateTo({ page: "dashboard" })}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="dashboard-shell">
        <HeroCard connected={connected} provider={snapshot.provider} />
        <MetricGrid snapshot={snapshot} />
        <RunningTable entries={snapshot.running} onSelect={onSelectRunning} />
        <RetryTable entries={snapshot.retrying} />
        <SessionHistory onSelect={onSelectHistory} />
      </div>
    </div>
  );
}
