import Database from "better-sqlite3";
import { existsSync, readFileSync, renameSync } from "fs";
import { join } from "path";

const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";
const DB_PATH = join(HARNESS_ROOT, "bridges", "discord", "harness.db");

let db: Database.Database | null = null;
let checkpointTimer: ReturnType<typeof setInterval> | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  // Auto-checkpoint after 100 pages (~400KB) instead of default 1000 (~4MB)
  db.pragma("wal_autocheckpoint = 100");

  runMigrations(db);

  // Periodic WAL checkpoint every 5 minutes to prevent WAL bloat
  if (!checkpointTimer) {
    checkpointTimer = setInterval(() => {
      try {
        db?.pragma("wal_checkpoint(PASSIVE)");
      } catch (_) {
        // Ignore — checkpoint is best-effort
      }
    }, 5 * 60 * 1000);
    checkpointTimer.unref(); // Don't prevent process exit
  }

  return db;
}

export function closeDb(): void {
  if (checkpointTimer) {
    clearInterval(checkpointTimer);
    checkpointTimer = null;
  }
  if (db) {
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch (_) {}
    db.close();
    db = null;
  }
}

function runMigrations(database: Database.Database): void {
  // Create schema versioning table
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const currentVersion = database
    .prepare("SELECT MAX(version) as v FROM schema_version")
    .get() as { v: number | null };

  const version = currentVersion?.v ?? 0;

  if (version < 1) {
    applyV1(database);
    database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(1);
    console.log("[DB] Applied schema v1");

    // Auto-migrate from JSON files
    migrateFromJson(database);
  }

  if (version < 2) {
    applyV2(database);
    database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(2);
    console.log("[DB] Applied schema v2 (oauth, email, linkedin)");
  }

  if (version < 3) {
    applyV3(database);
    database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(3);
    console.log("[DB] Applied schema v3 (task telemetry)");
  }

  if (version < 4) {
    applyV4(database);
    database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(4);
    console.log("[DB] Applied schema v4 (parallel tasks)");
  }

  if (version < 5) {
    applyV5(database);
    database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(5);
    console.log("[DB] Applied schema v5 (worktrees)");
  }

  if (version < 6) {
    applyV6(database);
    database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(6);
    console.log("[DB] Applied schema v6 (work queue)");
  }

  if (version < 7) {
    applyV7(database);
    database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(7);
    console.log("[DB] Applied schema v7 (work queue ideation)");
  }

  if (version < 8) {
    applyV8(database);
    database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(8);
    console.log("[DB] Applied schema v8 (tracked events)");
  }

  if (version < 9) {
    applyV9(database);
    database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(9);
    console.log("[DB] Applied schema v9 (retrieval hits)");
  }

  if (version < 10) {
    applyV10(database);
    database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(10);
    console.log("[DB] Applied schema v10 (learning edges)");
  }

  if (version < 11) {
    applyV11(database);
    database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(11);
    console.log("[DB] Applied schema v11 (work queue evaluation fields)");
  }

  if (version < 12) {
    applyV12(database);
    database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(12);
    console.log("[DB] Applied schema v12 (session runtime column)");
  }

  if (version < 13) {
    applyV13(database);
    database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(13);
    console.log("[DB] Applied schema v13 (channel/task runtime columns)");
  }

  if (version < 14) {
    applyV14(database);
    database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(14);
    console.log("[DB] Applied schema v14 (subagent/dead-letter runtime columns)");
  }

  if (version < 15) {
    applyV15(database);
    database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(15);
    console.log("[DB] Applied schema v15 (parallel task runtime column)");
  }
}

function applyV1(database: Database.Database): void {
  database.exec(`
    -- Sessions (replaces sessions.json)
    CREATE TABLE IF NOT EXISTS sessions (
      channel_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Channel configs (replaces channel-config.json)
    CREATE TABLE IF NOT EXISTS channel_configs (
      channel_id       TEXT PRIMARY KEY,
      agent            TEXT,
      permission_mode  TEXT,
      allowed_tools    TEXT,
      disallowed_tools TEXT,
      model            TEXT,
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Subagents (replaces subagents.json)
    CREATE TABLE IF NOT EXISTS subagents (
      id                TEXT PRIMARY KEY,
      parent_channel_id TEXT NOT NULL,
      description       TEXT NOT NULL,
      agent             TEXT,
      runtime           TEXT NOT NULL DEFAULT 'claude',
      output_file       TEXT NOT NULL,
      pid               INTEGER NOT NULL,
      status            TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled')),
      started_at        TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at      TEXT,
      stream_message_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_subagents_status ON subagents(status);
    CREATE INDEX IF NOT EXISTS idx_subagents_channel ON subagents(parent_channel_id);

    -- Projects (replaces projects.json)
    CREATE TABLE IF NOT EXISTS projects (
      channel_id        TEXT PRIMARY KEY,
      category_id       TEXT NOT NULL,
      guild_id          TEXT NOT NULL,
      name              TEXT NOT NULL UNIQUE,
      description       TEXT NOT NULL,
      agents            TEXT NOT NULL,
      active_agent      TEXT,
      handoff_depth     INTEGER NOT NULL DEFAULT 0,
      max_handoff_depth INTEGER NOT NULL DEFAULT 5,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);

    -- Task queue (for bounded-step + retry)
    CREATE TABLE IF NOT EXISTS task_queue (
      id            TEXT PRIMARY KEY,
      channel_id    TEXT NOT NULL,
      prompt        TEXT NOT NULL,
      agent         TEXT,
      session_key   TEXT,
      status        TEXT NOT NULL CHECK (status IN ('pending','running','waiting_continue','completed','failed','dead')),
      step_count    INTEGER NOT NULL DEFAULT 0,
      max_steps     INTEGER NOT NULL DEFAULT 10,
      attempt       INTEGER NOT NULL DEFAULT 0,
      max_attempts  INTEGER NOT NULL DEFAULT 3,
      last_error    TEXT,
      output_file   TEXT,
      pid           INTEGER,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      next_retry_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_queue_status ON task_queue(status);
    CREATE INDEX IF NOT EXISTS idx_task_queue_channel ON task_queue(channel_id);

    -- Dead-letter (failed tasks after all retries exhausted)
    CREATE TABLE IF NOT EXISTS dead_letter (
      id         TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      prompt     TEXT NOT NULL,
      agent      TEXT,
      runtime    TEXT,
      error      TEXT NOT NULL,
      attempts   INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dead_letter_channel ON dead_letter(channel_id);
  `);
}

function applyV2(database: Database.Database): void {
  database.exec(`
    -- OAuth tokens for Microsoft + LinkedIn
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      provider      TEXT PRIMARY KEY,
      access_token  TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      token_type    TEXT NOT NULL DEFAULT 'Bearer',
      expires_at    TEXT NOT NULL,
      scopes        TEXT NOT NULL,
      extra         TEXT,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Email index (cached from Graph API)
    CREATE TABLE IF NOT EXISTS email_index (
      message_id      TEXT PRIMARY KEY,
      conversation_id TEXT,
      subject         TEXT NOT NULL,
      sender_name     TEXT NOT NULL,
      sender_email    TEXT NOT NULL,
      received_at     TEXT NOT NULL,
      snippet         TEXT,
      has_attachments INTEGER NOT NULL DEFAULT 0,
      importance      TEXT,
      is_read         INTEGER NOT NULL DEFAULT 0,
      folder          TEXT NOT NULL DEFAULT 'inbox',
      matched_project TEXT,
      indexed_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_email_sender ON email_index(sender_email);
    CREATE INDEX IF NOT EXISTS idx_email_received ON email_index(received_at);
    CREATE INDEX IF NOT EXISTS idx_email_project ON email_index(matched_project);

    -- Watched senders for email alerts
    CREATE TABLE IF NOT EXISTS watched_senders (
      email           TEXT PRIMARY KEY,
      label           TEXT NOT NULL,
      discord_channel TEXT NOT NULL DEFAULT 'emails',
      project         TEXT,
      added_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- LinkedIn post drafts + approval flow
    CREATE TABLE IF NOT EXISTS linkedin_posts (
      id                 TEXT PRIMARY KEY,
      status             TEXT NOT NULL CHECK (status IN ('draft','pending_approval','approved','published','rejected')),
      topic              TEXT NOT NULL,
      content            TEXT NOT NULL,
      signals            TEXT,
      approval_token     TEXT UNIQUE,
      linkedin_post_id   TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      published_at       TEXT,
      discord_message_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_linkedin_status ON linkedin_posts(status);
  `);
}

function applyV3(database: Database.Database): void {
  database.exec(`
    -- Task telemetry for post-mortem analysis
    CREATE TABLE IF NOT EXISTS task_telemetry (
      task_id           TEXT PRIMARY KEY,
      channel_id        TEXT NOT NULL,
      agent             TEXT,
      prompt            TEXT NOT NULL,
      started_at        TEXT NOT NULL,
      completed_at      TEXT,
      status            TEXT NOT NULL,
      tool_calls        TEXT NOT NULL DEFAULT '[]',
      total_tools       INTEGER NOT NULL DEFAULT 0,
      duration_ms       INTEGER,
      est_input_tokens  INTEGER,
      est_output_tokens INTEGER,
      est_cost_cents    INTEGER,
      intervention      TEXT,
      loop_detected     INTEGER NOT NULL DEFAULT 0,
      error             TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_channel ON task_telemetry(channel_id);
    CREATE INDEX IF NOT EXISTS idx_telemetry_agent ON task_telemetry(agent);
    CREATE INDEX IF NOT EXISTS idx_telemetry_started ON task_telemetry(started_at);
  `);
}

function applyV4(database: Database.Database): void {
  database.exec(`
    -- Parallel task groups for tmux-based multi-agent orchestration
    CREATE TABLE IF NOT EXISTS parallel_tasks (
      group_id       TEXT NOT NULL,
      task_id        TEXT NOT NULL,
      parent_task_id TEXT,
      channel_id     TEXT NOT NULL,
      agent          TEXT NOT NULL,
      runtime        TEXT NOT NULL DEFAULT 'claude',
      description    TEXT NOT NULL,
      tmux_window    TEXT,
      status         TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','cancelled')),
      result         TEXT,
      error          TEXT,
      started_at     TEXT,
      completed_at   TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_parallel_group ON parallel_tasks(group_id);
    CREATE INDEX IF NOT EXISTS idx_parallel_status ON parallel_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_parallel_channel ON parallel_tasks(channel_id);
  `);
}

function applyV5(database: Database.Database): void {
  database.exec(`
    -- Git worktree tracking for parallel agent isolation
    CREATE TABLE IF NOT EXISTS worktrees (
      id            TEXT PRIMARY KEY,
      project_name  TEXT NOT NULL,
      project_path  TEXT NOT NULL,
      worktree_path TEXT NOT NULL UNIQUE,
      branch_name   TEXT NOT NULL UNIQUE,
      group_id      TEXT,
      chain_id      TEXT,
      channel_id    TEXT NOT NULL,
      status        TEXT NOT NULL CHECK (status IN ('active','merging','merged','failed','orphaned')),
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at  TEXT,
      merge_result  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_worktrees_status ON worktrees(status);
    CREATE INDEX IF NOT EXISTS idx_worktrees_group ON worktrees(group_id);
    CREATE INDEX IF NOT EXISTS idx_worktrees_chain ON worktrees(chain_id);
    CREATE INDEX IF NOT EXISTS idx_worktrees_project ON worktrees(project_name);
  `);
}

function applyV6(database: Database.Database): void {
  database.exec(`
    -- Autonomous work queue for self-directed agent work
    CREATE TABLE IF NOT EXISTS work_queue (
      id            TEXT PRIMARY KEY,
      source        TEXT NOT NULL,
      source_id     TEXT,
      channel_id    TEXT NOT NULL,
      prompt        TEXT NOT NULL,
      agent         TEXT,
      priority      INTEGER NOT NULL DEFAULT 50,
      status        TEXT NOT NULL CHECK (status IN ('pending','gated','running','completed','failed','cancelled')),
      gate_reason   TEXT,
      depends_on    TEXT,
      scheduled_at  TEXT,
      started_at    TEXT,
      completed_at  TEXT,
      task_id       TEXT,
      attempt       INTEGER NOT NULL DEFAULT 0,
      max_attempts  INTEGER NOT NULL DEFAULT 3,
      last_error    TEXT,
      metadata      TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_work_queue_status ON work_queue(status);
    CREATE INDEX IF NOT EXISTS idx_work_queue_priority ON work_queue(priority DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_work_queue_source ON work_queue(source);
    CREATE INDEX IF NOT EXISTS idx_work_queue_channel ON work_queue(channel_id);
    CREATE INDEX IF NOT EXISTS idx_work_queue_scheduled ON work_queue(scheduled_at);
  `);
}

function applyV7(database: Database.Database): void {
  // SQLite doesn't support ALTER CHECK constraints, so we recreate the table
  // with the new status values. This is safe because v6 just created it.
  database.exec(`
    -- Recreate work_queue with 'proposed' and 'approved' status values for ideation flow
    CREATE TABLE IF NOT EXISTS work_queue_new (
      id            TEXT PRIMARY KEY,
      source        TEXT NOT NULL,
      source_id     TEXT,
      channel_id    TEXT NOT NULL,
      prompt        TEXT NOT NULL,
      agent         TEXT,
      priority      INTEGER NOT NULL DEFAULT 50,
      status        TEXT NOT NULL CHECK (status IN ('proposed','approved','pending','gated','running','completed','failed','cancelled')),
      gate_reason   TEXT,
      depends_on    TEXT,
      scheduled_at  TEXT,
      started_at    TEXT,
      completed_at  TEXT,
      task_id       TEXT,
      attempt       INTEGER NOT NULL DEFAULT 0,
      max_attempts  INTEGER NOT NULL DEFAULT 3,
      last_error    TEXT,
      metadata      TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO work_queue_new SELECT * FROM work_queue;
    DROP TABLE work_queue;
    ALTER TABLE work_queue_new RENAME TO work_queue;
    CREATE INDEX IF NOT EXISTS idx_work_queue_status ON work_queue(status);
    CREATE INDEX IF NOT EXISTS idx_work_queue_priority ON work_queue(priority DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_work_queue_source ON work_queue(source);
    CREATE INDEX IF NOT EXISTS idx_work_queue_channel ON work_queue(channel_id);
    CREATE INDEX IF NOT EXISTS idx_work_queue_scheduled ON work_queue(scheduled_at);
  `);
}

function applyV8(database: Database.Database): void {
  database.exec(`
    -- Tracked events: persistent store for opportunities, deadlines, and events
    -- discovered from emails, calendar, Canvas, or manual entry
    CREATE TABLE IF NOT EXISTS tracked_events (
      id              TEXT PRIMARY KEY,
      source          TEXT NOT NULL CHECK (source IN ('email','calendar','canvas','manual')),
      source_id       TEXT,
      category        TEXT NOT NULL CHECK (category IN ('internship','career','deadline','event','assignment','meeting','other')),
      title           TEXT NOT NULL,
      description     TEXT,
      event_date      TEXT,
      due_date        TEXT,
      location        TEXT,
      apply_link      TEXT,
      contact_name    TEXT,
      contact_email   TEXT,
      organization    TEXT,
      status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','upcoming','expired','applied','dismissed')),
      notified        INTEGER NOT NULL DEFAULT 0,
      discovered_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tracked_events_category ON tracked_events(category);
    CREATE INDEX IF NOT EXISTS idx_tracked_events_status ON tracked_events(status);
    CREATE INDEX IF NOT EXISTS idx_tracked_events_due ON tracked_events(due_date);
    CREATE INDEX IF NOT EXISTS idx_tracked_events_source ON tracked_events(source);
  `);
}

function applyV9(database: Database.Database): void {
  database.exec(`
    -- Retrieval hit tracking: logs which learnings are retrieved per agent spawn
    CREATE TABLE IF NOT EXISTS retrieval_hits (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      learning_path TEXT NOT NULL,
      agent         TEXT,
      channel_id    TEXT,
      task_id       TEXT,
      score         REAL,
      match_type    TEXT,
      retrieved_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_retrieval_path ON retrieval_hits(learning_path);
    CREATE INDEX IF NOT EXISTS idx_retrieval_date ON retrieval_hits(retrieved_at);
  `);
}

function applyV10(database: Database.Database): void {
  database.exec(`
    -- Learning edges: lightweight knowledge graph for relational queries
    CREATE TABLE IF NOT EXISTS learning_edges (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id   TEXT NOT NULL,
      target_id   TEXT NOT NULL,
      relation    TEXT NOT NULL CHECK (relation IN ('supersedes','related_to','contradicts','depends_on')),
      weight      REAL NOT NULL DEFAULT 1.0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_id, target_id, relation)
    );
    CREATE INDEX IF NOT EXISTS idx_edges_source ON learning_edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON learning_edges(target_id);
  `);
}

function applyV11(database: Database.Database): void {
  // Add evaluation fields + 'evaluating' status to work_queue for execute→evaluate→adjust loop
  // Must recreate table to update CHECK constraint (SQLite limitation)
  database.exec(`
    CREATE TABLE IF NOT EXISTS work_queue_v11 (
      id                TEXT PRIMARY KEY,
      source            TEXT NOT NULL,
      source_id         TEXT,
      channel_id        TEXT NOT NULL,
      prompt            TEXT NOT NULL,
      agent             TEXT,
      priority          INTEGER NOT NULL DEFAULT 50,
      status            TEXT NOT NULL CHECK (status IN ('proposed','approved','pending','gated','running','evaluating','completed','failed','cancelled')),
      gate_reason       TEXT,
      depends_on        TEXT,
      scheduled_at      TEXT,
      started_at        TEXT,
      completed_at      TEXT,
      task_id           TEXT,
      attempt           INTEGER NOT NULL DEFAULT 0,
      max_attempts      INTEGER NOT NULL DEFAULT 3,
      last_error        TEXT,
      metadata          TEXT,
      evaluation_prompt TEXT,
      evaluation_result TEXT,
      iteration         INTEGER NOT NULL DEFAULT 0,
      max_iterations    INTEGER NOT NULL DEFAULT 3,
      parent_id         TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO work_queue_v11 (id, source, source_id, channel_id, prompt, agent, priority, status, gate_reason, depends_on, scheduled_at, started_at, completed_at, task_id, attempt, max_attempts, last_error, metadata, created_at, updated_at)
      SELECT id, source, source_id, channel_id, prompt, agent, priority, status, gate_reason, depends_on, scheduled_at, started_at, completed_at, task_id, attempt, max_attempts, last_error, metadata, created_at, updated_at FROM work_queue;
    DROP TABLE work_queue;
    ALTER TABLE work_queue_v11 RENAME TO work_queue;
    CREATE INDEX IF NOT EXISTS idx_work_queue_status ON work_queue(status);
    CREATE INDEX IF NOT EXISTS idx_work_queue_priority ON work_queue(priority DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_work_queue_source ON work_queue(source);
    CREATE INDEX IF NOT EXISTS idx_work_queue_channel ON work_queue(channel_id);
    CREATE INDEX IF NOT EXISTS idx_work_queue_scheduled ON work_queue(scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_work_queue_parent ON work_queue(parent_id);
  `);
}

function applyV12(database: Database.Database): void {
  // Tag each session row with the runtime that issued the session id.
  // Claude session ids and Codex thread ids are both UUID-shaped but belong
  // to different systems — they can't be resumed cross-runtime. Default to
  // 'claude' for existing rows so pre-migration behavior is unchanged.
  database.exec(`
    ALTER TABLE sessions ADD COLUMN runtime TEXT NOT NULL DEFAULT 'claude';
  `);
}

function applyV13(database: Database.Database): void {
  database.exec(`
    ALTER TABLE channel_configs ADD COLUMN runtime TEXT;
    ALTER TABLE task_queue ADD COLUMN runtime TEXT;
  `);
}

function applyV14(database: Database.Database): void {
  database.exec(`
    ALTER TABLE subagents ADD COLUMN runtime TEXT NOT NULL DEFAULT 'claude';
    ALTER TABLE dead_letter ADD COLUMN runtime TEXT;
  `);
}

function applyV15(database: Database.Database): void {
  database.exec(`
    ALTER TABLE parallel_tasks ADD COLUMN runtime TEXT NOT NULL DEFAULT 'claude';
  `);
}

function migrateFromJson(database: Database.Database): void {
  const discordDir = join(HARNESS_ROOT, "bridges", "discord");

  // Migrate sessions.json
  const sessionsPath = join(discordDir, "sessions.json");
  if (existsSync(sessionsPath)) {
    const count = database.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number };
    if (count.c === 0) {
      try {
        const data = JSON.parse(readFileSync(sessionsPath, "utf-8"));
        const insert = database.prepare(
          "INSERT INTO sessions (channel_id, session_id, created_at, last_used) VALUES (?, ?, ?, ?)"
        );
        let migrated = 0;
        for (const [channelId, entry] of Object.entries(data) as [string, any][]) {
          insert.run(channelId, entry.sessionId, entry.createdAt, entry.lastUsed);
          migrated++;
        }
        renameSync(sessionsPath, sessionsPath + ".bak");
        console.log(`[DB] Migrated ${migrated} sessions from JSON`);
      } catch (err: any) {
        console.error(`[DB] Failed to migrate sessions.json: ${err.message}`);
      }
    }
  }

  // Migrate channel-config.json
  const configPath = join(discordDir, "channel-config.json");
  if (existsSync(configPath)) {
    const count = database.prepare("SELECT COUNT(*) as c FROM channel_configs").get() as { c: number };
    if (count.c === 0) {
      try {
        const data = JSON.parse(readFileSync(configPath, "utf-8"));
        const insert = database.prepare(
          "INSERT INTO channel_configs (channel_id, agent, permission_mode, allowed_tools, disallowed_tools, model, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        );
        let migrated = 0;
        for (const [channelId, entry] of Object.entries(data) as [string, any][]) {
          insert.run(
            channelId,
            entry.agent || null,
            entry.permissionMode || null,
            entry.allowedTools ? JSON.stringify(entry.allowedTools) : null,
            entry.disallowedTools ? JSON.stringify(entry.disallowedTools) : null,
            entry.model || null,
            entry.updatedAt || new Date().toISOString()
          );
          migrated++;
        }
        renameSync(configPath, configPath + ".bak");
        console.log(`[DB] Migrated ${migrated} channel configs from JSON`);
      } catch (err: any) {
        console.error(`[DB] Failed to migrate channel-config.json: ${err.message}`);
      }
    }
  }

  // Migrate subagents.json
  const subagentsPath = join(discordDir, "subagents.json");
  if (existsSync(subagentsPath)) {
    const count = database.prepare("SELECT COUNT(*) as c FROM subagents").get() as { c: number };
    if (count.c === 0) {
      try {
        const data = JSON.parse(readFileSync(subagentsPath, "utf-8"));
        const insert = database.prepare(
          "INSERT INTO subagents (id, parent_channel_id, description, agent, output_file, pid, status, started_at, completed_at, stream_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        );
        let migrated = 0;
        for (const [, entry] of Object.entries(data) as [string, any][]) {
          insert.run(
            entry.id,
            entry.parentChannelId,
            entry.description,
            entry.agent || null,
            entry.outputFile,
            entry.pid,
            entry.status,
            entry.startedAt,
            entry.completedAt || null,
            entry.streamMessageId || null
          );
          migrated++;
        }
        renameSync(subagentsPath, subagentsPath + ".bak");
        console.log(`[DB] Migrated ${migrated} subagents from JSON`);
      } catch (err: any) {
        console.error(`[DB] Failed to migrate subagents.json: ${err.message}`);
      }
    }
  }

  // Migrate projects.json
  const projectsPath = join(discordDir, "projects.json");
  if (existsSync(projectsPath)) {
    const count = database.prepare("SELECT COUNT(*) as c FROM projects").get() as { c: number };
    if (count.c === 0) {
      try {
        const data = JSON.parse(readFileSync(projectsPath, "utf-8"));
        const insert = database.prepare(
          "INSERT INTO projects (channel_id, category_id, guild_id, name, description, agents, active_agent, handoff_depth, max_handoff_depth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        );
        let migrated = 0;
        for (const [, entry] of Object.entries(data) as [string, any][]) {
          insert.run(
            entry.channelId,
            entry.categoryId,
            entry.guildId,
            entry.name,
            entry.description,
            JSON.stringify(entry.agents),
            entry.activeAgent || null,
            entry.handoffDepth || 0,
            entry.maxHandoffDepth || 5,
            entry.createdAt || new Date().toISOString()
          );
          migrated++;
        }
        renameSync(projectsPath, projectsPath + ".bak");
        console.log(`[DB] Migrated ${migrated} projects from JSON`);
      } catch (err: any) {
        console.error(`[DB] Failed to migrate projects.json: ${err.message}`);
      }
    }
  }
}
