/**
 * Monitor Interventions — Button interaction handlers for the instance monitor.
 *
 * Handles: Kill, Redirect, Inject, Pause/Resume
 * Registered via client.on("interactionCreate") in bot.ts
 */

import {
  ButtonInteraction,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Interaction,
} from "discord.js";
import {
  getInstance,
  setHoldContinuation,
  setInterventionNote,
  updateInstanceStatus,
} from "./instance-monitor.js";
import { cancelTask, submitTask, spawnTask, getTask } from "./task-runner.js";
import { listAgentNames } from "./agent-loader.js";
import { proc } from "./platform.js";

// ─── Main Interaction Router ─────────────────────────────────────────

export async function handleMonitorInteraction(interaction: Interaction): Promise<boolean> {
  // Button clicks
  if (interaction.isButton() && interaction.customId.startsWith("monitor:")) {
    await handleButton(interaction);
    return true;
  }

  // Select menu (agent redirect)
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("monitor:select-agent:")) {
    await handleAgentSelect(interaction);
    return true;
  }

  // Modal submit (inject note)
  if (interaction.isModalSubmit() && interaction.customId.startsWith("monitor:inject-modal:")) {
    await handleInjectModal(interaction);
    return true;
  }

  return false;
}

// ─── Button Handlers ─────────────────────────────────────────────────

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const parts = interaction.customId.split(":");
  const action = parts[1]; // kill, redirect, inject, pause, resume
  const taskId = parts[2];

  const instance = getInstance(taskId);
  if (!instance) {
    await interaction.reply({ content: "Task no longer active.", ephemeral: true });
    return;
  }

  switch (action) {
    case "kill":
      await handleKill(interaction, taskId);
      break;
    case "redirect":
      await handleRedirect(interaction, taskId);
      break;
    case "inject":
      await handleInject(interaction, taskId);
      break;
    case "pause":
      await handlePause(interaction, taskId);
      break;
    case "resume":
      await handleResume(interaction, taskId);
      break;
    default:
      await interaction.reply({ content: `Unknown action: ${action}`, ephemeral: true });
  }
}

// ─── Kill ────────────────────────────────────────────────────────────

async function handleKill(interaction: ButtonInteraction, taskId: string): Promise<void> {
  const instance = getInstance(taskId);
  if (!instance) {
    await interaction.reply({ content: "Task already completed.", ephemeral: true });
    return;
  }

  proc.terminate(instance.pid);

  cancelTask(taskId);
  updateInstanceStatus(taskId, "killed");

  await interaction.reply({
    content: `Killed task \`${taskId}\` (${instance.agent} agent, PID ${instance.pid})`,
    ephemeral: true,
  });
  console.log(`[MONITOR] User killed task ${taskId}`);
}

// ─── Redirect ────────────────────────────────────────────────────────

async function handleRedirect(interaction: ButtonInteraction, taskId: string): Promise<void> {
  const instance = getInstance(taskId);
  if (!instance) {
    await interaction.reply({ content: "Task already completed.", ephemeral: true });
    return;
  }

  const agents = listAgentNames().filter((a) => a !== instance.agent);
  if (agents.length === 0) {
    await interaction.reply({ content: "No other agents available.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`monitor:select-agent:${taskId}`)
    .setPlaceholder("Select target agent")
    .addOptions(
      agents.slice(0, 25).map((a) => ({
        label: a.charAt(0).toUpperCase() + a.slice(1),
        value: a,
        description: `Redirect to ${a} agent`,
      }))
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

  await interaction.reply({
    content: `Redirect task from **${instance.agent}** to:`,
    components: [row],
    ephemeral: true,
  });
}

async function handleAgentSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const taskId = interaction.customId.replace("monitor:select-agent:", "");
  const targetAgent = interaction.values[0];
  const instance = getInstance(taskId);

  if (!instance) {
    await interaction.update({ content: "Task already completed.", components: [] });
    return;
  }

  // Kill current task
  try {
    process.kill(instance.pid, "SIGTERM");
  } catch {}
  cancelTask(taskId);
  updateInstanceStatus(taskId, "killed");

  // Re-submit with new agent
  const newTaskId = submitTask({
    channelId: instance.channelId,
    prompt: instance.prompt,
    agent: targetAgent,
    maxSteps: 10,
    maxAttempts: 3,
  });

  await spawnTask(newTaskId);

  await interaction.update({
    content: `Redirected to **${targetAgent}** agent (new task: \`${newTaskId}\`)`,
    components: [],
  });
  console.log(`[MONITOR] Redirected ${taskId} from ${instance.agent} → ${targetAgent}`);
}

// ─── Inject ──────────────────────────────────────────────────────────

async function handleInject(interaction: ButtonInteraction, taskId: string): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`monitor:inject-modal:${taskId}`)
    .setTitle("Inject Guidance");

  const input = new TextInputBuilder()
    .setCustomId("guidance")
    .setLabel("Guidance to inject on next step")
    .setPlaceholder("e.g., Focus on the auth module, skip the tests for now")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(500);

  const row = new ActionRowBuilder<TextInputBuilder>().addComponents(input);
  modal.addComponents(row);

  await interaction.showModal(modal);
}

async function handleInjectModal(interaction: ModalSubmitInteraction): Promise<void> {
  const taskId = interaction.customId.replace("monitor:inject-modal:", "");
  const guidance = interaction.fields.getTextInputValue("guidance");

  const success = setInterventionNote(taskId, guidance);
  if (success) {
    await interaction.reply({
      content: `Guidance injected for task \`${taskId}\`:\n> ${guidance}\n\nWill be applied on the next continuation step.`,
      ephemeral: true,
    });
  } else {
    await interaction.reply({ content: "Task no longer active.", ephemeral: true });
  }
}

// ─── Pause / Resume ──────────────────────────────────────────────────

async function handlePause(interaction: ButtonInteraction, taskId: string): Promise<void> {
  const success = setHoldContinuation(taskId, true);
  if (success) {
    await interaction.reply({
      content: `Paused task \`${taskId}\` — continuation will be held after the current step.`,
      ephemeral: true,
    });
  } else {
    await interaction.reply({ content: "Task not found.", ephemeral: true });
  }
}

async function handleResume(interaction: ButtonInteraction, taskId: string): Promise<void> {
  setHoldContinuation(taskId, false);

  // Check if the task was waiting to continue
  const task = getTask(taskId);
  if (task && task.status === "waiting_continue") {
    await spawnTask(taskId);
    await interaction.reply({
      content: `Resumed task \`${taskId}\` — spawning next step.`,
      ephemeral: true,
    });
  } else {
    await interaction.reply({
      content: `Resumed task \`${taskId}\` — will continue on next [CONTINUE].`,
      ephemeral: true,
    });
  }
}
