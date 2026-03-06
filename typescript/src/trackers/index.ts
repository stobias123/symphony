import type { Tracker } from "./types.js";
import type { Config } from "../config.js";
import { LinearAdapter } from "./linear/linear-adapter.js";
import { JiraAdapter } from "./jira/jira-adapter.js";
import { MemoryAdapter } from "./memory/memory-adapter.js";

export function createTracker(config: Config): Tracker {
  switch (config.trackerKind) {
    case "linear":
      return new LinearAdapter(config);
    case "jira":
      return new JiraAdapter(config);
    case "memory":
      return new MemoryAdapter();
    default:
      return new LinearAdapter(config);
  }
}

export type { Tracker, Issue, Blocker } from "./types.js";
