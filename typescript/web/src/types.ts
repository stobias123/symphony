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
  estimatedCostUsd: number;
}

export interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  error: string | null;
}

export interface CumulativeTotals {
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUsd: number;
}

export interface Snapshot {
  running: RunningEntry[];
  retrying: RetryEntry[];
  codexTotals: { inputTokens: number; outputTokens: number; totalTokens: number };
  cumulativeTotals: CumulativeTotals;
  totalCostUsd: number;
  polling: { intervalMs: number; maxAgents: number; nextPollAtMs: number; inProgress: boolean };
  startedAt: string;
  provider: string;
}

export interface ContentMessage {
  role: "assistant" | "tool_use" | "tool_result" | "system";
  timestamp: string;
  text?: string;
  toolName?: string;
  toolInput?: string;
}

export interface CompletedSession {
  id?: number;
  issueId: string;
  identifier: string;
  title: string;
  state: string;
  outcome: "completed" | "failed" | "aborted";
  model?: string;
  startedAt: string;
  endedAt: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUsd: number;
  createdAt?: string;
  messages?: SessionMessage[];
}
