/**
 * One-shot script: bulk-delete duplicate embed messages in #monitor that
 * resulted from the onInstanceRegistered race (fixed in 2d988c1 / 44194c1).
 *
 * Usage:
 *   HARNESS_ROOT=$PWD npx --prefix bridges/discord tsx bridges/discord/scripts/purge-monitor-loop.ts
 *
 * Discord caveats handled:
 *   - bulkDelete refuses messages older than 14 days; we filter by age.
 *   - bulkDelete only takes ≤100 messages per call; we loop.
 *   - Only deletes messages authored by the bot itself (so unrelated user
 *     messages in #monitor are never touched).
 *   - Dry-run mode by default; pass `--apply` to actually delete.
 */

import { config as loadEnv } from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Client, GatewayIntentBits, TextChannel, Message } from "discord.js";

// Resolve `.env` relative to the script so cwd doesn't matter.
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, "..", ".env") });

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("DISCORD_TOKEN missing in env");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const MONITOR_CHANNEL_NAME = "monitor";
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PER_BATCH = 100;
// Default window: last 24h. Override with `--since-hours N`.
const sinceHoursIdx = process.argv.indexOf("--since-hours");
const SINCE_MS = sinceHoursIdx >= 0
  ? parseFloat(process.argv[sinceHoursIdx + 1] || "24") * 60 * 60 * 1000
  : ONE_DAY_MS;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  let totalDeleted = 0;
  let totalCandidates = 0;
  const botUserId = client.user?.id;

  for (const guild of client.guilds.cache.values()) {
    await guild.channels.fetch();
    const channel = guild.channels.cache.find(
      (c) => c.name === MONITOR_CHANNEL_NAME && c.type === 0,
    ) as TextChannel | undefined;
    if (!channel) continue;

    console.log(`Scanning #${MONITOR_CHANNEL_NAME} in guild "${guild.name}"`);

    // Walk back through the channel in pages of 100 until we hit messages
    // older than the configured window. Both the user-supplied window and
    // Discord's hard 14-day bulkDelete limit clamp the cutoff.
    let beforeId: string | undefined = undefined;
    const cutoff = Date.now() - Math.min(SINCE_MS, FOURTEEN_DAYS_MS);
    console.log(`  Cutoff: ${new Date(cutoff).toISOString()} (${(SINCE_MS / 60 / 60 / 1000).toFixed(1)}h ago)`);
    let stop = false;

    while (!stop) {
      const fetched = await channel.messages.fetch({
        limit: 100,
        ...(beforeId ? { before: beforeId } : {}),
      });
      if (fetched.size === 0) break;

      const candidates: Message[] = [];
      for (const msg of fetched.values()) {
        if (msg.createdTimestamp < cutoff) {
          stop = true;
          continue;
        }
        // Only delete messages authored by the bot itself with at least
        // one embed — that's the shape the loop produced.
        if (msg.author.id !== botUserId) continue;
        if (msg.embeds.length === 0) continue;
        candidates.push(msg);
      }

      totalCandidates += candidates.length;

      if (candidates.length > 0) {
        if (APPLY) {
          // Try bulkDelete first (fast, ~1 API call per 100 messages).
          // Falls back to per-message delete if the bot lacks the
          // Manage Messages permission required by bulkDelete; per-message
          // delete works on the bot's own messages without that perm but
          // is rate-limited (~5/s per channel).
          for (let i = 0; i < candidates.length; i += MAX_PER_BATCH) {
            const batch = candidates.slice(i, i + MAX_PER_BATCH);
            let bulkSucceeded = false;
            try {
              const deleted = await channel.bulkDelete(batch, true);
              totalDeleted += deleted.size;
              console.log(`  bulkDelete: ${deleted.size}/${batch.length}`);
              bulkSucceeded = true;
            } catch (err: any) {
              if (err.code !== 50013) {
                // 50013 = Missing Permissions — fall back silently.
                // Other failures are worth surfacing.
                console.error(`  bulkDelete failed: ${err.message}`);
              }
            }
            if (!bulkSucceeded) {
              for (const msg of batch) {
                try {
                  await msg.delete();
                  totalDeleted++;
                  // Throttle to stay under Discord's 5/s per-channel.
                  await new Promise((r) => setTimeout(r, 250));
                } catch (err: any) {
                  console.error(`  delete ${msg.id} failed: ${err.message}`);
                }
              }
              console.log(`  per-message: ${batch.length} attempted`);
            }
          }
        } else {
          console.log(`  Would delete ${candidates.length} bot-authored embeds`);
        }
      }

      // Page back using the oldest fetched message id
      const oldest = fetched.last();
      if (!oldest) break;
      beforeId = oldest.id;
      if (fetched.size < 100) break;
    }
  }

  console.log("---");
  if (APPLY) {
    console.log(`Deleted ${totalDeleted} of ${totalCandidates} candidates`);
  } else {
    console.log(`DRY RUN — ${totalCandidates} candidates would be deleted. Re-run with --apply.`);
  }
  await client.destroy();
  process.exit(0);
});

client.login(TOKEN);
