#!/usr/bin/env node

import { parseArgs } from "node:util";
import path from "node:path";
import { Workflow } from "./workflow.js";
import { Config } from "./config.js";
import { createTracker } from "./trackers/index.js";
import { createProvider } from "./providers/index.js";
import { Orchestrator } from "./orchestrator.js";
import { StatusReporter } from "./dashboard/status-reporter.js";
import { WebDashboardServer } from "./dashboard/web-server.js";
import { logger, setupDashboardLogging } from "./logger.js";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string", short: "p" },
      "logs-root": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(`Usage: symphony [OPTIONS] [WORKFLOW_PATH]

Options:
  --port, -p <port>     Enable dashboard on specified port
  --logs-root <path>    Write logs under a different directory
  -h, --help            Show this help

Arguments:
  WORKFLOW_PATH         Path to WORKFLOW.md (default: ./WORKFLOW.md)

Environment:
  LINEAR_API_KEY        Linear API token (for linear tracker)
  JIRA_API_KEY          Jira API token (for jira tracker)
  JIRA_EMAIL            Jira auth email (for basic auth)
  ANTHROPIC_API_KEY     Anthropic API key (for claude provider)

The WORKFLOW.md file uses YAML front matter for configuration.
Set agent.provider to "codex" or "claude" to select the model provider.
`);
    process.exit(0);
  }

  const workflowPath = positionals[0]
    ? path.resolve(positionals[0])
    : path.join(process.cwd(), "WORKFLOW.md");

  // Initialize
  const workflow = new Workflow(workflowPath);
  workflow.startWatching();

  const config = new Config(workflow);

  try {
    config.validate();
  } catch (err) {
    logger.fatal({ err }, "Configuration validation failed");
    process.exit(1);
  }

  const tracker = createTracker(config);
  const provider = createProvider(config);

  logger.info(
    {
      workflowPath,
      trackerKind: config.trackerKind,
      provider: provider.name,
      maxAgents: config.maxConcurrentAgents,
    },
    "Symphony starting",
  );

  const orchestrator = new Orchestrator(config, tracker, provider);

  // Status reporter — redirect logs to file when dashboard is active
  const logFile = setupDashboardLogging(values["logs-root"] ?? undefined);

  const reporter = new StatusReporter(
    () => orchestrator.snapshot(),
    1000,
    logFile,
  );
  reporter.start();

  // Web dashboard server
  const webServer = new WebDashboardServer({
    getSnapshot: () => orchestrator.snapshot(),
    port: config.serverPort,
    host: config.serverHost,
  });

  const { port: actualPort, host: actualHost } = await webServer.start();
  logger.info(`Dashboard: http://${actualHost}:${actualPort}`);

  // Graceful shutdown
  const shutdown = () => {
    logger.info("Shutting down...");
    orchestrator.stop();
    reporter.stop();
    webServer.stop();
    workflow.stopWatching();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  orchestrator.start();
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal error");
  process.exit(1);
});
