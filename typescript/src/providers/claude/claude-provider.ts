import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentProvider,
  AgentSession,
  SessionConfig,
  TurnResult,
  TurnOptions,
  AgentMessage,
} from "../types.js";
import type { Issue } from "../../trackers/types.js";
import type { Config } from "../../config.js";
import { DynamicToolExecutor } from "../../tools/dynamic-tool.js";
import { getToolSpecs } from "../../tools/tool-specs.js";
import { logger } from "../../logger.js";
import { z } from "zod";

export class ClaudeProvider implements AgentProvider {
  readonly name = "claude";
  private config: Config;
  private toolExecutor: DynamicToolExecutor;
  private sessions = new Map<string, { sessionId?: string; workspace: string }>();

  constructor(config: Config) {
    this.config = config;
    this.toolExecutor = new DynamicToolExecutor(config);
  }

  async startSession(
    workspace: string,
    _sessionConfig: SessionConfig,
  ): Promise<AgentSession> {
    const id = `claude-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    this.sessions.set(id, { workspace });

    return {
      id,
      threadId: id,
      metadata: { workspace },
    };
  }

  async runTurn(
    session: AgentSession,
    prompt: string,
    issue: Issue,
    opts?: TurnOptions,
  ): Promise<TurnResult> {
    const state = this.sessions.get(session.id);
    if (!state) throw new Error(`No session state for ${session.id}`);

    const onMessage = opts?.onMessage ?? (() => {});
    const turnId = `turn-${Date.now()}`;
    const sessionId = `${session.threadId}-${turnId}`;

    logger.info(
      { issueId: issue.id, identifier: issue.identifier, sessionId },
      "Claude Agent SDK turn started",
    );

    emitMessage(onMessage, "session_started", {
      sessionId,
      threadId: session.threadId,
      turnId,
    });

    const mcpServer = this.buildMcpServer();
    const env = this.buildEnv();

    let sdkSessionId: string | undefined;

    try {
      const options: Parameters<typeof query>[0]["options"] = {
        model: this.config.claudeModel,
        cwd: state.workspace,
        permissionMode: this.config.claudePermissionMode,
        allowedTools: [
          "Read", "Write", "Edit", "Bash", "Glob", "Grep",
          ...this.mcpToolNames(),
        ],
        env,
        ...(mcpServer ? { mcpServers: { "symphony-tools": mcpServer } } : {}),
        ...(state.sessionId ? { resume: state.sessionId } : {}),
        ...(this.config.claudeSystemPrompt
          ? { systemPrompt: this.config.claudeSystemPrompt }
          : {}),
      };

      for await (const message of query({ prompt, options })) {
        // Capture session ID for resume on next turn
        if (
          message.type === "system" &&
          "session_id" in message
        ) {
          const sid = (message as Record<string, unknown>).session_id;
          if (typeof sid === "string" && sid) {
            sdkSessionId = sid;
            state.sessionId = sdkSessionId;
          }
        }

        // Emit assistant text progress
        if (message.type === "assistant" && "message" in message) {
          const msg = message.message as { content?: Array<{ type: string; text?: string }> };
          const text = msg.content
            ?.filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("");
          if (text) {
            emitMessage(onMessage, "assistant_message", {
              sessionId,
              text: text.slice(0, 500),
            });
          }
        }

        // Emit tool progress
        if (message.type === "tool_progress") {
          emitMessage(onMessage, "tool_call_started", {
            sessionId,
            tool: (message as Record<string, unknown>).tool_name,
          });
        }

        // Capture final result + usage
        if (message.type === "result") {
          const result = message as Record<string, unknown>;
          const usageData = result.usage as Record<string, number> | undefined;
          if (usageData) {
            emitMessage(onMessage, "usage_update", {
              sessionId,
              usage: {
                inputTokens: usageData.input_tokens ?? 0,
                outputTokens: usageData.output_tokens ?? 0,
                totalTokens: (usageData.input_tokens ?? 0) + (usageData.output_tokens ?? 0),
              },
            });
          }
          emitMessage(onMessage, "turn_completed", { sessionId });
        }
      }

      return {
        sessionId,
        threadId: session.threadId,
        turnId,
        result: "completed",
      };
    } catch (err) {
      logger.error({ err, sessionId }, "Claude Agent SDK turn failed");
      emitMessage(onMessage, "turn_failed", { sessionId, error: String(err) });

      return {
        sessionId,
        threadId: session.threadId,
        turnId,
        result: "failed",
      };
    }
  }

  async stopSession(session: AgentSession): Promise<void> {
    this.sessions.delete(session.id);
  }

  private buildMcpServer() {
    const specs = getToolSpecs(this.config.trackerKind);
    if (specs.length === 0) return null;

    const tools = specs.map((spec) => {
      const properties = (spec.inputSchema as Record<string, unknown>).properties as
        | Record<string, Record<string, unknown>>
        | undefined;
      const required = ((spec.inputSchema as Record<string, unknown>).required as string[]) ?? [];

      const shape: Record<string, z.ZodType> = {};
      if (properties) {
        for (const [key, prop] of Object.entries(properties)) {
          let fieldSchema: z.ZodType;
          if (prop.type === "string") {
            fieldSchema = z.string().describe((prop.description as string) ?? "");
          } else if (prop.type === "object") {
            fieldSchema = z.record(z.string(), z.unknown()).describe((prop.description as string) ?? "");
          } else {
            fieldSchema = z.unknown();
          }
          if (!required.includes(key)) {
            fieldSchema = fieldSchema.optional();
          }
          shape[key] = fieldSchema;
        }
      }

      return tool(
        spec.name,
        spec.description,
        shape,
        async (args: Record<string, unknown>) => {
          const result = await this.toolExecutor.execute(spec.name, args);
          return {
            content: result.contentItems.map((item) => ({
              type: "text" as const,
              text: item.text,
            })),
          };
        },
      );
    });

    return createSdkMcpServer({
      name: "symphony-tools",
      tools,
    });
  }

  private mcpToolNames(): string[] {
    const specs = getToolSpecs(this.config.trackerKind);
    return specs.map((s) => `mcp__symphony-tools__${s.name}`);
  }

  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {};

    // Copy current env
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }

    // OAuth token takes precedence
    const oauthToken = this.config.claudeOAuthToken;
    if (oauthToken) {
      env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    }

    // API key as fallback
    const apiKey = this.config.claudeApiKey;
    if (apiKey && !oauthToken) {
      env.ANTHROPIC_API_KEY = apiKey;
    }

    return env;
  }
}

function emitMessage(
  onMessage: (msg: AgentMessage) => void,
  event: string,
  details: Record<string, unknown>,
): void {
  onMessage({
    event,
    timestamp: new Date(),
    ...details,
  });
}
