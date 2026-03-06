import { useSnapshot } from "./hooks/useSnapshot";
import { HeroCard } from "./components/HeroCard";
import { MetricGrid } from "./components/MetricGrid";
import { RunningTable } from "./components/RunningTable";
import { RetryTable } from "./components/RetryTable";

export function App() {
  const { snapshot, connected } = useSnapshot();

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

  return (
    <div className="app-shell">
      <div className="dashboard-shell">
        <HeroCard connected={connected} provider={snapshot.provider} />
        <MetricGrid snapshot={snapshot} />
        <RunningTable entries={snapshot.running} />
        <RetryTable entries={snapshot.retrying} />
      </div>
    </div>
  );
}
