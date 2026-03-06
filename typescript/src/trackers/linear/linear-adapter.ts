import type { Tracker, Issue } from "../types.js";
import { LinearClient } from "./linear-client.js";
import type { Config } from "../../config.js";

export class LinearAdapter implements Tracker {
  private client: LinearClient;

  constructor(config: Config, client?: LinearClient) {
    this.client = client ?? new LinearClient(config);
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.client.fetchCandidateIssues();
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    return this.client.fetchIssuesByStates(states);
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    return this.client.fetchIssueStatesByIds(issueIds);
  }

  async createComment(issueId: string, body: string): Promise<void> {
    const mutation = `
      mutation($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
        }
      }
    `;
    await this.client.graphql(mutation, { issueId, body });
  }

  async updateIssueState(issueId: string, stateName: string): Promise<void> {
    const stateId = await this.resolveStateId(issueId, stateName);
    if (!stateId) {
      throw new Error(`Could not find state "${stateName}" for issue ${issueId}`);
    }

    const mutation = `
      mutation($issueId: String!, $stateId: String!) {
        issueUpdate(id: $issueId, input: { stateId: $stateId }) {
          success
        }
      }
    `;
    await this.client.graphql(mutation, { issueId, stateId });
  }

  private async resolveStateId(
    issueId: string,
    stateName: string,
  ): Promise<string | null> {
    const query = `
      query($issueId: String!) {
        issue(id: $issueId) {
          team {
            states { nodes { id name } }
          }
        }
      }
    `;

    const result = await this.client.graphql(query, { issueId });
    const data = result.data as Record<string, unknown>;
    const issue = data?.issue as Record<string, unknown>;
    const team = issue?.team as Record<string, unknown>;
    const states = team?.states as Record<string, unknown>;
    const nodes = (states?.nodes as Array<Record<string, unknown>>) ?? [];

    const normalizedTarget = stateName.trim().toLowerCase();
    const match = nodes.find(
      (s) => ((s.name as string) ?? "").trim().toLowerCase() === normalizedTarget,
    );
    return (match?.id as string) ?? null;
  }
}
