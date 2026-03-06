import { describe, it, expect } from "vitest";
import { buildPrompt, buildContinuationPrompt } from "../src/prompt-builder.js";
import { Config } from "../src/config.js";
import { Workflow, parseWorkflow } from "../src/workflow.js";
import type { Issue } from "../src/trackers/types.js";

function makeConfig(template: string): Config {
  const content = `---\ntracker:\n  kind: memory\n---\n\n${template}`;
  const workflow = new Workflow("/nonexistent");
  const loaded = parseWorkflow(content);
  (workflow as unknown as { cached: typeof loaded }).cached = loaded;
  return new Config(workflow);
}

const testIssue: Issue = {
  id: "issue-1",
  identifier: "TEST-123",
  title: "Fix the bug",
  description: "Something is broken",
  priority: 2,
  state: "In Progress",
  branchName: "fix/bug",
  url: "https://example.com/TEST-123",
  assigneeId: "user-1",
  blockedBy: [],
  labels: ["bug"],
  assignedToWorker: true,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-02"),
};

describe("buildPrompt", () => {
  it("renders issue variables", () => {
    const config = makeConfig(
      "Issue: {{ issue.identifier }} - {{ issue.title }}",
    );
    const result = buildPrompt(testIssue, config);
    expect(result).toBe("Issue: TEST-123 - Fix the bug");
  });

  it("renders conditional description", () => {
    const config = makeConfig(
      "{% if issue.description %}Desc: {{ issue.description }}{% endif %}",
    );
    const result = buildPrompt(testIssue, config);
    expect(result).toBe("Desc: Something is broken");
  });

  it("renders attempt variable", () => {
    const config = makeConfig("Attempt: {{ attempt }}");
    const result = buildPrompt(testIssue, config, { attempt: 3 });
    expect(result).toBe("Attempt: 3");
  });
});

describe("buildContinuationPrompt", () => {
  it("includes turn number and max", () => {
    const result = buildContinuationPrompt(3, 10);
    expect(result).toContain("turn #3 of 10");
    expect(result).toContain("continuation");
  });
});
