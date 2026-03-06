import { describe, it, expect, beforeEach } from "vitest";
import { Config } from "../src/config.js";
import { Workflow, parseWorkflow } from "../src/workflow.js";

function configFromYaml(yaml: string): Config {
  const content = `---\n${yaml}\n---\n\nPrompt template.`;
  const workflow = new Workflow("/nonexistent");
  // Inject parsed workflow directly
  const loaded = parseWorkflow(content);
  (workflow as unknown as { cached: typeof loaded }).cached = loaded;
  return new Config(workflow);
}

describe("Config", () => {
  it("parses tracker kind", () => {
    const config = configFromYaml("tracker:\n  kind: jira");
    expect(config.trackerKind).toBe("jira");
  });

  it("uses default values", () => {
    const config = configFromYaml("tracker:\n  kind: linear");
    expect(config.maxConcurrentAgents).toBe(10);
    expect(config.agentMaxTurns).toBe(20);
    expect(config.pollIntervalMs).toBe(30_000);
    expect(config.codexCommand).toBe("codex app-server");
  });

  it("parses agent provider", () => {
    const config = configFromYaml(
      "tracker:\n  kind: memory\nagent:\n  provider: claude",
    );
    expect(config.agentProvider).toBe("claude");
  });

  it("defaults provider to codex", () => {
    const config = configFromYaml("tracker:\n  kind: memory");
    expect(config.agentProvider).toBe("codex");
  });

  it("extracts codex model from command", () => {
    const config = configFromYaml(
      'tracker:\n  kind: memory\ncodex:\n  command: "codex app-server --model gpt-5"',
    );
    expect(config.codexModel).toBe("gpt-5");
  });

  it("parses per-state concurrency limits", () => {
    const config = configFromYaml(
      'tracker:\n  kind: memory\nagent:\n  max_concurrent_agents_by_state:\n    "In Progress": 3\n    "Todo": 2',
    );
    expect(config.maxConcurrentAgentsForState("In Progress")).toBe(3);
    expect(config.maxConcurrentAgentsForState("todo")).toBe(2);
    expect(config.maxConcurrentAgentsForState("Unknown")).toBe(10);
  });

  it("validates successfully for memory tracker", () => {
    const config = configFromYaml("tracker:\n  kind: memory");
    expect(() => config.validate()).not.toThrow();
  });

  it("validates linear requires api key", () => {
    const originalKey = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
    try {
      const config = configFromYaml(
        "tracker:\n  kind: linear\n  project_slug: test",
      );
      expect(() => config.validate()).toThrow("LINEAR_API_KEY");
    } finally {
      if (originalKey !== undefined) process.env.LINEAR_API_KEY = originalKey;
    }
  });
});
