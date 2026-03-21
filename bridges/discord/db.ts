import Database from "better-sqlite3";
import { existsSync, readFileSync, renameSync } from "fs";
import { join } from "path";

const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";
const DB_PATH = join(HARNESS_ROOT, "bridges", "discord", "harness.db");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  runMigrations(db);
  return db;
}

export function closeDb(): void {
  if (db) {
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
      discord_channel TEXT NOT NULL DEFAULT 'outlook',
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
