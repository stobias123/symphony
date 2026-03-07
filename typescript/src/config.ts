import { z } from "zod";
import path from "node:path";
import os from "node:os";
import { Workflow, type LoadedWorkflow } from "./workflow.js";

const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"];
const DEFAULT_TERMINAL_STATES = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];
const DEFAULT_LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_WORKSPACE_ROOT = path.join(os.tmpdir(), "symphony_workspaces");
const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CONCURRENT_AGENTS = 10;
const DEFAULT_AGENT_MAX_TURNS = 20;
const DEFAULT_MAX_RETRY_BACKOFF_MS = 300_000;
const DEFAULT_CODEX_COMMAND = "codex app-server";
const DEFAULT_CODEX_TURN_TIMEOUT_MS = 3_600_000;
const DEFAULT_CODEX_READ_TIMEOUT_MS = 5_000;
const DEFAULT_CODEX_STALL_TIMEOUT_MS = 300_000;
const DEFAULT_CODEX_APPROVAL_POLICY = {
  reject: { sandbox_approval: true, rules: true, mcp_elicitations: true },
};
const DEFAULT_CODEX_THREAD_SANDBOX = "workspace-write";
const DEFAULT_OBSERVABILITY_REFRESH_MS = 1_000;
const DEFAULT_SERVER_HOST = "127.0.0.1";
const DEFAULT_PROMPT_TEMPLATE = `You are working on an issue.

Identifier: {{ issue.identifier }}
Title: {{ issue.title }}

Body:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}
`;

const trackerSchema = z.object({
  kind: z.enum(["linear", "jira", "memory"]).optional(),
  endpoint: z.string().default(DEFAULT_LINEAR_ENDPOINT),
  api_key: z.string().optional(),
  project_slug: z.string().optional(),
  assignee: z.string().optional(),
  active_states: z.array(z.string()).default(DEFAULT_ACTIVE_STATES),
  terminal_states: z.array(z.string()).default(DEFAULT_TERMINAL_STATES),
  labels: z.array(z.string()).default([]),
});

const pollingSchema = z.object({
  interval_ms: z.number().int().positive().default(DEFAULT_POLL_INTERVAL_MS),
});

const workspaceSchema = z.object({
  root: z.string().default(DEFAULT_WORKSPACE_ROOT),
});

const agentSchema = z.object({
  provider: z.enum(["codex", "claude"]).default("codex"),
  max_concurrent_agents: z.number().int().positive().default(DEFAULT_MAX_CONCURRENT_AGENTS),
  max_turns: z.number().int().positive().default(DEFAULT_AGENT_MAX_TURNS),
  max_retry_backoff_ms: z.number().int().positive().default(DEFAULT_MAX_RETRY_BACKOFF_MS),
  max_concurrent_agents_by_state: z.record(z.string(), z.number().int().positive()).default(() => ({})),
});

const codexSchema = z.object({
  command: z.string().default(DEFAULT_CODEX_COMMAND),
  turn_timeout_ms: z.number().int().positive().default(DEFAULT_CODEX_TURN_TIMEOUT_MS),
  read_timeout_ms: z.number().int().positive().default(DEFAULT_CODEX_READ_TIMEOUT_MS),
  stall_timeout_ms: z.number().int().nonnegative().default(DEFAULT_CODEX_STALL_TIMEOUT_MS),
  approval_policy: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  thread_sandbox: z.string().optional(),
  turn_sandbox_policy: z.record(z.string(), z.unknown()).optional(),
});

const claudeSchema = z.object({
  model: z.string().default("claude-sonnet-4-6"),
  max_tokens: z.number().int().positive().default(16384),
  oauth_token: z.string().optional(),
  api_key: z.string().optional(),
  permission_mode: z.enum(["default", "acceptEdits", "bypassPermissions"]).default("bypassPermissions"),
  system_prompt: z.string().optional(),
});

const hooksSchema = z.object({
  after_create: z.string().optional(),
  before_run: z.string().optional(),
  after_run: z.string().optional(),
  before_remove: z.string().optional(),
  timeout_ms: z.number().int().positive().default(DEFAULT_HOOK_TIMEOUT_MS),
});

const observabilitySchema = z.object({
  dashboard_enabled: z.boolean().default(true),
  refresh_ms: z.number().int().positive().default(DEFAULT_OBSERVABILITY_REFRESH_MS),
});

const serverSchema = z.object({
  port: z.number().int().nonnegative().default(3000),
  host: z.string().default(DEFAULT_SERVER_HOST),
});

export const WorkflowConfigSchema = z.object({
  tracker: trackerSchema,
  polling: pollingSchema,
  workspace: workspaceSchema,
  agent: agentSchema,
  codex: codexSchema,
  claude: claudeSchema,
  hooks: hooksSchema,
  observability: observabilitySchema,
  server: serverSchema,
});

export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;

export interface CodexRuntimeSettings {
  approvalPolicy: string | Record<string, unknown>;
  threadSandbox: string;
  turnSandboxPolicy: Record<string, unknown>;
}

export class Config {
  private workflow: Workflow;
  private _config: WorkflowConfig | null = null;

  constructor(workflow: Workflow) {
    this.workflow = workflow;
  }

  private get config(): WorkflowConfig {
    if (!this._config) {
      this._config = this.parseConfig();
    }
    return this._config;
  }

  reload(): void {
    this._config = null;
  }

  private parseConfig(): WorkflowConfig {
    const loaded = this.workflow.current();
    const raw = (loaded?.config ?? {}) as Record<string, unknown>;
    // Pre-fill missing sections with empty objects so inner field defaults apply
    const sections = [
      "tracker", "polling", "workspace", "agent", "codex",
      "claude", "hooks", "observability", "server",
    ];
    for (const key of sections) {
      if (!(key in raw) || raw[key] == null) {
        raw[key] = {};
      }
    }
    return WorkflowConfigSchema.parse(raw);
  }

  get trackerKind(): string | undefined {
    return this.config.tracker.kind;
  }

  get linearEndpoint(): string {
    return this.config.tracker.endpoint;
  }

  get linearApiToken(): string | undefined {
    return resolveEnvValue(this.config.tracker.api_key, process.env.LINEAR_API_KEY);
  }

  get linearProjectSlug(): string | undefined {
    return this.config.tracker.project_slug;
  }

  get linearAssignee(): string | undefined {
    return resolveEnvValue(this.config.tracker.assignee, process.env.LINEAR_ASSIGNEE);
  }

  get linearActiveStates(): string[] {
    return this.config.tracker.active_states;
  }

  get linearTerminalStates(): string[] {
    return this.config.tracker.terminal_states;
  }

  get trackerActiveStates(): string[] {
    return this.config.tracker.active_states;
  }

  get trackerTerminalStates(): string[] {
    return this.config.tracker.terminal_states;
  }

  get jiraEndpoint(): string | undefined {
    const ep = this.config.tracker.endpoint;
    return ep && ep !== DEFAULT_LINEAR_ENDPOINT ? ep.replace(/\/+$/, "") : undefined;
  }

  get jiraApiToken(): string | undefined {
    return resolveEnvValue(this.config.tracker.api_key, process.env.JIRA_API_KEY);
  }

  get jiraProjectKey(): string | undefined {
    return this.config.tracker.project_slug;
  }

  get jiraAssignee(): string | undefined {
    return resolveEnvValue(this.config.tracker.assignee, process.env.JIRA_ASSIGNEE);
  }

  get jiraLabels(): string[] {
    return this.config.tracker.labels;
  }

  get jiraEmail(): string | undefined {
    return process.env.JIRA_EMAIL ?? undefined;
  }

  get confluenceEndpoint(): string | undefined {
    const explicit =
      process.env.CONFLUENCE_ENDPOINT ?? process.env.confluence_endpoint ?? undefined;
    if (explicit) return explicit.replace(/\/+$/, "");
    if (this.trackerKind === "jira" && this.jiraEndpoint) {
      const base = this.jiraEndpoint.replace(/\/+$/, "");
      return base.endsWith("/wiki") ? base : `${base}/wiki`;
    }
    return undefined;
  }

  get confluenceUser(): string | undefined {
    return process.env.CONFLUENCE_USER ?? process.env.confluence_user ?? undefined;
  }

  get confluenceToken(): string | undefined {
    return process.env.CONFLUENCE_TOKEN ?? process.env.confluence_token ?? undefined;
  }

  get pollIntervalMs(): number {
    return this.config.polling.interval_ms;
  }

  get workspaceRoot(): string {
    return resolvePath(this.config.workspace.root, DEFAULT_WORKSPACE_ROOT);
  }

  get workspaceHooks() {
    return this.config.hooks;
  }

  get hookTimeoutMs(): number {
    return this.config.hooks.timeout_ms;
  }

  get maxConcurrentAgents(): number {
    return this.config.agent.max_concurrent_agents;
  }

  get agentMaxTurns(): number {
    return this.config.agent.max_turns;
  }

  get maxRetryBackoffMs(): number {
    return this.config.agent.max_retry_backoff_ms;
  }

  get agentProvider(): "codex" | "claude" {
    return this.config.agent.provider;
  }

  maxConcurrentAgentsForState(stateName: string): number {
    const limits = this.config.agent.max_concurrent_agents_by_state;
    const normalized = stateName.trim().toLowerCase();
    for (const [key, value] of Object.entries(limits)) {
      if (key.trim().toLowerCase() === normalized) return value;
    }
    return this.maxConcurrentAgents;
  }

  get codexCommand(): string {
    return this.config.codex.command;
  }

  get codexModel(): string | undefined {
    const parts = this.codexCommand.split(/\s+/);
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === "--model" && parts[i + 1]) return parts[i + 1];
      if (parts[i]?.startsWith("--model=")) return parts[i]!.split("=")[1];
    }
    return undefined;
  }

  get codexTurnTimeoutMs(): number {
    return this.config.codex.turn_timeout_ms;
  }

  get codexReadTimeoutMs(): number {
    return this.config.codex.read_timeout_ms;
  }

  get codexStallTimeoutMs(): number {
    return Math.max(0, this.config.codex.stall_timeout_ms);
  }

  get codexApprovalPolicy(): string | Record<string, unknown> {
    return this.config.codex.approval_policy ?? DEFAULT_CODEX_APPROVAL_POLICY;
  }

  get codexThreadSandbox(): string {
    return this.config.codex.thread_sandbox ?? DEFAULT_CODEX_THREAD_SANDBOX;
  }

  codexTurnSandboxPolicy(workspace?: string): Record<string, unknown> {
    if (this.config.codex.turn_sandbox_policy) {
      return this.config.codex.turn_sandbox_policy;
    }
    const writableRoot = workspace
      ? path.resolve(workspace)
      : path.resolve(this.workspaceRoot);
    return {
      type: "workspaceWrite",
      writableRoots: [writableRoot],
      readOnlyAccess: { type: "fullAccess" },
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }

  codexRuntimeSettings(workspace?: string): CodexRuntimeSettings {
    return {
      approvalPolicy: this.codexApprovalPolicy,
      threadSandbox: this.codexThreadSandbox,
      turnSandboxPolicy: this.codexTurnSandboxPolicy(workspace),
    };
  }

  get claudeModel(): string {
    return this.config.claude.model;
  }

  get claudeMaxTokens(): number {
    return this.config.claude.max_tokens;
  }

  get claudeApiKey(): string | undefined {
    return resolveEnvValue(this.config.claude.api_key, process.env.ANTHROPIC_API_KEY);
  }

  get claudeOAuthToken(): string | undefined {
    return resolveEnvValue(this.config.claude.oauth_token, process.env.CLAUDE_CODE_OAUTH_TOKEN);
  }

  get claudePermissionMode(): "default" | "acceptEdits" | "bypassPermissions" {
    return this.config.claude.permission_mode;
  }

  get claudeSystemPrompt(): string | undefined {
    return this.config.claude.system_prompt;
  }

  get workflowPrompt(): string {
    const loaded = this.workflow.current();
    const prompt = loaded?.promptTemplate?.trim();
    return prompt || DEFAULT_PROMPT_TEMPLATE;
  }

  get serverPort(): number {
    return this.config.server.port;
  }

  get serverHost(): string {
    return this.config.server.host;
  }

  validate(): void {
    const kind = this.trackerKind;
    if (!kind) throw new Error("Missing tracker.kind in WORKFLOW.md");
    if (!["linear", "jira", "memory"].includes(kind)) {
      throw new Error(`Unsupported tracker.kind: ${kind}`);
    }
    if (kind === "linear") {
      if (!this.linearApiToken) throw new Error("Missing LINEAR_API_KEY");
      if (!this.linearProjectSlug) throw new Error("Missing tracker.project_slug");
    }
    if (kind === "jira") {
      if (!this.jiraApiToken) throw new Error("Missing JIRA_API_KEY");
      if (!this.jiraEndpoint) throw new Error("Missing tracker.endpoint for Jira");
      if (!this.jiraProjectKey) throw new Error("Missing tracker.project_slug for Jira");
    }
    if (!this.codexCommand.trim() && this.agentProvider === "codex") {
      throw new Error("Missing codex.command");
    }
    if (this.agentProvider === "claude" && !this.claudeApiKey && !this.claudeOAuthToken) {
      throw new Error("Missing ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN for Claude provider");
    }
  }
}

function resolveEnvValue(
  configValue: string | undefined,
  envFallback: string | undefined,
): string | undefined {
  if (!configValue) return envFallback?.trim() || undefined;
  const trimmed = configValue.trim();
  const envMatch = trimmed.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (envMatch) {
    const val = process.env[envMatch[1]!];
    return val?.trim() || envFallback?.trim() || undefined;
  }
  return trimmed || undefined;
}

function resolvePath(value: string, fallback: string): string {
  if (!value) return fallback;
  let resolved = value.trim();
  const envMatch = resolved.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (envMatch) {
    const envVal = process.env[envMatch[1]!];
    if (!envVal) return fallback;
    resolved = envVal;
  }
  if (resolved.startsWith("~/")) {
    resolved = path.join(os.homedir(), resolved.slice(2));
  }
  return path.resolve(resolved) || fallback;
}
