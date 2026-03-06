import { describe, it, expect } from "vitest";
import { MemoryAdapter } from "../src/trackers/memory/memory-adapter.js";
import type { Issue } from "../src/trackers/types.js";

const makeIssue = (overrides: Partial<Issue> = {}): Issue => ({
  id: "1",
  identifier: "TEST-1",
  title: "Test Issue",
  description: null,
  priority: null,
  state: "Todo",
  branchName: null,
  url: null,
  assigneeId: null,
  blockedBy: [],
  labels: [],
  assignedToWorker: true,
  createdAt: null,
  updatedAt: null,
  ...overrides,
});

describe("MemoryAdapter", () => {
  it("returns added issues as candidates", async () => {
    const adapter = new MemoryAdapter();
    const issue = makeIssue();
    adapter.addIssue(issue);

    const candidates = await adapter.fetchCandidateIssues();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.identifier).toBe("TEST-1");
  });

  it("filters by state", async () => {
    const adapter = new MemoryAdapter();
    adapter.addIssue(makeIssue({ id: "1", state: "Todo" }));
    adapter.addIssue(makeIssue({ id: "2", state: "Done" }));

    const todos = await adapter.fetchIssuesByStates(["Todo"]);
    expect(todos).toHaveLength(1);
    expect(todos[0]!.state).toBe("Todo");
  });

  it("fetches by IDs", async () => {
    const adapter = new MemoryAdapter();
    adapter.addIssue(makeIssue({ id: "1" }));
    adapter.addIssue(makeIssue({ id: "2", identifier: "TEST-2" }));

    const result = await adapter.fetchIssueStatesByIds(["2"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.identifier).toBe("TEST-2");
  });

  it("creates comments", async () => {
    const adapter = new MemoryAdapter();
    await adapter.createComment("1", "Hello");
    await adapter.createComment("1", "World");

    expect(adapter.getComments("1")).toEqual(["Hello", "World"]);
  });

  it("updates issue state", async () => {
    const adapter = new MemoryAdapter();
    adapter.addIssue(makeIssue({ id: "1", state: "Todo" }));

    await adapter.updateIssueState("1", "Done");

    const result = await adapter.fetchIssueStatesByIds(["1"]);
    expect(result[0]!.state).toBe("Done");
  });
});
