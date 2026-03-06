import type { Issue, Blocker } from "../types.js";
import type { Config } from "../../config.js";
import { logger } from "../../logger.js";

const PAGE_SIZE = 50;

interface GraphQLResponse {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string }>;
}

export class LinearClient {
  private config: Config;
  private viewerIdCache: string | null = null;

  constructor(config: Config) {
    this.config = config;
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    const slug = this.config.linearProjectSlug;
    if (!slug) throw new Error("Missing linear project slug");

    const states = this.config.trackerActiveStates;
    const issues = await this.fetchProjectIssues(slug, states);
    return this.filterByAssignee(issues);
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const slug = this.config.linearProjectSlug;
    if (!slug) throw new Error("Missing linear project slug");
    return this.fetchProjectIssues(slug, states);
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    if (issueIds.length === 0) return [];

    const query = `
      query($ids: [String!]!) {
        issues(filter: { id: { in: $ids } }) {
          nodes {
            id
            identifier
            title
            description
            priority
            state { name }
            branchName
            url
            assignee { id }
            createdAt
            updatedAt
            labels { nodes { name } }
            inverseRelations { nodes { type relatedIssue { id identifier state { name } } } }
          }
        }
      }
    `;

    const result = await this.graphql(query, { ids: issueIds });
    const nodes = (result?.data as Record<string, unknown>)?.issues as Record<string, unknown>;
    return ((nodes?.nodes as unknown[]) ?? []).map((n) => normalizeIssue(n as Record<string, unknown>));
  }

  async graphql(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<GraphQLResponse> {
    const token = this.config.linearApiToken;
    if (!token) throw new Error("Missing LINEAR_API_KEY");

    const response = await fetch(this.config.linearEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new Error(`Linear API error: ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as GraphQLResponse;
    if (json.errors?.length) {
      throw new Error(`Linear GraphQL error: ${json.errors.map((e) => e.message).join(", ")}`);
    }

    return json;
  }

  private async fetchProjectIssues(slug: string, states: string[]): Promise<Issue[]> {
    const issues: Issue[] = [];
    let cursor: string | null = null;

    while (true) {
      const query = `
        query($slug: String!, $states: [String!]!, $first: Int!, $after: String) {
          project(slug: $slug) {
            issues(
              filter: { state: { name: { in: $states } } }
              first: $first
              after: $after
            ) {
              nodes {
                id
                identifier
                title
                description
                priority
                state { name }
                branchName
                url
                assignee { id }
                createdAt
                updatedAt
                labels { nodes { name } }
                inverseRelations { nodes { type relatedIssue { id identifier state { name } } } }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      `;

      const result = await this.graphql(query, {
        slug,
        states,
        first: PAGE_SIZE,
        after: cursor,
      });

      const project = (result.data as Record<string, unknown>)?.project as Record<string, unknown>;
      const issuesData = project?.issues as Record<string, unknown>;
      const nodes = (issuesData?.nodes as unknown[]) ?? [];
      const pageInfo = issuesData?.pageInfo as Record<string, unknown>;

      for (const node of nodes) {
        issues.push(normalizeIssue(node as Record<string, unknown>));
      }

      if (pageInfo?.hasNextPage && pageInfo.endCursor) {
        cursor = pageInfo.endCursor as string;
      } else {
        break;
      }
    }

    return issues;
  }

  private async filterByAssignee(issues: Issue[]): Promise<Issue[]> {
    const assignee = this.config.linearAssignee;
    if (!assignee) return issues;

    let targetId: string;
    if (assignee.toLowerCase() === "me") {
      targetId = await this.resolveViewerId();
    } else {
      targetId = assignee;
    }

    return issues.map((issue) => ({
      ...issue,
      assignedToWorker: issue.assigneeId === targetId,
    }));
  }

  private async resolveViewerId(): Promise<string> {
    if (this.viewerIdCache) return this.viewerIdCache;

    const result = await this.graphql(`query { viewer { id } }`);
    const viewer = (result.data as Record<string, unknown>)?.viewer as Record<string, unknown>;
    const id = viewer?.id as string;
    if (!id) throw new Error("Could not resolve Linear viewer ID");

    this.viewerIdCache = id;
    return id;
  }
}

function normalizeIssue(node: Record<string, unknown>): Issue {
  const state = node.state as Record<string, unknown> | null;
  const assignee = node.assignee as Record<string, unknown> | null;
  const labelsData = node.labels as Record<string, unknown> | null;
  const labelNodes = (labelsData?.nodes as Array<Record<string, unknown>>) ?? [];
  const inverseRelations = node.inverseRelations as Record<string, unknown> | null;
  const relationNodes = (inverseRelations?.nodes as Array<Record<string, unknown>>) ?? [];

  return {
    id: node.id as string,
    identifier: node.identifier as string,
    title: node.title as string,
    description: (node.description as string) ?? null,
    priority: (node.priority as number) ?? null,
    state: (state?.name as string) ?? "",
    branchName: (node.branchName as string) ?? null,
    url: (node.url as string) ?? null,
    assigneeId: (assignee?.id as string) ?? null,
    blockedBy: extractBlockers(relationNodes),
    labels: labelNodes.map((l) => ((l.name as string) ?? "").toLowerCase()),
    assignedToWorker: true,
    createdAt: node.createdAt ? new Date(node.createdAt as string) : null,
    updatedAt: node.updatedAt ? new Date(node.updatedAt as string) : null,
  };
}

function extractBlockers(relations: Array<Record<string, unknown>>): Blocker[] {
  return relations
    .filter((r) => (r.type as string) === "blocks")
    .map((r) => {
      const related = r.relatedIssue as Record<string, unknown>;
      const relatedState = related?.state as Record<string, unknown>;
      return {
        id: related?.id as string,
        identifier: related?.identifier as string,
        state: (relatedState?.name as string) ?? "",
      };
    })
    .filter((b) => b.id && b.identifier);
}
