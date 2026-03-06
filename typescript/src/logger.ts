import pino from "pino";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { Writable } from "node:stream";

const DEFAULT_LOG_DIR = path.join(os.tmpdir(), "symphony_logs");

/**
 * Ring buffer that captures recent log lines for display in the dashboard.
 */
class LogRing {
  private lines: string[] = [];
  private maxLines: number;

  constructor(maxLines = 12) {
    this.maxLines = maxLines;
  }

  push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.maxLines) {
      this.lines.shift();
    }
  }

  recent(): string[] {
    return [...this.lines];
  }
}

export const logRing = new LogRing(12);

/**
 * A writable stream that can be switched between stdout and a file.
 * Also feeds a ring buffer with formatted log lines.
 */
class SwitchableStream extends Writable {
  private target: NodeJS.WritableStream = process.stdout;
  logFilePath?: string;

  _write(
    chunk: Buffer | string,
    _encoding: string,
    callback: (err?: Error | null) => void,
  ): void {
    const text = chunk.toString().trim();
    if (text) {
      try {
        const parsed = JSON.parse(text);
        const level = levelLabel(parsed.level);
        const msg = parsed.msg ?? "";
        const ts = parsed.time
          ? new Date(parsed.time).toLocaleTimeString()
          : "";
        logRing.push(`${ts} ${level} ${msg}`);
      } catch {
        logRing.push(text.slice(0, 120));
      }
    }
    this.target.write(chunk, callback);
  }

  switchToFile(logsRoot?: string): string {
    const logDir =
      logsRoot ?? process.env.SYMPHONY_LOG_DIR ?? DEFAULT_LOG_DIR;
    fs.mkdirSync(logDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logFile = path.join(logDir, `symphony-${timestamp}.log`);

    this.target = fs.createWriteStream(logFile, { flags: "a" });
    this.logFilePath = logFile;
    return logFile;
  }
}

const stream = new SwitchableStream();

export const logger = pino(
  {
    name: "symphony",
    level: process.env.LOG_LEVEL ?? "info",
  },
  stream,
);

/**
 * Redirect logs to a file so the TUI dashboard isn't polluted.
 * Returns the log file path.
 */
export function setupDashboardLogging(logsRoot?: string): string {
  const logFile = stream.switchToFile(logsRoot);
  logger.info({ logFile }, "Logs redirected to file");
  return logFile;
}

function levelLabel(level: number): string {
  if (level <= 10) return "\x1b[2mTRC\x1b[0m";
  if (level <= 20) return "\x1b[2mDBG\x1b[0m";
  if (level <= 30) return "\x1b[36mINF\x1b[0m";
  if (level <= 40) return "\x1b[33mWRN\x1b[0m";
  if (level <= 50) return "\x1b[31mERR\x1b[0m";
  return "\x1b[31;1mFTL\x1b[0m";
}
