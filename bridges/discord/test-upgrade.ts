/**
 * Integration test for the SQLite + FileWatcher + TaskRunner upgrade.
 * Runs without Discord — tests the data layer and file watching.
 *
 * Usage: HARNESS_ROOT=$HOME/Desktop/AI-Harness npx tsx test-upgrade.ts
 */

import { writeFileSync, existsSync, unlinkSync, mkdirSync, renameSync, readFileSync } from "fs";
import { join, resolve, dirname } from "path";

const HARNESS_ROOT = process.env.HARNESS_ROOT || resolve(dirname(new URL(import.meta.url).pathname), "../..");
process.env.HARNESS_ROOT = HARNESS_ROOT;

const TEST_DB = join(HARNESS_ROOT, "bridges", "discord", "harness-test.db");

// Override the DB path for testing by setting env before import
// We'll test against the real DB path but clean up after
const REAL_DB = join(HARNESS_ROOT, "bridges", "discord", "harness.db");
const DB_BACKUP = REAL_DB + ".pre-test-backup";

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}`);
    failed++;
  }
}

async function main() {
  // Back up existing DB if present
  const hadExistingDb = existsSync(REAL_DB);
  if (hadExistingDb) {
    renameSync(REAL_DB, DB_BACKUP);
    console.log("(Backed up existing harness.db)");
  }

  try {
    await testDatabaseInit();
    await testSessionStore();
    await testChannelConfigStore();
    await testProcessRegistry();
    await testProjectManager();
    await testTaskRunner();
    await testFileWatcher();
    await testJsonMigration();
  } finally {
    // Clean up test DB
    const { closeDb } = await import("./db.js");
    closeDb();
    try { unlinkSync(REAL_DB); } catch {}
    try { unlinkSync(REAL_DB + "-wal"); } catch {}
    try { unlinkSync(REAL_DB + "-shm"); } catch {}

    // Restore backup if we had one
    if (hadExistingDb && existsSync(DB_BACKUP)) {
      renameSync(DB_BACKUP, REAL_DB);
      console.log("(Restored original harness.db)");
    }
  }

  console.log(`\n${"=".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(40)}`);
  process.exit(failed > 0 ? 1 : 0);
}

async function testDatabaseInit() {
  console.log("\n--- Database Init ---");
  const { getDb, closeDb } = await import("./db.js");

  const db = getDb();
  assert(db !== null, "getDb() returns a database instance");

  // Check tables exist
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all() as { name: string }[];
  const tableNames = tables.map(t => t.name);

  assert(tableNames.includes("sessions"), "sessions table exists");
  assert(tableNames.includes("channel_configs"), "channel_configs table exists");
  assert(tableNames.includes("subagents"), "subagents table exists");
  assert(tableNames.includes("projects"), "projects table exists");
  assert(tableNames.includes("task_queue"), "task_queue table exists");
  assert(tableNames.includes("dead_letter"), "dead_letter table exists");
  assert(tableNames.includes("schema_version"), "schema_version table exists");

  // Check WAL mode
  const journalMode = db.pragma("journal_mode", { simple: true }) as string;
  assert(journalMode === "wal", `WAL journal mode active (got: ${journalMode})`);

  // Check schema version
  const version = db.prepare("SELECT MAX(version) as v FROM schema_version").get() as { v: number };
  assert(version.v === 3, `Schema version is 3 (got: ${version.v})`);
}

async function testSessionStore() {
  console.log("\n--- Session Store ---");
  const { getSession, setSession, clearSession, validateSession, listSessions } = await import("./session-store.js");

  // Start clean
  assert(getSession("test-ch-1") === null, "No session initially");

  // Set and get
  setSession("test-ch-1", "sess-abc123");
  assert(getSession("test-ch-1") === "sess-abc123", "Session set and retrieved");

  // Overwrite
  setSession("test-ch-1", "sess-def456");
  assert(getSession("test-ch-1") === "sess-def456", "Session overwritten");

  // List
  setSession("test-ch-2", "sess-ghi789");
  const all = listSessions();
  assert(Object.keys(all).length >= 2, "listSessions returns multiple entries");
  assert(all["test-ch-1"]?.sessionId === "sess-def456", "listSessions has correct data");

  // Clear
  assert(clearSession("test-ch-1") === true, "clearSession returns true for existing");
  assert(getSession("test-ch-1") === null, "Session cleared");
  assert(clearSession("test-ch-1") === false, "clearSession returns false for non-existing");

  // Validate (clears stale)
  setSession("test-ch-3", "sess-stale");
  assert(validateSession("test-ch-3") === false, "validateSession returns false (stale cleared)");
  assert(getSession("test-ch-3") === null, "Stale session removed");
  assert(validateSession("test-ch-missing") === true, "validateSession returns true (no session)");
}

async function testChannelConfigStore() {
  console.log("\n--- Channel Config Store ---");
  const { getChannelConfig, setChannelConfig, clearChannelConfig, listConfigs } = await import("./channel-config-store.js");

  // Start clean
  assert(getChannelConfig("cfg-ch-1") === null, "No config initially");

  // Set
  const cfg = setChannelConfig("cfg-ch-1", { agent: "researcher", model: "opus" });
  assert(cfg.agent === "researcher", "Config agent set");
  assert(cfg.model === "opus", "Config model set");
  assert(cfg.updatedAt !== undefined, "Config has updatedAt");

  // Get
  const retrieved = getChannelConfig("cfg-ch-1");
  assert(retrieved?.agent === "researcher", "Config retrieved correctly");
  assert(retrieved?.model === "opus", "Config model retrieved");

  // Partial update (merge)
  setChannelConfig("cfg-ch-1", { model: "sonnet" });
  const updated = getChannelConfig("cfg-ch-1");
  assert(updated?.agent === "researcher", "Agent preserved on partial update");
  assert(updated?.model === "sonnet", "Model updated");

  // Array fields
  setChannelConfig("cfg-ch-2", { allowedTools: ["Read", "Write"], disallowedTools: ["Bash"] });
  const arrCfg = getChannelConfig("cfg-ch-2");
  assert(Array.isArray(arrCfg?.allowedTools), "allowedTools is an array");
  assert(arrCfg?.allowedTools?.length === 2, "allowedTools has 2 items");
  assert(arrCfg?.disallowedTools?.[0] === "Bash", "disallowedTools correct");

  // Clear
  assert(clearChannelConfig("cfg-ch-1") === true, "clearChannelConfig returns true");
  assert(getChannelConfig("cfg-ch-1") === null, "Config cleared");

  // List
  const all = listConfigs();
  assert(Object.keys(all).length >= 1, "listConfigs returns entries");
}

async function testProcessRegistry() {
  console.log("\n--- Process Registry ---");
  const { register, update, get, getRunning, getByChannel, cleanupStale } = await import("./process-registry.js");

  // Register
  register({
    id: "sa-test-1",
    parentChannelId: "reg-ch-1",
    description: "Test subagent",
    agent: "builder",
    outputFile: "/tmp/test-output.json",
    pid: process.pid, // Use our own PID (alive)
    status: "running",
    startedAt: new Date().toISOString(),
  });

  // Get
  const entry = get("sa-test-1");
  assert(entry !== null, "Registered entry retrieved");
  assert(entry?.parentChannelId === "reg-ch-1", "parentChannelId correct");
  assert(entry?.agent === "builder", "agent correct");

  // Update
  const updated = update("sa-test-1", { status: "completed", completedAt: new Date().toISOString() });
  assert(updated?.status === "completed", "Status updated to completed");

  // Get running
  register({
    id: "sa-test-2",
    parentChannelId: "reg-ch-1",
    description: "Another subagent",
    outputFile: "/tmp/test-output2.json",
    pid: 99999999, // Fake PID (dead)
    status: "running",
    startedAt: new Date().toISOString(),
  });

  const running = getRunning();
  assert(running.some(e => e.id === "sa-test-2"), "Running entries include sa-test-2");

  // Get by channel
  const byChannel = getByChannel("reg-ch-1");
  assert(byChannel.length >= 2, "getByChannel returns entries for channel");

  // Cleanup stale (PID 99999999 should be dead)
  const cleaned = cleanupStale();
  assert(cleaned >= 1, `cleanupStale found dead PIDs (cleaned: ${cleaned})`);
  const afterCleanup = get("sa-test-2");
  assert(afterCleanup?.status === "failed", "Dead PID marked as failed");
}

async function testProjectManager() {
  console.log("\n--- Project Manager ---");
  const {
    getProject, getProjectByName, listProjects, updateProject, deleteProject,
    resetHandoffDepth, incrementHandoffDepth, isProjectChannel,
    autoAdoptIfInCategory, adoptChannel, getProjectsCategoryName
  } = await import("./project-manager.js");

  // Adopt a channel as a project (doesn't need Discord API)
  const uniqueSuffix = Date.now().toString(36);
  const projName = `proj-testproj${uniqueSuffix}`;
  const project = adoptChannel(`proj-ch-${uniqueSuffix}`, projName, "cat-1", "guild-1", "Test project");
  const expectedName = projName.replace(/^proj-/, "");
  assert(project.name === expectedName, "Project name stripped of proj- prefix");
  assert(project.description === "Test project", "Description set");
  assert(project.agents.length === 5, "Default agents assigned");

  const projChId = `proj-ch-${uniqueSuffix}`;

  // Get
  assert(getProject(projChId) !== null, "getProject finds adopted project");
  assert(getProjectByName(expectedName) !== null, "getProjectByName works");
  assert(isProjectChannel(projChId) === true, "isProjectChannel returns true");
  assert(isProjectChannel("unknown") === false, "isProjectChannel returns false for unknown");

  // Update
  updateProject(projChId, { agents: ["researcher", "builder"] });
  const updated = getProject(projChId);
  assert(updated?.agents.length === 2, "Agents updated");

  // Handoff depth
  resetHandoffDepth(projChId);
  assert(getProject(projChId)?.handoffDepth === 0, "Handoff depth reset");
  const depth1 = incrementHandoffDepth(projChId);
  assert(depth1 === 1, "Handoff depth incremented to 1");
  const depth2 = incrementHandoffDepth(projChId);
  assert(depth2 === 2, "Handoff depth incremented to 2");

  // List
  const all = listProjects();
  assert(all.length >= 1, "listProjects returns entries");

  // Auto-adopt (already registered → returns null)
  assert(autoAdoptIfInCategory(projChId, projName, "cat-1", "guild-1") === null, "Auto-adopt skips already registered");

  // Auto-adopt new channel
  const adoptChId2 = `proj-ch-auto-${uniqueSuffix}`;
  const adopted = autoAdoptIfInCategory(adoptChId2, `proj-autoadopt${uniqueSuffix}`, "cat-1", "guild-1");
  assert(adopted !== null, "Auto-adopt registers new channel");
  assert(adopted?.name === `autoadopt${uniqueSuffix}`, "Auto-adopted name correct");

  // Delete
  assert(deleteProject(projChId) === true, "deleteProject returns true");
  assert(getProject(projChId) === null, "Project deleted");

  // Clean up auto-adopted project
  deleteProject(adoptChId2);

  // Category name
  assert(getProjectsCategoryName() === "Projects", "Category name is Projects");
}

async function testTaskRunner() {
  console.log("\n--- Task Runner ---");
  const {
    submitTask, getTask, getRunningTasks, getPendingTasks,
    getGlobalRunningCount, getRunningCountForChannel,
    listDeadLetters, pruneDeadLetters, needsContinuation,
    extractResponse, extractSessionId,
  } = await import("./task-runner.js");

  // Extract helpers
  const jsonOutput = '{"type":"result","session_id":"sess-123","result":"Hello world"}';
  assert(extractResponse(jsonOutput) === "Hello world", "extractResponse parses JSON result");
  assert(extractSessionId(jsonOutput) === "sess-123", "extractSessionId parses session ID");

  // needsContinuation
  assert(needsContinuation("Some work done [CONTINUE]") === true, "needsContinuation detects [CONTINUE]");
  assert(needsContinuation("All done, goodbye.") === false, "needsContinuation false for normal response");
  assert(needsContinuation("I'll continue working") === false, "needsContinuation false for 'I'll continue' (no marker)");

  // Submit task
  const taskId = submitTask({
    channelId: "task-ch-1",
    prompt: "Test prompt",
    agent: "researcher",
    sessionKey: "task-ch-1",
  });
  assert(taskId.startsWith("task-"), "submitTask returns task ID");

  // Get task
  const task = getTask(taskId);
  assert(task !== null, "getTask retrieves submitted task");
  assert(task?.status === "pending", "Task status is pending");
  assert(task?.prompt === "Test prompt", "Task prompt correct");
  assert(task?.agent === "researcher", "Task agent correct");
  assert(task?.step_count === 0, "Task step_count is 0");
  assert(task?.attempt === 0, "Task attempt is 0");
  assert(task?.max_steps === 10, "Task max_steps default is 10");
  assert(task?.max_attempts === 3, "Task max_attempts default is 3");

  // Pending tasks
  const pending = getPendingTasks();
  assert(pending.some(t => t.id === taskId), "Task appears in pending list");

  // Running count (should be 0 since we didn't spawn)
  assert(getGlobalRunningCount() === 0, "Global running count is 0");
  assert(getRunningCountForChannel("task-ch-1") === 0, "Channel running count is 0");

  // Dead letters (should be empty)
  assert(listDeadLetters().length === 0, "No dead letters initially");

  // Prune (no-op)
  assert(pruneDeadLetters(7) === 0, "Prune returns 0 when empty");

  // Submit and verify dead-letter flow by writing directly to dead_letter table
  const { getDb } = await import("./db.js");
  const db = getDb();
  db.prepare(`
    INSERT INTO dead_letter (id, task_id, channel_id, prompt, agent, error, attempts, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run("dl-test-1", taskId, "task-ch-1", "Test prompt", "researcher", "Test error", 3);

  const deadLetters = listDeadLetters();
  assert(deadLetters.length === 1, "Dead letter inserted");
  assert(deadLetters[0].error === "Test error", "Dead letter error correct");

  const channelDl = listDeadLetters("task-ch-1");
  assert(channelDl.length === 1, "Dead letter filtered by channel");
}

async function testFileWatcher() {
  console.log("\n--- File Watcher ---");
  const { FileWatcher, trackWatcher, untrackWatcher, stopAllWatchers } = await import("./file-watcher.js");

  const testDir = join(HARNESS_ROOT, "bridges", "discord", ".tmp", "test-watcher");
  try { mkdirSync(testDir, { recursive: true }); } catch {}
  const testFile = join(testDir, "output.json");

  // Clean up any prior test file
  try { unlinkSync(testFile); } catch {}

  // Test: FileWatcher detects a file written after start
  const detected = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("FileWatcher timed out")), 10000);

    const watcher = new FileWatcher({
      filePath: testFile,
      onFile: (content) => {
        clearTimeout(timeout);
        untrackWatcher(watcher);
        resolve(content);
      },
      onTimeout: () => {
        clearTimeout(timeout);
        untrackWatcher(watcher);
        reject(new Error("FileWatcher onTimeout called"));
      },
      timeoutMs: 10000,
      fallbackPollMs: 500, // Fast poll for test
      retryReadMs: 50,
    });

    trackWatcher(watcher);
    watcher.start();

    // Write file after 300ms (simulating Claude output)
    setTimeout(() => {
      writeFileSync(testFile, '{"result":"test-data"}');
    }, 300);
  });

  assert(detected === '{"result":"test-data"}', "FileWatcher detected file and read content");

  // Test: FileWatcher timeout
  const testFile2 = join(testDir, "timeout-output.json");
  try { unlinkSync(testFile2); } catch {}

  const timedOut = await new Promise<boolean>((resolve) => {
    const watcher = new FileWatcher({
      filePath: testFile2,
      onFile: () => { resolve(false); },
      onTimeout: () => {
        untrackWatcher(watcher);
        resolve(true);
      },
      timeoutMs: 500, // Short timeout for test
      fallbackPollMs: 200,
    });
    trackWatcher(watcher);
    watcher.start();
    // Don't write the file — let it timeout
  });

  assert(timedOut === true, "FileWatcher timeout fires correctly");

  // Test: stopAllWatchers
  const watcher3 = new FileWatcher({
    filePath: join(testDir, "never.json"),
    onFile: () => {},
    fallbackPollMs: 60000,
  });
  trackWatcher(watcher3);
  watcher3.start();
  stopAllWatchers();
  assert(watcher3.isStopped(), "stopAllWatchers stops tracked watchers");

  // Cleanup
  try { unlinkSync(testFile); } catch {}
  try { unlinkSync(testDir); } catch {}
}

async function testJsonMigration() {
  console.log("\n--- JSON Migration ---");
  const { closeDb, getDb } = await import("./db.js");

  // Close current DB so we can test migration
  closeDb();

  // Remove the test DB
  try { unlinkSync(REAL_DB); } catch {}
  try { unlinkSync(REAL_DB + "-wal"); } catch {}
  try { unlinkSync(REAL_DB + "-shm"); } catch {}

  const discordDir = join(HARNESS_ROOT, "bridges", "discord");

  // Create fake JSON files
  const sessionsJson = join(discordDir, "sessions.json");
  const configJson = join(discordDir, "channel-config.json");

  writeFileSync(sessionsJson, JSON.stringify({
    "migrate-ch-1": { sessionId: "sess-migrate-1", createdAt: "2026-01-01T00:00:00Z", lastUsed: "2026-01-01T00:00:00Z" }
  }));
  writeFileSync(configJson, JSON.stringify({
    "migrate-ch-1": { agent: "builder", updatedAt: "2026-01-01T00:00:00Z" }
  }));

  // Re-init DB (triggers migration)
  const db = getDb();

  // Check data was migrated
  const session = db.prepare("SELECT * FROM sessions WHERE channel_id = 'migrate-ch-1'").get() as any;
  assert(session !== undefined, "Session migrated from JSON");
  assert(session?.session_id === "sess-migrate-1", "Migrated session ID correct");

  const config = db.prepare("SELECT * FROM channel_configs WHERE channel_id = 'migrate-ch-1'").get() as any;
  assert(config !== undefined, "Config migrated from JSON");
  assert(config?.agent === "builder", "Migrated config agent correct");

  // Check .json.bak files created
  assert(existsSync(sessionsJson + ".bak"), "sessions.json.bak created");
  assert(existsSync(configJson + ".bak"), "channel-config.json.bak created");
  assert(!existsSync(sessionsJson), "sessions.json removed (renamed to .bak)");
  assert(!existsSync(configJson), "channel-config.json removed (renamed to .bak)");

  // Cleanup backup files
  try { unlinkSync(sessionsJson + ".bak"); } catch {}
  try { unlinkSync(configJson + ".bak"); } catch {}
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(2);
});
