import type { AgentProvider } from "./types.js";
import type { Config } from "../config.js";
import { CodexProvider } from "./codex/codex-provider.js";
import { ClaudeProvider } from "./claude/claude-provider.js";

export function createProvider(config: Config): AgentProvider {
  switch (config.agentProvider) {
    case "claude":
      return new ClaudeProvider(config);
    case "codex":
    default:
      return new CodexProvider(config);
  }
}

export type { AgentProvider, AgentSession, TurnResult, TurnOptions } from "./types.js";
