import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const harnessRoot = mkdtempSync(join(tmpdir(), "aih-mcp-config-"));
mkdirSync(join(harnessRoot, "bridges", "discord"), { recursive: true });
process.env.HARNESS_ROOT = harnessRoot;

const { setChannelConfig } = await import("../channel-config-store.js");
const { buildMcpConfigFile, resolveAllowedMcps, DEFAULT_MCP_BASELINE } = await import(
  "../mcp-config-builder.js"
);

const REGISTRY_FIXTURE = {
  mcpServers: {
    vault: { type: "stdio", command: "/bin/vault" },
    harness: { type: "stdio", command: "/bin/harness" },
    projects: { type: "stdio", command: "/bin/projects" },
    codex: { type: "stdio", command: "/bin/codex" },
    linkedin: { type: "stdio", command: "/bin/linkedin" },
    calendar: { type: "stdio", command: "/bin/calendar" },
    trading: { type: "stdio", command: "/bin/trading" },
    brightdata: { type: "sse", url: "https://example.com" },
  },
};

const fixtureDir = mkdtempSync(join(tmpdir(), "aih-mcp-fixture-"));
const registryPath = join(fixtureDir, "claude.json");
writeFileSync(registryPath, JSON.stringify(REGISTRY_FIXTURE));

const outputDir = mkdtempSync(join(tmpdir(), "aih-mcp-out-"));

describe("mcp-config-builder", () => {
  after(() => {
    rmSync(harnessRoot, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
  });

  it("uses default baseline when channel has no allowedMcps set", () => {
    const channelId = "channel-no-override";
    const allowed = resolveAllowedMcps(channelId);
    assert.deepEqual(allowed, DEFAULT_MCP_BASELINE);
  });

  it("uses channel allowedMcps when set", () => {
    const channelId = "channel-with-override";
    setChannelConfig(channelId, { allowedMcps: ["vault", "linkedin"] });
    assert.deepEqual(resolveAllowedMcps(channelId), ["vault", "linkedin"]);
  });

  it("respects empty array (no MCPs)", () => {
    const channelId = "channel-empty";
    setChannelConfig(channelId, { allowedMcps: [] });
    assert.deepEqual(resolveAllowedMcps(channelId), []);
  });

  it("filters registry by default baseline and writes config file", () => {
    const channelId = "build-default";
    const result = buildMcpConfigFile({
      channelId,
      taskId: "test-default",
      registryPath,
      outputDir,
    });

    assert.ok(existsSync(result.configPath));
    assert.deepEqual(result.servers.sort(), DEFAULT_MCP_BASELINE.slice().sort());

    const written = JSON.parse(readFileSync(result.configPath, "utf-8"));
    const names = Object.keys(written.mcpServers).sort();
    assert.deepEqual(names, DEFAULT_MCP_BASELINE.slice().sort());
    assert.equal(written.mcpServers.vault.command, "/bin/vault");
  });

  it("filters registry by channel allowlist (e.g. trader channel)", () => {
    const channelId = "trader-channel";
    setChannelConfig(channelId, {
      allowedMcps: ["vault", "harness", "projects", "codex", "trading"],
    });

    const result = buildMcpConfigFile({
      channelId,
      taskId: "test-trader",
      registryPath,
      outputDir,
    });

    assert.deepEqual(
      result.servers.sort(),
      ["codex", "harness", "projects", "trading", "vault"]
    );

    const written = JSON.parse(readFileSync(result.configPath, "utf-8"));
    assert.equal(Object.keys(written.mcpServers).length, 5);
    assert.ok(written.mcpServers.trading);
    assert.equal(written.mcpServers.linkedin, undefined);
    assert.equal(written.mcpServers.calendar, undefined);
  });

  it("silently drops names that aren't in the registry", () => {
    const channelId = "channel-with-missing";
    setChannelConfig(channelId, {
      allowedMcps: ["vault", "nonexistent-server", "harness"],
    });

    const result = buildMcpConfigFile({
      channelId,
      taskId: "test-missing",
      registryPath,
      outputDir,
    });

    assert.deepEqual(result.servers.sort(), ["harness", "vault"]);
  });

  it("returns empty server list when registry file is missing", () => {
    const channelId = "channel-no-registry";
    const result = buildMcpConfigFile({
      channelId,
      taskId: "test-no-registry",
      registryPath: join(fixtureDir, "does-not-exist.json"),
      outputDir,
    });

    assert.deepEqual(result.servers, []);
    const written = JSON.parse(readFileSync(result.configPath, "utf-8"));
    assert.deepEqual(written.mcpServers, {});
  });

  it("returns empty server list when registry has no mcpServers field", () => {
    const emptyPath = join(fixtureDir, "empty.json");
    writeFileSync(emptyPath, JSON.stringify({ unrelated: "field" }));

    const result = buildMcpConfigFile({
      channelId: "channel-no-mcp-field",
      taskId: "test-no-field",
      registryPath: emptyPath,
      outputDir,
    });

    assert.deepEqual(result.servers, []);
  });

  it("persists allowedMcps round-trip through channel-config-store", () => {
    const channelId = "round-trip-channel";
    setChannelConfig(channelId, { allowedMcps: ["vault", "trading"] });

    const fresh = resolveAllowedMcps(channelId);
    assert.deepEqual(fresh, ["vault", "trading"]);
  });
});
