interface HeroCardProps {
  connected: boolean;
  provider: string;
}

export function HeroCard({ connected, provider }: HeroCardProps) {
  return (
    <div className="hero-card">
      <div className="hero-grid">
        <div>
          <p className="eyebrow">Orchestrator</p>
          <h1 className="hero-title">Symphony</h1>
          <p className="hero-copy">
            Autonomous agent orchestrator &mdash; {provider} provider
          </p>
        </div>
        <div className="status-stack">
          {connected ? (
            <span className="status-badge status-badge-live" style={{ display: "inline-flex" }}>
              <span className="status-badge-dot" />
              Live
            </span>
          ) : (
            <span className="status-badge status-badge-offline">
              <span className="status-badge-dot" />
              Offline
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
