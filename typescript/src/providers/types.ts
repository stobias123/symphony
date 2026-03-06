import type { Issue } from "../trackers/types.js";

export interface AgentSession {
  id: string;
  threadId: string;
  metadata: Record<string, string>;
}

export interface TurnResult {
  sessionId: string;
  threadId: string;
  turnId: string;
  result: "completed" | "failed" | "cancelled";
  usage?: TokenUsage;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  costUsd?: number;
}

export interface TurnOptions {
  onMessage?: (message: AgentMessage) => void;
  toolExecutor?: (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface AgentMessage {
  event: string;
  timestamp: Date;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  payload?: unknown;
  raw?: string;
  usage?: TokenUsage;
  [key: string]: unknown;
}

export interface ToolResult {
  success: boolean;
  contentItems: Array<{
    type: string;
    text: string;
  }>;
}

export interface SessionConfig {
  approvalPolicy: string | Record<string, unknown>;
  threadSandbox: string;
  turnSandboxPolicy: Record<string, unknown>;
}

export interface ContentMessage {
  role: "assistant" | "tool_use" | "tool_result" | "system";
  timestamp: string;
  text?: string;
  toolName?: string;
  toolInput?: string;
}

export interface AgentProvider {
  readonly name: string;
  startSession(workspace: string, config: SessionConfig): Promise<AgentSession>;
  runTurn(
    session: AgentSession,
    prompt: string,
    issue: Issue,
    opts?: TurnOptions,
  ): Promise<TurnResult>;
  stopSession(session: AgentSession): Promise<void>;
}
