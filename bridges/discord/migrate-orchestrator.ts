/**
 * One-shot migration: Add orchestrator as default agent to all existing projects.
 *
 * For each project:
 * 1. Prepend "orchestrator" to the agents array (if not already present)
 * 2. Set the channel_config active agent to "orchestrator"
 *
 * Run: HARNESS_ROOT=/path/to/AI-Harness npx tsx bridges/discord/migrate-orchestrator.ts
 */

import { getDb, closeDb } from "./db.js";

const db = getDb();

interface ProjectRow {
  channel_id: string;
  name: string;
  agents: string;
  active_agent: string | null;
}

const projects = db.prepare("SELECT channel_id, name, agents, active_agent FROM projects").all() as ProjectRow[];

if (projects.length === 0) {
  console.log("No projects found. Nothing to migrate.");
  closeDb();
  process.exit(0);
}

let updated = 0;

const updateAgents = db.prepare("UPDATE projects SET agents = ? WHERE channel_id = ?");
const upsertConfig = db.prepare(`
  INSERT INTO channel_configs (channel_id, agent, updated_at)
  VALUES (?, 'orchestrator', datetime('now'))
  ON CONFLICT(channel_id) DO UPDATE SET agent = 'orchestrator', updated_at = datetime('now')
`);

const txn = db.transaction(() => {
  for (const project of projects) {
    const agents: string[] = JSON.parse(project.agents);

    if (agents.includes("orchestrator")) {
      console.log(`  [skip] ${project.name} — already has orchestrator`);
      continue;
    }

    // Prepend orchestrator
    const newAgents = ["orchestrator", ...agents];
    updateAgents.run(JSON.stringify(newAgents), project.channel_id);

    // Set channel config to orchestrator as active agent
    upsertConfig.run(project.channel_id);

    console.log(`  [updated] ${project.name} — agents: ${newAgents.join(", ")}`);
    updated++;
  }
});

console.log(`\nMigrating ${projects.length} project(s)...\n`);
txn();
console.log(`\nDone. Updated ${updated}/${projects.length} projects.`);

closeDb();
