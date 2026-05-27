import type { HandoffDirective } from "./handoff-router.js";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export function isProjectAutoChainEnabled(): boolean {
  return TRUE_VALUES.has((process.env.PROJECT_AUTO_CHAIN_ENABLED || "").trim().toLowerCase());
}

export function formatManualHandoffNotice(
  fromAgent: string,
  handoff: HandoffDirective,
): string {
  const targetAgent = handoff.targetAgent || "agent";
  const handoffText = handoff.message.slice(0, 900);
  return [
    `*${capitalize(fromAgent)} requested a handoff to ${capitalize(targetAgent)}, but automatic project chains are disabled.*`,
    "",
    "Continue manually with:",
    `\`${targetAgent}: ${handoffText}\``,
    "",
    "Set `PROJECT_AUTO_CHAIN_ENABLED=1` to restore automatic project-chain execution.",
  ].join("\n");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
