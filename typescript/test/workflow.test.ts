import { describe, it, expect } from "vitest";
import { parseWorkflow } from "../src/workflow.js";

describe("parseWorkflow", () => {
  it("parses YAML front matter and markdown body", () => {
    const content = `---
tracker:
  kind: linear
  project_slug: my-project
agent:
  max_concurrent_agents: 5
---

You are working on {{ issue.identifier }}.
Title: {{ issue.title }}
`;

    const result = parseWorkflow(content);

    expect(result.config).toEqual({
      tracker: { kind: "linear", project_slug: "my-project" },
      agent: { max_concurrent_agents: 5 },
    });
    expect(result.promptTemplate).toContain("{{ issue.identifier }}");
  });

  it("handles missing front matter", () => {
    const content = "Just a prompt with no YAML.";
    const result = parseWorkflow(content);

    expect(result.config).toEqual({});
    expect(result.promptTemplate).toBe("Just a prompt with no YAML.");
  });

  it("handles empty front matter", () => {
    const content = `---
---

Some prompt.`;

    const result = parseWorkflow(content);
    expect(result.config).toEqual({});
    expect(result.promptTemplate).toBe("Some prompt.");
  });

  it("rejects non-map front matter", () => {
    const content = `---
- item1
- item2
---

Prompt.`;

    expect(() => parseWorkflow(content)).toThrow("YAML map");
  });
});
