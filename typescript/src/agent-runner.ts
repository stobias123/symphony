import type { AgentProvider, AgentMessage, TurnResult } from "./providers/types.js";
import type { Tracker, Issue } from "./trackers/types.js";
import type { Config } from "./config.js";
import { Workspace } from "./workspace.js";
import { buildPrompt, buildContinuationPrompt } from "./prompt-builder.js";
import { logger } from "./logger.js";

export interface AgentRunResult {
  issueId: string;
  identifier: string;
  turns: number;
  lastTurnResult?: TurnResult;
}

export interface AgentRunOptions {
  maxTurns?: number;
  attempt?: number;
  onMessage?: (message: AgentMessage) => void;
  issueStateFetcher?: (ids: string[]) => Promise<Issue[]>;
}

export class AgentRunner {
  private config: Config;
  private provider: AgentProvider;
  private tracker: Tracker;
  private workspace: Workspace;

  constructor(
    config: Config,
    provider: AgentProvider,
    tracker: Tracker,
    workspace?: Workspace,
  ) {
    this.config = config;
    this.provider = provider;
    this.tracker = tracker;
    this.workspace = workspace ?? new Workspace(config);
  }

  async run(issue: Issue, opts: AgentRunOptions = {}): Promise<AgentRunResult> {
    const maxTurns = opts.maxTurns ?? this.config.agentMaxTurns;
    const issueStateFetcher =
      opts.issueStateFetcher ??
      ((ids: string[]) => this.tracker.fetchIssueStatesByIds(ids));

    logger.info(
      { issueId: issue.id, identifier: issue.identifier },
      "Starting agent run",
    );

    const workspacePath = await this.workspace.createForIssue(issue);

    try {
      await this.workspace.runBeforeRunHook(workspacePath, issue);

      const sessionConfig = this.config.codexRuntimeSettings(workspacePath);
      const session = await this.provider.startSession(workspacePath, sessionConfig);

      try {
        let turnNumber = 1;
        let lastResult: TurnResult | undefined;

        while (turnNumber <= maxTurns) {
          const prompt =
            turnNumber === 1
              ? buildPrompt(issue, this.config, { attempt: opts.attempt })
              : buildContinuationPrompt(turnNumber, maxTurns);

          opts.onMessage?.({
            event: "turn_started",
            timestamp: new Date(),
            turnNumber,
          } as AgentMessage & { turnNumber: number });

          lastResult = await this.provider.runTurn(session, prompt, issue, {
            onMessage: opts.onMessage,
          });

          // Forward turn-level usage to the orchestrator
          if (lastResult.usage && opts.onMessage) {
            opts.onMessage({
              event: "turn_usage",
              timestamp: new Date(),
              usage: lastResult.usage,
            });
          }

          logger.info(
            {
              issueId: issue.id,
              identifier: issue.identifier,
              sessionId: lastResult.sessionId,
              turn: `${turnNumber}/${maxTurns}`,
            },
            "Completed agent turn",
          );

          if (turnNumber >= maxTurns) break;

          // Check if issue is still active
          const continuationResult = await checkIssueContinuation(
            issue,
            issueStateFetcher,
            this.config.trackerActiveStates,
          );

          if (continuationResult.action === "done") break;

          // Update issue reference for next turn
          if (continuationResult.refreshedIssue) {
            issue = continuationResult.refreshedIssue;
          }

          logger.info(
            {
              issueId: issue.id,
              identifier: issue.identifier,
              turn: `${turnNumber}/${maxTurns}`,
            },
            "Continuing agent run after normal turn completion",
          );

          turnNumber++;
        }

        return {
          issueId: issue.id,
          identifier: issue.identifier,
          turns: turnNumber,
          lastTurnResult: lastResult,
        };
      } finally {
        await this.provider.stopSession(session);
      }
    } finally {
      await this.workspace.runAfterRunHook(workspacePath, issue);
    }
  }
}

interface ContinuationResult {
  action: "continue" | "done";
  refreshedIssue?: Issue;
}

async function checkIssueContinuation(
  issue: Issue,
  fetcher: (ids: string[]) => Promise<Issue[]>,
  activeStates: string[],
): Promise<ContinuationResult> {
  try {
    const refreshed = await fetcher([issue.id]);
    if (refreshed.length === 0) {
      return { action: "done" };
    }

    const refreshedIssue = refreshed[0]!;
    const normalizedState = refreshedIssue.state.trim().toLowerCase();
    const isActive = activeStates.some(
      (s) => s.trim().toLowerCase() === normalizedState,
    );

    return isActive
      ? { action: "continue", refreshedIssue }
      : { action: "done", refreshedIssue };
  } catch (err) {
    logger.error({ err, issueId: issue.id }, "Failed to refresh issue state");
    return { action: "done" };
  }
}
