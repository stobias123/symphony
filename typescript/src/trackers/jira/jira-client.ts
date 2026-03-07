import type { Issue, Blocker } from "../types.js";
import type { Config } from "../../config.js";
import { logger } from "../../logger.js";

const PAGE_SIZE = 50;

export class JiraClient {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    const projectKey = this.config.jiraProjectKey;
    if (!projectKey) throw new Error("Missing Jira project key");

    const states = this.config.trackerActiveStates;
    const jql = buildJql(projectKey, states, this.config.jiraAssignee, this.config.jiraLabels);
    return this.searchIssues(jql);
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const projectKey = this.config.jiraProjectKey;
    if (!projectKey) throw new Error("Missing Jira project key");

    const jql = buildJql(projectKey, states, undefined, this.config.jiraLabels);
    return this.searchIssues(jql);
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    if (issueIds.length === 0) return [];

    const idList = issueIds.map((id) => `"${id}"`).join(",");
    const jql = `id in (${idList}) ORDER BY priority ASC, updated DESC`;
    return this.searchIssues(jql);
  }

  async addComment(issueId: string, body: string): Promise<void> {
    const endpoint = this.config.jiraEndpoint;
    if (!endpoint) throw new Error("Missing Jira endpoint");

    await this.request(`${endpoint}/rest/api/3/issue/${issueId}/comment`, {
      method: "POST",
      body: JSON.stringify(toAdfComment(body)),
    });
  }

  async transitionIssue(issueId: string, stateName: string): Promise<void> {
    const endpoint = this.config.jiraEndpoint;
    if (!endpoint) throw new Error("Missing Jira endpoint");

    const transitionsUrl = `${endpoint}/rest/api/3/issue/${issueId}/transitions`;
    const response = await this.request(transitionsUrl);
    const data = (await response.json()) as {
      transitions: Array<{ id: string; to: { name: string } }>;
    };

    const normalizedTarget = stateName.trim().toLowerCase();
    const transition = data.transitions.find(
      (t) => t.to.name.trim().toLowerCase() === normalizedTarget,
    );

    if (!transition) {
      throw new Error(
        `No transition to "${stateName}" found for issue ${issueId}. Available: ${data.transitions.map((t) => t.to.name).join(", ")}`,
      );
    }

    await this.request(transitionsUrl, {
      method: "POST",
      body: JSON.stringify({ transition: { id: transition.id } }),
    });
  }

  private async searchIssues(jql: string): Promise<Issue[]> {
    const endpoint = this.config.jiraEndpoint;
    if (!endpoint) throw new Error("Missing Jira endpoint");

    logger.debug({ jql }, "Jira search");

    const issues: Issue[] = [];
    let startAt = 0;
    const fields = [
      "summary", "description", "priority", "status",
      "assignee", "created", "updated", "labels", "issuelinks",
    ];

    while (true) {
      const url = new URL(`${endpoint}/rest/api/3/search/jql`);
      url.searchParams.set("jql", jql);
      url.searchParams.set("startAt", String(startAt));
      url.searchParams.set("maxResults", String(PAGE_SIZE));
      url.searchParams.set("fields", fields.join(","));

      const response = await this.request(url.toString());
      const data = (await response.json()) as Record<string, unknown>;

      // The new /search/jql endpoint may return issues at top level or nested
      const rawIssues = (data.issues ?? []) as Array<Record<string, unknown>>;
      const total = data.total as number | undefined;

      logger.debug(
        { total, returned: rawIssues.length, startAt, keys: Object.keys(data) },
        "Jira search results",
      );

      for (const raw of rawIssues) {
        issues.push(normalizeJiraIssue(raw));
      }

      // Stop if: no results returned, or we've fetched all, or total is unknown
      if (rawIssues.length === 0) break;
      if (total !== undefined && startAt + rawIssues.length >= total) break;
      if (rawIssues.length < PAGE_SIZE) break;
      startAt += rawIssues.length;
    }

    return issues;
  }

  private async request(
    url: string,
    init?: RequestInit,
    retries = 3,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...this.authHeaders(),
    };

    const response = await fetch(url, {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string>) },
    });

    if (response.status === 429 && retries > 0) {
      const retryAfter = response.headers.get("Retry-After");
      const waitMs = retryAfter
        ? (parseInt(retryAfter, 10) || 10) * 1000
        : 10_000;
      logger.warn(
        { url, retryAfter, waitMs, retriesLeft: retries },
        "Jira rate limited, backing off",
      );
      await sleep(waitMs);
      return this.request(url, init, retries - 1);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Jira API error: ${response.status} ${response.statusText} - ${body}`);
    }

    return response;
  }

  private authHeaders(): Record<string, string> {
    const email = this.config.jiraEmail;
    const token = this.config.jiraApiToken;
    if (!token) throw new Error("Missing Jira API token");

    if (email) {
      const encoded = Buffer.from(`${email}:${token}`).toString("base64");
      return { Authorization: `Basic ${encoded}` };
    }
    return { Authorization: `Bearer ${token}` };
  }
}

function buildJql(projectKey: string, states: string[], assignee?: string, labels?: string[]): string {
  const stateList = states.map((s) => `"${s}"`).join(",");
  let jql = `project = "${projectKey}" AND status in (${stateList})`;

  if (assignee) {
    const assigneeValue =
      assignee.toLowerCase() === "me" ? "currentUser()" : `"${assignee}"`;
    jql += ` AND assignee = ${assigneeValue}`;
  }

  if (labels && labels.length > 0) {
    const labelClauses = labels.map((l) => `labels = "${l}"`).join(" OR ");
    jql += labels.length === 1 ? ` AND ${labelClauses}` : ` AND (${labelClauses})`;
  }

  jql += " ORDER BY priority ASC, updated DESC";
  return jql;
}

function normalizeJiraIssue(raw: Record<string, unknown>): Issue {
  const fields = raw.fields as Record<string, unknown>;
  const status = fields?.status as Record<string, unknown>;
  const priority = fields?.priority as Record<string, unknown>;
  const assignee = fields?.assignee as Record<string, unknown>;
  const labels = (fields?.labels as string[]) ?? [];
  const issuelinks = (fields?.issuelinks as Array<Record<string, unknown>>) ?? [];

  return {
    id: raw.id as string,
    identifier: raw.key as string,
    title: (fields?.summary as string) ?? "",
    description: extractAdfText(fields?.description),
    priority: priorityToNumber(priority?.name as string),
    state: (status?.name as string) ?? "",
    branchName: null,
    url: (raw.self as string) ?? null,
    assigneeId: (assignee?.accountId as string) ?? null,
    blockedBy: extractJiraBlockers(issuelinks),
    labels: labels.map((l) => l.toLowerCase()),
    assignedToWorker: true,
    createdAt: fields?.created ? new Date(fields.created as string) : null,
    updatedAt: fields?.updated ? new Date(fields.updated as string) : null,
  };
}

function extractAdfText(description: unknown): string | null {
  if (!description || typeof description !== "object") return null;

  const doc = description as Record<string, unknown>;
  const content = doc.content as Array<Record<string, unknown>>;
  if (!Array.isArray(content)) return null;

  const texts: string[] = [];
  function walk(nodes: Array<Record<string, unknown>>): void {
    for (const node of nodes) {
      if (node.type === "text" && typeof node.text === "string") {
        texts.push(node.text);
      }
      if (Array.isArray(node.content)) {
        walk(node.content as Array<Record<string, unknown>>);
      }
    }
  }
  walk(content);

  return texts.length > 0 ? texts.join("") : null;
}

function extractJiraBlockers(links: Array<Record<string, unknown>>): Blocker[] {
  return links
    .filter((link) => {
      const type = link.type as Record<string, unknown>;
      const inward = (type?.inward as string) ?? "";
      return inward.toLowerCase().includes("blocked by");
    })
    .map((link) => {
      const inwardIssue = link.inwardIssue as Record<string, unknown>;
      if (!inwardIssue) return null;
      const fields = inwardIssue.fields as Record<string, unknown>;
      const status = fields?.status as Record<string, unknown>;
      return {
        id: inwardIssue.id as string,
        identifier: inwardIssue.key as string,
        state: (status?.name as string) ?? "",
      };
    })
    .filter((b): b is Blocker => b !== null && !!b.id);
}

function priorityToNumber(name: string | undefined): number | null {
  if (!name) return null;
  const map: Record<string, number> = {
    highest: 1,
    high: 2,
    medium: 3,
    low: 4,
    lowest: 5,
  };
  return map[name.toLowerCase()] ?? null;
}

function toAdfComment(text: string): Record<string, unknown> {
  return {
    body: {
      version: 1,
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text }],
        },
      ],
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
