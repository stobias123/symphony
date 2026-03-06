import type { Tracker, Issue } from "../types.js";
import { JiraClient } from "./jira-client.js";
import type { Config } from "../../config.js";

export class JiraAdapter implements Tracker {
  private client: JiraClient;

  constructor(config: Config, client?: JiraClient) {
    this.client = client ?? new JiraClient(config);
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
    await this.client.addComment(issueId, body);
  }

  async updateIssueState(issueId: string, stateName: string): Promise<void> {
    await this.client.transitionIssue(issueId, stateName);
  }
}
