import type { Tracker, Issue } from "../types.js";

export class MemoryAdapter implements Tracker {
  private issues: Map<string, Issue> = new Map();
  private comments: Map<string, string[]> = new Map();

  addIssue(issue: Issue): void {
    this.issues.set(issue.id, { ...issue });
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return Array.from(this.issues.values());
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const normalized = states.map((s) => s.trim().toLowerCase());
    return Array.from(this.issues.values()).filter((i) =>
      normalized.includes(i.state.trim().toLowerCase()),
    );
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    return issueIds
      .map((id) => this.issues.get(id))
      .filter((i): i is Issue => i !== undefined);
  }

  async createComment(issueId: string, body: string): Promise<void> {
    const existing = this.comments.get(issueId) ?? [];
    existing.push(body);
    this.comments.set(issueId, existing);
  }

  async updateIssueState(issueId: string, stateName: string): Promise<void> {
    const issue = this.issues.get(issueId);
    if (issue) {
      issue.state = stateName;
    }
  }

  getComments(issueId: string): string[] {
    return this.comments.get(issueId) ?? [];
  }
}
