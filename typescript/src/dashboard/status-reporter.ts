import type { OrchestratorSnapshot } from "../orchestrator.js";
import { logRing } from "../logger.js";

// ANSI color helpers
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  white: "\x1b[37m",
};

const BOX = {
  tl: "╭", tr: "╮", bl: "╰", br: "╯",
  h: "─", v: "│", lj: "├", rj: "┤",
};

export class StatusReporter {
  private refreshMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private getSnapshot: () => OrchestratorSnapshot;
  private completedCount = 0;
  private lastRunningIds = new Set<string>();
  private logFile?: string;

  constructor(
    getSnapshot: () => OrchestratorSnapshot,
    refreshMs = 1000,
    logFile?: string,
  ) {
    this.getSnapshot = getSnapshot;
    this.refreshMs = refreshMs;
    this.logFile = logFile;
  }

  start(): void {
    this.stop();
    // Enter alternate screen buffer so logs in the main buffer are preserved
    process.stdout.write("\x1b[?1049h\x1b[?25l"); // alt buffer + hide cursor
    this.timer = setInterval(() => this.render(), this.refreshMs);
    this.timer.unref();
    this.render();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Leave alternate screen buffer and restore cursor
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  }

  render(): void {
    const snap = this.getSnapshot();
    const now = Date.now();
    const width = Math.max(process.stdout.columns || 80, 60);

    // Track completions
    const currentIds = new Set(snap.running.map((r) => r.issueId));
    for (const id of this.lastRunningIds) {
      if (!currentIds.has(id)) this.completedCount++;
    }
    this.lastRunningIds = currentIds;

    const lines: string[] = [];

    // Top border with title
    const title = " SYMPHONY STATUS ";
    const titlePad = width - 2 - title.length;
    const leftPad = Math.floor(titlePad / 2);
    const rightPad = titlePad - leftPad;
    lines.push(
      `${c.cyan}${BOX.tl}${BOX.h.repeat(leftPad)}${c.bold}${title}${c.reset}${c.cyan}${BOX.h.repeat(rightPad)}${BOX.tr}${c.reset}`,
    );

    // Header info
    const runtime = formatDuration(now - snap.startedAt.getTime());
    const totalTokens = snap.codexTotals.totalTokens ?? 0;
    const inputTokens = snap.codexTotals.inputTokens ?? 0;
    const outputTokens = snap.codexTotals.outputTokens ?? 0;

    // Poll countdown
    let pollStatus: string;
    if (snap.polling.inProgress) {
      pollStatus = `${c.green}polling...${c.reset}`;
    } else {
      const secsUntilPoll = Math.max(0, Math.ceil((snap.polling.nextPollAtMs - now) / 1000));
      const pollBar = progressBar(secsUntilPoll, Math.round(snap.polling.intervalMs / 1000), 15);
      pollStatus = `${pollBar} ${c.white}${secsUntilPoll}s${c.reset}`;
    }

    boxLine(lines, width,
      `${c.white}Agents:${c.reset} ${c.green}${snap.running.length}${c.reset}/${snap.polling.maxAgents} active    ` +
      `${c.white}Completed:${c.reset} ${c.green}${this.completedCount}${c.reset}    ` +
      `${c.white}Retrying:${c.reset} ${c.yellow}${snap.retrying.length}${c.reset}`,
    );
    boxLine(lines, width,
      `${c.white}Runtime:${c.reset} ${runtime}    ` +
      `${c.white}Provider:${c.reset} ${c.cyan}${snap.provider}${c.reset}    ` +
      `${c.white}Next poll:${c.reset} ${pollStatus}`,
    );
    boxLine(lines, width,
      `${c.white}Tokens:${c.reset} ${c.green}${formatNumber(totalTokens)}${c.reset} total  ` +
      `(${c.dim}in:${c.reset} ${formatNumber(inputTokens)}  ${c.dim}out:${c.reset} ${formatNumber(outputTokens)})`,
    );

    // Running agents table
    sectionDivider(lines, width, "Running");

    if (snap.running.length > 0) {
      boxLine(lines, width,
        `${c.dim}  ${"ID".padEnd(14)} ${"STATE".padEnd(12)} ${"STAGE".padEnd(10)} ${"AGE".padEnd(8)} ${"TURN".padEnd(5)} ${"TOKENS".padEnd(10)} EVENT${c.reset}`,
      );

      for (const entry of snap.running) {
        const age = formatDuration(now - entry.startedAt.getTime());
        const tokens = formatNumber(entry.usage.totalTokens ?? 0);
        const bullet = stageIndicator(entry.stage);
        const event = (entry.lastEvent || "").slice(0, 20);

        boxLine(lines, width,
          `  ${c.cyan}${entry.identifier.padEnd(14)}${c.reset}` +
          ` ${stateColor(entry.state)}${entry.state.padEnd(12)}${c.reset}` +
          ` ${bullet}${entry.stage.padEnd(9)}${c.reset}` +
          ` ${c.white}${age.padEnd(8)}${c.reset}` +
          ` ${c.white}${String(entry.turnNumber).padEnd(5)}${c.reset}` +
          ` ${c.green}${tokens.padEnd(10)}${c.reset}` +
          ` ${c.dim}${event}${c.reset}`,
        );
      }
    } else {
      boxLine(lines, width, `${c.dim}  No agents running${c.reset}`);
    }

    // Retry / backoff queue
    if (snap.retrying.length > 0) {
      sectionDivider(lines, width, "Backoff Queue");

      for (const entry of snap.retrying) {
        const countdown = Math.max(0, Math.ceil((entry.dueAtMs - now) / 1000));
        const errSnippet = entry.error ? ` ${c.dim}${entry.error.slice(0, 40)}${c.reset}` : "";
        boxLine(lines, width,
          `  ${c.yellow}↻${c.reset} ${c.cyan}${entry.identifier.padEnd(14)}${c.reset}` +
          ` attempt ${c.white}#${entry.attempt}${c.reset}` +
          ` ${c.magenta}${countdown}s${c.reset}${errSnippet}`,
        );
      }
    }

    // Recent logs section — always show
    sectionDivider(lines, width, "Logs");
    const recentLogs = logRing.recent();
    if (recentLogs.length > 0) {
      for (const line of recentLogs) {
        boxLine(lines, width, `  ${line.slice(0, width - 6)}`);
      }
    } else {
      boxLine(lines, width, `${c.dim}  Waiting for log output...${c.reset}`);
    }

    // Log file path
    if (this.logFile) {
      boxLine(lines, width, `${c.dim}  File: ${this.logFile}${c.reset}`);
    }

    // Bottom border with timestamp
    const ts = new Date().toLocaleTimeString();
    const bottomLabel = ` ${ts} `;
    const bottomPad = width - 2 - bottomLabel.length;
    const bLeft = Math.floor(bottomPad / 2);
    const bRight = bottomPad - bLeft;
    lines.push(
      `${c.cyan}${BOX.bl}${BOX.h.repeat(bLeft)}${c.dim}${bottomLabel}${c.reset}${c.cyan}${BOX.h.repeat(bRight)}${BOX.br}${c.reset}`,
    );

    // Position at top-left of alternate buffer and render
    process.stdout.write("\x1b[H\x1b[2J" + lines.join("\n") + "\n");
  }
}

function boxLine(lines: string[], _width: number, content: string): void {
  lines.push(`${c.cyan}${BOX.v}${c.reset} ${content}`);
}

function sectionDivider(lines: string[], width: number, label: string): void {
  if (label) {
    const labelStr = ` ${label} `;
    lines.push(
      `${c.cyan}${BOX.lj}${BOX.h.repeat(2)}${labelStr}${BOX.h.repeat(Math.max(0, width - 4 - labelStr.length))}${BOX.rj}${c.reset}`,
    );
  } else {
    lines.push(
      `${c.cyan}${BOX.lj}${BOX.h.repeat(width - 2)}${BOX.rj}${c.reset}`,
    );
  }
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m${sec.toString().padStart(2, "0")}s`;
  const hr = Math.floor(min / 60);
  const rm = min % 60;
  return `${hr}h${rm.toString().padStart(2, "0")}m`;
}

function formatNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function progressBar(remaining: number, total: number, barWidth: number): string {
  if (total <= 0) return `${c.dim}[${"=".repeat(barWidth)}]${c.reset}`;
  const elapsed = total - remaining;
  const filled = Math.round((elapsed / total) * barWidth);
  const empty = barWidth - filled;
  return `${c.dim}[${c.reset}${c.green}${"█".repeat(filled)}${c.reset}${c.dim}${"░".repeat(empty)}]${c.reset}`;
}

function stageIndicator(stage: string): string {
  switch (stage) {
    case "running": return `${c.green}● ${c.reset}`;
    case "starting": return `${c.yellow}◐ ${c.reset}`;
    case "retrying": return `${c.magenta}↻ ${c.reset}`;
    default: return `${c.dim}○ ${c.reset}`;
  }
}

function stateColor(state: string): string {
  const s = state.trim().toLowerCase();
  if (s === "in progress") return c.green;
  if (s === "todo" || s === "to do") return c.yellow;
  if (s === "done" || s === "closed") return c.dim;
  if (s.includes("review")) return c.magenta;
  if (s.includes("rework")) return c.red;
  return c.white;
}
