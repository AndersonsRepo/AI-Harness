import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { runMigrations } from "../db.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function columns(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return rows.map((r) => r.name);
}

describe("migrations on fresh DB", () => {
  it("applies all migrations in order without throwing", () => {
    const db = freshDb();
    assert.doesNotThrow(() => runMigrations(db));
    db.close();
  });

  it("results in exactly one runtime column on subagents", () => {
    const db = freshDb();
    runMigrations(db);
    const subagentCols = columns(db, "subagents").filter((c) => c === "runtime");
    assert.equal(subagentCols.length, 1, "subagents.runtime must be declared exactly once");
    db.close();
  });

  it("results in exactly one runtime column on dead_letter", () => {
    const db = freshDb();
    runMigrations(db);
    const deadLetterCols = columns(db, "dead_letter").filter((c) => c === "runtime");
    assert.equal(deadLetterCols.length, 1, "dead_letter.runtime must be declared exactly once");
    db.close();
  });

  it("results in exactly one runtime column on parallel_tasks", () => {
    const db = freshDb();
    runMigrations(db);
    const parallelCols = columns(db, "parallel_tasks").filter((c) => c === "runtime");
    assert.equal(parallelCols.length, 1, "parallel_tasks.runtime must be declared exactly once");
    db.close();
  });

  it("results in exactly one runtime column on sessions and channel_configs and task_queue", () => {
    const db = freshDb();
    runMigrations(db);
    for (const table of ["sessions", "channel_configs", "task_queue"]) {
      const cols = columns(db, table).filter((c) => c === "runtime");
      assert.equal(cols.length, 1, `${table}.runtime must be declared exactly once`);
    }
    db.close();
  });

  it("records the current schema version at the end", () => {
    const db = freshDb();
    runMigrations(db);
    const row = db.prepare("SELECT MAX(version) as v FROM schema_version").get() as { v: number };
    assert.ok(row.v >= 15, `expected schema_version >= 15, got ${row.v}`);
    db.close();
  });

  it("is idempotent on a second invocation", () => {
    const db = freshDb();
    runMigrations(db);
    const v1 = db
      .prepare("SELECT MAX(version) as v FROM schema_version")
      .get() as { v: number };
    // A second call should noop on an already-migrated DB — no throw, no version bump.
    assert.doesNotThrow(() => runMigrations(db));
    const v2 = db
      .prepare("SELECT MAX(version) as v FROM schema_version")
      .get() as { v: number };
    assert.equal(v1.v, v2.v, "second runMigrations call must not advance schema_version");
    db.close();
  });
});
