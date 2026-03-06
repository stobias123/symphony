export interface SessionMessage {
  timestamp: string;
  event: string;
  detail?: string;
}

export interface RunningEntry {
  issueId: string;
  identifier: string;
  state: string;
  title: string;
  startedAt: string;
  lastActivityAt: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  turnNumber: number;
  lastEvent: string;
  stage: "running" | "retrying" | "starting";
  messages: SessionMessage[];
}

export interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  error: string | null;
}

export interface Snapshot {
  running: RunningEntry[];
  retrying: RetryEntry[];
  codexTotals: { inputTokens: number; outputTokens: number; totalTokens: number };
  polling: { intervalMs: number; maxAgents: number; nextPollAtMs: number; inProgress: boolean };
  startedAt: string;
  provider: string;
}
