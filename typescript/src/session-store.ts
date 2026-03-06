import Database from "better-sqlite3";
import type { ContentMessage } from "./providers/types.js";

export interface SessionEvent {
  timestamp: string;
  event: string;
  detail?: string;
}

export interface CompletedSession {
  id?: number;
  issueId: string;
  identifier: string;
  title: string;
  state: string;
  outcome: "completed" | "failed" | "aborted";
  model?: string;
  startedAt: string;
  endedAt: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUsd: number;
  createdAt?: string;
  messages?: SessionEvent[];
}

export interface CumulativeTotals {
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUsd: number;
}

export class SessionStore {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private insertMsgStmt: Database.Statement;
  private totalsCache: { value: CumulativeTotals; expiresAt: number } | null = null;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id            TEXT NOT NULL,
        identifier          TEXT NOT NULL,
        title               TEXT NOT NULL,
        state               TEXT NOT NULL,
        outcome             TEXT NOT NULL,
        model               TEXT,
        started_at          TEXT NOT NULL,
        ended_at            TEXT NOT NULL,
        turns               INTEGER NOT NULL,
        input_tokens        INTEGER NOT NULL DEFAULT 0,
        output_tokens       INTEGER NOT NULL DEFAULT 0,
        total_tokens        INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
        cache_create_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd            REAL NOT NULL DEFAULT 0,
        created_at          TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Add messages_json column if missing (migration for existing DBs)
    const cols = this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "messages_json")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN messages_json TEXT`);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq         INTEGER NOT NULL,
        role        TEXT NOT NULL,
        timestamp   TEXT NOT NULL,
        text        TEXT,
        tool_name   TEXT,
        tool_input  TEXT
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_session_messages_session_id
        ON session_messages(session_id)
    `);

    this.insertStmt = this.db.prepare(`
      INSERT INTO sessions (
        issue_id, identifier, title, state, outcome, model,
        started_at, ended_at, turns,
        input_tokens, output_tokens, total_tokens,
        cache_read_tokens, cache_create_tokens, cost_usd,
        messages_json
      ) VALUES (
        @issueId, @identifier, @title, @state, @outcome, @model,
        @startedAt, @endedAt, @turns,
        @inputTokens, @outputTokens, @totalTokens,
        @cacheReadTokens, @cacheCreateTokens, @costUsd,
        @messagesJson
      )
    `);

    this.insertMsgStmt = this.db.prepare(`
      INSERT INTO session_messages (session_id, seq, role, timestamp, text, tool_name, tool_input)
      VALUES (@sessionId, @seq, @role, @timestamp, @text, @toolName, @toolInput)
    `);
  }

  insertSession(session: CompletedSession, contentMessages?: ContentMessage[]): void {
    const insertAll = this.db.transaction(() => {
      const result = this.insertStmt.run({
        issueId: session.issueId,
        identifier: session.identifier,
        title: session.title,
        state: session.state,
        outcome: session.outcome,
        model: session.model ?? null,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        turns: session.turns,
        inputTokens: session.inputTokens,
        outputTokens: session.outputTokens,
        totalTokens: session.totalTokens,
        cacheReadTokens: session.cacheReadTokens,
        cacheCreateTokens: session.cacheCreateTokens,
        costUsd: session.costUsd,
        messagesJson: session.messages ? JSON.stringify(session.messages) : null,
      });

      if (contentMessages && contentMessages.length > 0) {
        const sessionId = result.lastInsertRowid;
        for (let i = 0; i < contentMessages.length; i++) {
          const msg = contentMessages[i]!;
          this.insertMsgStmt.run({
            sessionId,
            seq: i,
            role: msg.role,
            timestamp: msg.timestamp,
            text: msg.text ?? null,
            toolName: msg.toolName ?? null,
            toolInput: msg.toolInput ?? null,
          });
        }
      }
    });
    insertAll();
    this.totalsCache = null;
  }

  getSessions(opts: { limit?: number; offset?: number } = {}): CompletedSession[] {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as Array<Record<string, unknown>>;

    return rows.map(rowToSession);
  }

  getCumulativeTotals(): CumulativeTotals {
    const now = Date.now();
    if (this.totalsCache && now < this.totalsCache.expiresAt) {
      return this.totalsCache.value;
    }

    const row = this.db
      .prepare(
        `SELECT
          COUNT(*) as session_count,
          COALESCE(SUM(input_tokens), 0) as input_tokens,
          COALESCE(SUM(output_tokens), 0) as output_tokens,
          COALESCE(SUM(total_tokens), 0) as total_tokens,
          COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
          COALESCE(SUM(cache_create_tokens), 0) as cache_create_tokens,
          COALESCE(SUM(cost_usd), 0) as cost_usd
        FROM sessions`,
      )
      .get() as Record<string, number>;

    const value: CumulativeTotals = {
      sessionCount: row.session_count,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheCreateTokens: row.cache_create_tokens,
      costUsd: row.cost_usd,
    };

    this.totalsCache = { value, expiresAt: now + 2000 };
    return value;
  }

  getSessionMessages(sessionId: number): ContentMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM session_messages WHERE session_id = ? ORDER BY seq ASC`)
      .all(sessionId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      role: row.role as ContentMessage["role"],
      timestamp: row.timestamp as string,
      text: (row.text as string) ?? undefined,
      toolName: (row.tool_name as string) ?? undefined,
      toolInput: (row.tool_input as string) ?? undefined,
    }));
  }

  getCompletedIssueIds(): Set<string> {
    const rows = this.db
      .prepare(`SELECT DISTINCT issue_id FROM sessions WHERE outcome = 'completed'`)
      .all() as Array<{ issue_id: string }>;
    return new Set(rows.map((r) => r.issue_id));
  }

  close(): void {
    this.db.close();
  }
}

function rowToSession(row: Record<string, unknown>): CompletedSession {
  let messages: SessionEvent[] | undefined;
  if (typeof row.messages_json === "string") {
    try { messages = JSON.parse(row.messages_json); } catch { /* ignore */ }
  }
  return {
    id: row.id as number,
    issueId: row.issue_id as string,
    identifier: row.identifier as string,
    title: row.title as string,
    state: row.state as string,
    outcome: row.outcome as CompletedSession["outcome"],
    model: (row.model as string) ?? undefined,
    startedAt: row.started_at as string,
    endedAt: row.ended_at as string,
    turns: row.turns as number,
    inputTokens: row.input_tokens as number,
    outputTokens: row.output_tokens as number,
    totalTokens: row.total_tokens as number,
    cacheReadTokens: row.cache_read_tokens as number,
    cacheCreateTokens: row.cache_create_tokens as number,
    costUsd: row.cost_usd as number,
    createdAt: row.created_at as string,
    messages,
  };
}
