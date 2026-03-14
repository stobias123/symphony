import type {
  AgentProvider,
  AgentSession,
  SessionConfig,
  TurnResult,
  TurnOptions,
  AgentMessage,
  ToolResult,
} from "../types.js";
import type { Issue } from "../../trackers/types.js";
import type { Config } from "../../config.js";
import { JsonRpcClient, type JsonRpcMessage } from "./json-rpc-client.js";
import { DynamicToolExecutor } from "../../tools/dynamic-tool.js";
import { getToolSpecs } from "../../tools/tool-specs.js";
import { McpManager } from "../../mcp/mcp-manager.js";
import { logger } from "../../logger.js";

const NON_INTERACTIVE_ANSWER =
  "This is a non-interactive session. Operator input is unavailable.";

export class CodexProvider implements AgentProvider {
  readonly name = "codex";
  private config: Config;
  private toolExecutor: DynamicToolExecutor;
  private mcpManager: McpManager;
  private clients = new Map<string, JsonRpcClient>();
  private mcpInitialized = false;

  constructor(config: Config) {
    this.config = config;
    this.toolExecutor = new DynamicToolExecutor(config);
    this.mcpManager = new McpManager(config.mcpServers);
  }

  async startSession(workspace: string, sessionConfig: SessionConfig): Promise<AgentSession> {
    // Lazy-initialize MCP servers on first session
    if (!this.mcpInitialized) {
      this.mcpInitialized = true;
      await this.mcpManager.initialize();
    }

    const client = new JsonRpcClient();
    client.spawn(this.config.codexCommand, workspace);

    const expandedWorkspace = workspace;

    try {
      // Initialize
      await client.send(
        "initialize",
        {
          capabilities: { experimentalApi: true },
          clientInfo: {
            name: "symphony-orchestrator",
            title: "Symphony Orchestrator",
            version: "0.1.0",
          },
        },
        this.config.codexReadTimeoutMs,
      );

      client.sendNotification("initialized", {});

      // Start thread — merge built-in tools with MCP-discovered tools
      const toolSpecs = [
        ...getToolSpecs(this.config.trackerKind),
        ...this.mcpManager.getToolSpecs(),
      ];
      const threadResult = (await client.send(
        "thread/start",
        {
          approvalPolicy: sessionConfig.approvalPolicy,
          sandbox: sessionConfig.threadSandbox,
          cwd: expandedWorkspace,
          dynamicTools: toolSpecs.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
        this.config.codexReadTimeoutMs,
      )) as { thread?: { id?: string } };

      const threadId = threadResult?.thread?.id;
      if (!threadId) {
        throw new Error(`Invalid thread response: ${JSON.stringify(threadResult)}`);
      }

      const sessionId = `codex-${threadId}`;
      this.clients.set(sessionId, client);

      return {
        id: sessionId,
        threadId,
        metadata: {
          codexAppServerPid: client.osPid ?? "",
        },
      };
    } catch (err) {
      client.close();
      throw err;
    }
  }

  async runTurn(
    session: AgentSession,
    prompt: string,
    issue: Issue,
    opts?: TurnOptions,
  ): Promise<TurnResult> {
    const client = this.clients.get(session.id);
    if (!client) throw new Error(`No client for session ${session.id}`);

    const onMessage = opts?.onMessage ?? (() => {});
    const toolExecutor = opts?.toolExecutor ?? ((name, args) => this.toolExecutor.execute(name, args));

    const autoApprove = this.config.codexApprovalPolicy === "never";
    const sandboxPolicy = this.config.codexTurnSandboxPolicy();

    // Start turn
    const turnResult = (await client.send(
      "turn/start",
      {
        threadId: session.threadId,
        input: [{ type: "text", text: prompt }],
        cwd: session.metadata.workspace ?? "",
        title: `${issue.identifier}: ${issue.title}`,
        approvalPolicy: this.config.codexApprovalPolicy,
        sandboxPolicy,
      },
      this.config.codexReadTimeoutMs,
    )) as { turn?: { id?: string } };

    const turnId = turnResult?.turn?.id ?? "unknown";
    const sessionId = `${session.threadId}-${turnId}`;

    logger.info(
      { issueId: issue.id, identifier: issue.identifier, sessionId },
      "Codex turn started",
    );

    emitMessage(onMessage, "session_started", {
      sessionId,
      threadId: session.threadId,
      turnId,
    });

    // Await turn completion
    return new Promise<TurnResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Turn timeout"));
      }, this.config.codexTurnTimeoutMs);

      const handleMessage = async (message: JsonRpcMessage) => {
        try {
          const result = await this.handleTurnMessage(
            client,
            message,
            onMessage,
            toolExecutor,
            autoApprove,
          );

          if (result) {
            clearTimeout(timeout);
            client.removeListener("message", handleMessage);

            const turnResult: TurnResult = {
              sessionId,
              threadId: session.threadId,
              turnId,
              result: result.status,
              usage: extractUsage(message),
            };

            if (result.status === "completed") {
              resolve(turnResult);
            } else {
              reject(
                Object.assign(new Error(`Turn ${result.status}`), {
                  turnResult,
                }),
              );
            }
          }
        } catch (err) {
          clearTimeout(timeout);
          client.removeListener("message", handleMessage);
          reject(err);
        }
      };

      client.on("message", handleMessage);

      client.once("exit", (code) => {
        clearTimeout(timeout);
        client.removeListener("message", handleMessage);
        reject(new Error(`Codex process exited with code ${code}`));
      });
    });
  }

  async stopSession(session: AgentSession): Promise<void> {
    const client = this.clients.get(session.id);
    if (client) {
      client.close();
      this.clients.delete(session.id);
    }
  }

  async shutdown(): Promise<void> {
    await this.mcpManager.shutdown();
  }

  private async handleTurnMessage(
    client: JsonRpcClient,
    message: JsonRpcMessage,
    onMessage: (msg: AgentMessage) => void,
    toolExecutor: (name: string, args: Record<string, unknown>) => Promise<ToolResult>,
    autoApprove: boolean,
  ): Promise<{ status: "completed" | "failed" | "cancelled" } | null> {
    const method = message.method;
    if (!method) return null;

    switch (method) {
      case "turn/completed":
        emitMessage(onMessage, "turn_completed", { payload: message });
        return { status: "completed" };

      case "turn/failed":
        emitMessage(onMessage, "turn_failed", { payload: message });
        return { status: "failed" };

      case "turn/cancelled":
        emitMessage(onMessage, "turn_cancelled", { payload: message });
        return { status: "cancelled" };

      case "item/tool/call":
        await this.handleToolCall(client, message, onMessage, toolExecutor);
        return null;

      case "item/commandExecution/requestApproval":
      case "execCommandApproval":
      case "applyPatchApproval":
      case "item/fileChange/requestApproval":
        this.handleApprovalRequest(client, message, onMessage, autoApprove);
        return null;

      case "item/tool/requestUserInput":
        this.handleUserInputRequest(client, message, onMessage, autoApprove);
        return null;

      default:
        if (this.needsInput(method, message)) {
          emitMessage(onMessage, "turn_input_required", { payload: message });
          return { status: "failed" };
        }
        emitMessage(onMessage, "notification", { payload: message });
        return null;
    }
  }

  private async handleToolCall(
    client: JsonRpcClient,
    message: JsonRpcMessage,
    onMessage: (msg: AgentMessage) => void,
    toolExecutor: (name: string, args: Record<string, unknown>) => Promise<ToolResult>,
  ): Promise<void> {
    const id = message.id;
    if (id === undefined) return;

    const params = message.params ?? {};
    const toolName =
      (params.tool as string) ??
      (params.name as string) ??
      null;
    const args =
      (params.arguments as Record<string, unknown>) ?? {};

    if (!toolName) {
      client.sendResult(id, { success: false, error: "No tool name provided" });
      emitMessage(onMessage, "unsupported_tool_call", { payload: message });
      return;
    }

    // Route MCP tools to the MCP manager, others to the standard executor
    const result = this.mcpManager.canHandle(toolName)
      ? await this.mcpManager.callTool(toolName, args)
      : await toolExecutor(toolName, args);
    client.sendResult(id, result);

    const event = result.success ? "tool_call_completed" : "tool_call_failed";
    emitMessage(onMessage, event, { payload: message });
  }

  private handleApprovalRequest(
    client: JsonRpcClient,
    message: JsonRpcMessage,
    onMessage: (msg: AgentMessage) => void,
    autoApprove: boolean,
  ): void {
    const id = message.id;
    if (id === undefined) return;

    if (autoApprove) {
      const decision =
        message.method === "item/commandExecution/requestApproval" ||
        message.method === "item/fileChange/requestApproval"
          ? "acceptForSession"
          : "approved_for_session";

      client.sendResult(id, { decision });
      emitMessage(onMessage, "approval_auto_approved", {
        payload: message,
        decision,
      });
    } else {
      emitMessage(onMessage, "approval_required", { payload: message });
    }
  }

  private handleUserInputRequest(
    client: JsonRpcClient,
    message: JsonRpcMessage,
    onMessage: (msg: AgentMessage) => void,
    autoApprove: boolean,
  ): void {
    const id = message.id;
    if (id === undefined) return;

    const params = message.params ?? {};
    const questions = (params.questions as Array<Record<string, unknown>>) ?? [];

    if (autoApprove) {
      // Try to find approval options
      const answers: Record<string, { answers: string[] }> = {};
      let foundApproval = true;

      for (const question of questions) {
        const qId = question.id as string;
        if (!qId) {
          foundApproval = false;
          break;
        }

        const options = (question.options as Array<Record<string, unknown>>) ?? [];
        const approvalLabel = findApprovalLabel(options);

        if (approvalLabel) {
          answers[qId] = { answers: [approvalLabel] };
        } else {
          foundApproval = false;
          break;
        }
      }

      if (foundApproval && Object.keys(answers).length > 0) {
        client.sendResult(id, { answers });
        emitMessage(onMessage, "approval_auto_approved", {
          payload: message,
          decision: "Approve this Session",
        });
        return;
      }
    }

    // Fall back to non-interactive answer
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of questions) {
      const qId = question.id as string;
      if (qId) {
        answers[qId] = { answers: [NON_INTERACTIVE_ANSWER] };
      }
    }

    if (Object.keys(answers).length > 0) {
      client.sendResult(id, { answers });
      emitMessage(onMessage, "tool_input_auto_answered", {
        payload: message,
        answer: NON_INTERACTIVE_ANSWER,
      });
    }
  }

  private needsInput(method: string, message: JsonRpcMessage): boolean {
    if (!method.startsWith("turn/")) return false;

    const inputMethods = [
      "turn/input_required",
      "turn/needs_input",
      "turn/need_input",
      "turn/request_input",
      "turn/request_response",
      "turn/provide_input",
      "turn/approval_required",
    ];

    if (inputMethods.includes(method)) return true;

    const params = message.params ?? {};
    return (
      params.requiresInput === true ||
      params.needsInput === true ||
      params.input_required === true ||
      params.inputRequired === true ||
      params.type === "input_required" ||
      params.type === "needs_input"
    );
  }
}

function findApprovalLabel(options: Array<Record<string, unknown>>): string | null {
  const labels = options
    .map((o) => o.label as string)
    .filter((l): l is string => typeof l === "string");

  return (
    labels.find((l) => l === "Approve this Session") ??
    labels.find((l) => l === "Approve Once") ??
    labels.find((l) => {
      const lower = l.trim().toLowerCase();
      return lower.startsWith("approve") || lower.startsWith("allow");
    }) ??
    null
  );
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

function extractUsage(message: JsonRpcMessage): { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined {
  const usage = (message as Record<string, unknown>).usage as Record<string, number> | undefined;
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens ?? usage.inputTokens,
    outputTokens: usage.output_tokens ?? usage.outputTokens,
    totalTokens: usage.total_tokens ?? usage.totalTokens,
  };
}
