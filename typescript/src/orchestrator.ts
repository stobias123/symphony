import type { AgentProvider, AgentMessage, TokenUsage, ContentMessage } from "./providers/types.js";
import type { Tracker, Issue } from "./trackers/types.js";
import type { Config } from "./config.js";
import type { SessionStore, CumulativeTotals } from "./session-store.js";
import { AgentRunner } from "./agent-runner.js";
import { Workspace } from "./workspace.js";
import { estimateCost } from "./pricing.js";
import { logger } from "./logger.js";

export interface SessionMessage {
  timestamp: string;
  event: string;
  detail?: string;
}

const MAX_SESSION_MESSAGES = 50;

function summarizeMessageDetail(msg: AgentMessage & { turnNumber?: number }): string | undefined {
  const payload = msg.payload as Record<string, unknown> | undefined;
  switch (msg.event) {
    case "session_started":
      return msg.sessionId ?? undefined;
    case "turn_started":
    case "turn_completed":
    case "turn_failed":
      return typeof msg.turnNumber === "number" ? `turn ${msg.turnNumber}` : undefined;
    case "tool_call_started":
    case "tool_call_completed":
    case "tool_call_failed":
      return (payload?.toolName ?? payload?.tool_name ?? payload?.name) as string | undefined;
    case "approval_auto_approved":
      return (payload?.decision ?? payload?.status) as string | undefined;
    case "assistant_message": {
      const text = (payload?.text ?? payload?.content ?? msg.raw) as string | undefined;
      return text ? text.slice(0, 120) : undefined;
    }
    case "notification":
      return (payload?.method ?? payload?.type) as string | undefined;
    case "usage_update": {
      const u = msg.usage ?? (payload as TokenUsage | undefined);
      if (u?.inputTokens != null || u?.outputTokens != null) {
        return `in:${u.inputTokens ?? 0} out:${u.outputTokens ?? 0}`;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

interface RunningEntry {
  issueId: string;
  identifier: string;
  state: string;
  title: string;
  startedAt: Date;
  lastActivityAt: Date;
  abortController: AbortController;
  promise: Promise<void>;
  totalUsage: TokenUsage;
  turnNumber: number;
  lastEvent: string;
  stage: "running" | "retrying" | "starting";
  messages: SessionMessage[];
  contentMessages: ContentMessage[];
  persisted: boolean;
}

const MAX_CONTENT_MESSAGES = 500;

interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  error?: string;
  timer: ReturnType<typeof setTimeout>;
}

export interface OrchestratorSnapshot {
  running: Array<{
    issueId: string;
    identifier: string;
    state: string;
    title: string;
    startedAt: Date;
    lastActivityAt: Date;
    usage: TokenUsage;
    turnNumber: number;
    lastEvent: string;
    stage: "running" | "retrying" | "starting";
    messages: SessionMessage[];
    estimatedCostUsd: number;
  }>;
  retrying: Array<{
    issueId: string;
    identifier: string;
    attempt: number;
    dueAtMs: number;
    error?: string;
  }>;
  codexTotals: TokenUsage;
  cumulativeTotals: CumulativeTotals;
  totalCostUsd: number;
  polling: { intervalMs: number; maxAgents: number; nextPollAtMs: number; inProgress: boolean };
  startedAt: Date;
  provider: string;
}

export class Orchestrator {
  private config: Config;
  private tracker: Tracker;
  private provider: AgentProvider;
  private runner: AgentRunner;
  private workspace: Workspace;
  private sessionStore?: SessionStore;

  private running = new Map<string, RunningEntry>();
  private completed = new Set<string>();
  private retryAttempts = new Map<string, RetryEntry>();
  private codexTotals: TokenUsage = {};

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollInProgress = false;
  private stopped = false;
  private orchestratorStartedAt = new Date();
  private nextPollAtMs = 0;

  constructor(
    config: Config,
    tracker: Tracker,
    provider: AgentProvider,
    sessionStore?: SessionStore,
  ) {
    this.config = config;
    this.tracker = tracker;
    this.provider = provider;
    this.sessionStore = sessionStore;
    this.workspace = new Workspace(config);
    this.runner = new AgentRunner(config, provider, tracker, this.workspace);

    // Hydrate completed set from DB
    if (this.sessionStore) {
      const completedIds = this.sessionStore.getCompletedIssueIds();
      for (const id of completedIds) {
        this.completed.add(id);
      }
      logger.info({ count: completedIds.size }, "Hydrated completed issues from DB");
    }
  }

  start(): void {
    logger.info(
      {
        provider: this.provider.name,
        tracker: this.config.trackerKind,
        pollIntervalMs: this.config.pollIntervalMs,
        maxAgents: this.config.maxConcurrentAgents,
      },
      "Orchestrator starting",
    );

    this.stopped = false;
    this.schedulePoll(0);
  }

  stop(): void {
    this.stopped = true;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Cancel all retry timers
    for (const [, entry] of this.retryAttempts) {
      clearTimeout(entry.timer);
    }
    this.retryAttempts.clear();

    // Persist all running sessions before aborting (they won't get a chance to persist in .catch)
    for (const [, entry] of this.running) {
      this.persistSession(entry, "aborted");
      entry.abortController.abort();
    }
    this.running.clear();

    logger.info("Orchestrator stopped");
  }

  snapshot(): OrchestratorSnapshot {
    const cumulativeTotals = this.sessionStore?.getCumulativeTotals() ?? {
      sessionCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
      cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0,
    };

    const model = this.config.claudeModel ?? "";
    const runningEntries = Array.from(this.running.values()).map((e) => {
      const entryCost = e.totalUsage.costUsd ?? estimateCost(model, {
        inputTokens: e.totalUsage.inputTokens,
        outputTokens: e.totalUsage.outputTokens,
        cacheReadTokens: e.totalUsage.cacheReadTokens,
        cacheCreateTokens: e.totalUsage.cacheCreateTokens,
      });
      return {
        issueId: e.issueId,
        identifier: e.identifier,
        state: e.state,
        title: e.title,
        startedAt: e.startedAt,
        lastActivityAt: e.lastActivityAt,
        usage: { ...e.totalUsage },
        turnNumber: e.turnNumber,
        lastEvent: e.lastEvent,
        stage: e.stage,
        messages: [...e.messages],
        estimatedCostUsd: entryCost,
      };
    });

    const runningCostSum = runningEntries.reduce((sum, e) => sum + e.estimatedCostUsd, 0);
    // codexTotals = sum of currently-running session tokens (not cumulative across process lifetime)
    const runningTotals: TokenUsage = {};
    for (const e of runningEntries) {
      runningTotals.inputTokens = (runningTotals.inputTokens ?? 0) + (e.usage.inputTokens ?? 0);
      runningTotals.outputTokens = (runningTotals.outputTokens ?? 0) + (e.usage.outputTokens ?? 0);
      runningTotals.totalTokens = (runningTotals.totalTokens ?? 0) + (e.usage.totalTokens ?? 0);
    }

    return {
      running: runningEntries,
      retrying: Array.from(this.retryAttempts.values()).map((e) => ({
        issueId: e.issueId,
        identifier: e.identifier,
        attempt: e.attempt,
        dueAtMs: e.dueAtMs,
        error: e.error,
      })),
      codexTotals: runningTotals,
      cumulativeTotals,
      totalCostUsd: cumulativeTotals.costUsd + runningCostSum,
      polling: {
        intervalMs: this.config.pollIntervalMs,
        maxAgents: this.config.maxConcurrentAgents,
        nextPollAtMs: this.nextPollAtMs,
        inProgress: this.pollInProgress,
      },
      startedAt: this.orchestratorStartedAt,
      provider: this.provider.name,
    };
  }

  getContentMessages(identifier: string): ContentMessage[] | null {
    for (const entry of this.running.values()) {
      if (entry.identifier === identifier) {
        return [...entry.contentMessages];
      }
    }
    return null;
  }

  requestRefresh(): void {
    if (!this.stopped && !this.pollInProgress) {
      this.schedulePoll(0);
    }
  }

  private schedulePoll(delayMs: number): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.nextPollAtMs = Date.now() + delayMs;
    this.pollTimer = setTimeout(() => this.runPollCycle(), delayMs);
  }

  private async runPollCycle(): Promise<void> {
    if (this.stopped || this.pollInProgress) return;
    this.pollInProgress = true;

    try {
      // Refresh config for hot-reload
      this.config.reload();

      // Reconcile running issues
      await this.reconcileRunning();

      // Detect stalled agents
      this.detectStalls();

      // Fetch candidates and dispatch
      const candidates = await this.tracker.fetchCandidateIssues();
      logger.debug(
        {
          candidateCount: candidates.length,
          candidates: candidates.map((c) => ({
            id: c.id,
            identifier: c.identifier,
            state: c.state,
            assignedToWorker: c.assignedToWorker,
            title: c.title?.slice(0, 40),
          })),
        },
        "Fetched candidates",
      );
      const eligible = this.filterAndSortCandidates(candidates);
      logger.debug(
        { eligibleCount: eligible.length, runningCount: this.running.size },
        "Filtered candidates",
      );
      this.dispatch(eligible);
    } catch (err) {
      logger.error({ err }, "Poll cycle error");
    } finally {
      this.pollInProgress = false;
      if (!this.stopped) {
        this.schedulePoll(this.config.pollIntervalMs);
      }
    }
  }

  private async reconcileRunning(): Promise<void> {
    if (this.running.size === 0) return;

    const runningIds = Array.from(this.running.keys());
    try {
      const refreshed = await this.tracker.fetchIssueStatesByIds(runningIds);
      const refreshedMap = new Map(refreshed.map((i) => [i.id, i]));

      for (const [issueId, entry] of this.running) {
        const issue = refreshedMap.get(issueId);
        if (!issue) continue;

        // Update state
        entry.state = issue.state;

        // Check if terminal
        const normalizedState = issue.state.trim().toLowerCase();
        const isTerminal = this.config.trackerTerminalStates.some(
          (s) => s.trim().toLowerCase() === normalizedState,
        );
        const isActive = this.config.trackerActiveStates.some(
          (s) => s.trim().toLowerCase() === normalizedState,
        );

        if (isTerminal || !isActive) {
          logger.info(
            { issueId, identifier: entry.identifier, state: issue.state },
            "Issue moved to terminal/inactive state, stopping agent",
          );
          entry.abortController.abort();
          await this.workspace.removeIssueWorkspaces(entry.identifier);
        }

        // Check assignee change
        if (!issue.assignedToWorker) {
          logger.info(
            { issueId, identifier: entry.identifier },
            "Issue reassigned, stopping agent",
          );
          entry.abortController.abort();
        }
      }
    } catch (err) {
      logger.warn({ err }, "Failed to reconcile running issues");
    }
  }

  private detectStalls(): void {
    const stallTimeoutMs = this.config.codexStallTimeoutMs;
    if (stallTimeoutMs <= 0) return;

    const now = Date.now();

    for (const [issueId, entry] of this.running) {
      const elapsed = now - entry.lastActivityAt.getTime();
      if (elapsed > stallTimeoutMs) {
        logger.warn(
          {
            issueId,
            identifier: entry.identifier,
            elapsedMs: elapsed,
            stallTimeoutMs,
          },
          "Agent stall detected, restarting",
        );
        entry.abortController.abort();
        this.scheduleRetry(issueId, entry.identifier, 1, "stall_timeout");
      }
    }
  }

  private filterAndSortCandidates(candidates: Issue[]): Issue[] {
    const claimedIds = new Set([
      ...this.running.keys(),
      ...this.retryAttempts.keys(),
      ...this.completed,
    ]);

    const terminalStates = this.config.trackerTerminalStates.map((s) =>
      s.trim().toLowerCase(),
    );
    const activeStates = this.config.trackerActiveStates.map((s) =>
      s.trim().toLowerCase(),
    );

    const eligible = candidates.filter((issue) => {
      if (claimedIds.has(issue.id)) return false;
      if (!issue.id || !issue.identifier || !issue.title) return false;
      if (!issue.assignedToWorker) return false;

      const normalizedState = issue.state.trim().toLowerCase();
      if (terminalStates.includes(normalizedState)) return false;
      if (!activeStates.includes(normalizedState)) return false;

      // Check blockers - Todo issues blocked by non-terminal issues should be skipped
      if ((normalizedState === "todo" || normalizedState === "to do") && issue.blockedBy.length > 0) {
        const hasActiveBlocker = issue.blockedBy.some(
          (b) => !terminalStates.includes(b.state.trim().toLowerCase()),
        );
        if (hasActiveBlocker) return false;
      }

      return true;
    });

    // Sort: priority asc (null=5), createdAt asc, identifier asc
    eligible.sort((a, b) => {
      const pa = a.priority ?? 5;
      const pb = b.priority ?? 5;
      if (pa !== pb) return pa - pb;

      const ca = a.createdAt?.getTime() ?? 0;
      const cb = b.createdAt?.getTime() ?? 0;
      if (ca !== cb) return ca - cb;

      return a.identifier.localeCompare(b.identifier);
    });

    return eligible;
  }

  private dispatch(candidates: Issue[]): void {
    const globalSlots =
      this.config.maxConcurrentAgents - this.running.size;

    let dispatched = 0;

    for (const issue of candidates) {
      if (dispatched >= globalSlots) break;

      // Per-state limit check
      const stateLimit = this.config.maxConcurrentAgentsForState(issue.state);
      const currentForState = Array.from(this.running.values()).filter(
        (e) => e.state.trim().toLowerCase() === issue.state.trim().toLowerCase(),
      ).length;
      if (currentForState >= stateLimit) continue;

      this.startAgent(issue);
      dispatched++;
    }

    if (dispatched > 0) {
      logger.info({ dispatched, total: this.running.size }, "Dispatched agents");
    }
  }

  private startAgent(issue: Issue, attempt = 1): void {
    const abortController = new AbortController();
    const now = new Date();

    const entry: RunningEntry = {
      issueId: issue.id,
      identifier: issue.identifier,
      state: issue.state,
      title: issue.title,
      startedAt: now,
      lastActivityAt: now,
      abortController,
      promise: Promise.resolve(),
      totalUsage: {},
      turnNumber: attempt,
      lastEvent: "starting",
      stage: attempt > 1 ? "retrying" : "starting",
      messages: [],
      contentMessages: [],
      persisted: false,
    };

    const onMessage = (msg: AgentMessage & { turnNumber?: number }) => {
      entry.lastActivityAt = new Date();
      entry.stage = "running";
      if (msg.event) {
        entry.lastEvent = msg.event;
        entry.messages.push({
          timestamp: msg.timestamp.toISOString(),
          event: msg.event,
          detail: summarizeMessageDetail(msg),
        });
        if (entry.messages.length > MAX_SESSION_MESSAGES) entry.messages.shift();
      }
      // Capture content messages for session detail view
      if (msg.event === "assistant_message" && msg.fullText) {
        entry.contentMessages.push({
          role: "assistant",
          timestamp: msg.timestamp.toISOString(),
          text: msg.fullText as string,
        });
        if (entry.contentMessages.length > MAX_CONTENT_MESSAGES) entry.contentMessages.shift();
      } else if (msg.event === "tool_use") {
        entry.contentMessages.push({
          role: "tool_use",
          timestamp: msg.timestamp.toISOString(),
          toolName: msg.toolName as string,
          toolInput: msg.toolInput as string,
        });
        if (entry.contentMessages.length > MAX_CONTENT_MESSAGES) entry.contentMessages.shift();
      }

      if (typeof msg.turnNumber === "number") {
        entry.turnNumber = msg.turnNumber;
      }
      if (msg.usage) {
        this.accumulateUsage(entry, msg.usage);
      }
    };

    const promise = this.runner
      .run(issue, {
        attempt,
        onMessage,
        maxTurns: this.config.agentMaxTurns,
      })
      .then(() => {
        logger.info(
          { issueId: issue.id, identifier: issue.identifier },
          "Agent completed",
        );
        this.persistSession(entry, "completed");
        this.running.delete(issue.id);
        this.completed.add(issue.id);
      })
      .catch((err) => {
        if (abortController.signal.aborted) {
          logger.info(
            { issueId: issue.id, identifier: issue.identifier },
            "Agent aborted",
          );
          this.persistSession(entry, "aborted");
        } else {
          logger.error(
            { err, issueId: issue.id, identifier: issue.identifier },
            "Agent failed",
          );
          this.persistSession(entry, "failed");
          this.scheduleRetry(issue.id, issue.identifier, attempt + 1, String(err));
        }
        this.running.delete(issue.id);
      });

    entry.promise = promise;
    this.running.set(issue.id, entry);
  }

  private scheduleRetry(
    issueId: string,
    identifier: string,
    attempt: number,
    error?: string,
  ): void {
    // Clean up existing retry
    const existing = this.retryAttempts.get(issueId);
    if (existing) clearTimeout(existing.timer);

    // Exponential backoff: continuation=1s, failure=10s*2^(attempt-1)
    const isFirstRetry = attempt <= 1;
    const delayMs = isFirstRetry
      ? 1_000
      : Math.min(10_000 * Math.pow(2, attempt - 2), this.config.maxRetryBackoffMs);

    const dueAtMs = Date.now() + delayMs;

    const timer = setTimeout(async () => {
      this.retryAttempts.delete(issueId);

      // Re-validate issue state before retrying
      try {
        const refreshed = await this.tracker.fetchIssueStatesByIds([issueId]);
        if (refreshed.length === 0) return;

        const issue = refreshed[0]!;
        const normalizedState = issue.state.trim().toLowerCase();
        const isActive = this.config.trackerActiveStates.some(
          (s) => s.trim().toLowerCase() === normalizedState,
        );

        if (isActive && issue.assignedToWorker) {
          logger.info(
            { issueId, identifier, attempt },
            "Retrying agent",
          );
          this.startAgent(issue, attempt);
        }
      } catch (err) {
        logger.error({ err, issueId }, "Retry validation failed");
      }
    }, delayMs);

    timer.unref();

    this.retryAttempts.set(issueId, {
      issueId,
      identifier,
      attempt,
      dueAtMs,
      error,
      timer,
    });

    logger.info(
      { issueId, identifier, attempt, delayMs },
      "Scheduled retry",
    );
  }

  private accumulateUsage(entry: RunningEntry, usage: TokenUsage): void {
    entry.totalUsage.inputTokens =
      (entry.totalUsage.inputTokens ?? 0) + (usage.inputTokens ?? 0);
    entry.totalUsage.outputTokens =
      (entry.totalUsage.outputTokens ?? 0) + (usage.outputTokens ?? 0);
    entry.totalUsage.totalTokens =
      (entry.totalUsage.totalTokens ?? 0) + (usage.totalTokens ?? 0);
    entry.totalUsage.cacheReadTokens =
      (entry.totalUsage.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0);
    entry.totalUsage.cacheCreateTokens =
      (entry.totalUsage.cacheCreateTokens ?? 0) + (usage.cacheCreateTokens ?? 0);
    if (usage.costUsd != null) {
      entry.totalUsage.costUsd = (entry.totalUsage.costUsd ?? 0) + usage.costUsd;
    }

    this.codexTotals.inputTokens =
      (this.codexTotals.inputTokens ?? 0) + (usage.inputTokens ?? 0);
    this.codexTotals.outputTokens =
      (this.codexTotals.outputTokens ?? 0) + (usage.outputTokens ?? 0);
    this.codexTotals.totalTokens =
      (this.codexTotals.totalTokens ?? 0) + (usage.totalTokens ?? 0);
  }

  private persistSession(
    entry: RunningEntry,
    outcome: "completed" | "failed" | "aborted",
  ): void {
    if (!this.sessionStore) return;
    if (entry.persisted) return;
    entry.persisted = true;

    const model = this.config.claudeModel ?? "";
    const costUsd = entry.totalUsage.costUsd ?? estimateCost(model, {
      inputTokens: entry.totalUsage.inputTokens,
      outputTokens: entry.totalUsage.outputTokens,
      cacheReadTokens: entry.totalUsage.cacheReadTokens,
      cacheCreateTokens: entry.totalUsage.cacheCreateTokens,
    });

    try {
      this.sessionStore.insertSession({
        issueId: entry.issueId,
        identifier: entry.identifier,
        title: entry.title,
        state: entry.state,
        outcome,
        model: model || undefined,
        startedAt: entry.startedAt.toISOString(),
        endedAt: new Date().toISOString(),
        turns: entry.turnNumber,
        inputTokens: entry.totalUsage.inputTokens ?? 0,
        outputTokens: entry.totalUsage.outputTokens ?? 0,
        totalTokens: entry.totalUsage.totalTokens ?? 0,
        cacheReadTokens: entry.totalUsage.cacheReadTokens ?? 0,
        cacheCreateTokens: entry.totalUsage.cacheCreateTokens ?? 0,
        costUsd,
        messages: [...entry.messages],
      }, entry.contentMessages);
      logger.info(
        { issueId: entry.issueId, identifier: entry.identifier, outcome, costUsd },
        "Session persisted to DB",
      );
    } catch (err) {
      logger.error({ err, issueId: entry.issueId }, "Failed to persist session");
    }
  }
}
