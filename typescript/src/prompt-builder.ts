import { Liquid } from "liquidjs";
import type { Issue } from "./trackers/types.js";
import type { Config } from "./config.js";

const engine = new Liquid({ strictVariables: true, strictFilters: true });

export function buildPrompt(issue: Issue, config: Config, opts?: { attempt?: number }): string {
  const template = config.workflowPrompt;

  const issueMap: Record<string, unknown> = {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: issue.state,
    branch_name: issue.branchName,
    url: issue.url,
    assignee_id: issue.assigneeId,
    labels: issue.labels,
    created_at: issue.createdAt?.toISOString() ?? null,
    updated_at: issue.updatedAt?.toISOString() ?? null,
  };

  return engine.parseAndRenderSync(template, {
    issue: issueMap,
    attempt: opts?.attempt ?? null,
  });
}

export function buildContinuationPrompt(turnNumber: number, maxTurns: number): string {
  return `Continuation guidance:

- The previous turn completed normally, but the issue is still in an active state.
- This is continuation turn #${turnNumber} of ${maxTurns} for the current agent run.
- Resume from the current workspace and workpad state instead of restarting from scratch.
- The original task instructions and prior turn context are already present in this thread, so do not restate them before acting.
- Focus on the remaining ticket work and do not end the turn while the issue stays active unless you are truly blocked.
`;
}
