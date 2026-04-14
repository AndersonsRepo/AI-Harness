/**
 * Channel Queue — per-channel task serialization.
 *
 * Ensures only one Claude task runs per channel at a time.
 * Extracted from bot.ts so monitor-interventions can release channels on kill.
 */

import type { Message } from "discord.js";

export interface QueuedTask {
  execute: () => void;
  message: Message;
}

const channelQueues: Map<string, QueuedTask[]> = new Map();
const activeChannels: Set<string> = new Set();

export function processChannelQueue(channelId: string): void {
  if (activeChannels.has(channelId)) return;

  const queue = channelQueues.get(channelId);
  if (!queue || queue.length === 0) return;

  const task = queue.shift()!;
  activeChannels.add(channelId);

  task.execute();
}

export function releaseChannel(channelId: string): void {
  activeChannels.delete(channelId);
  // Try to process this channel's next task
  processChannelQueue(channelId);
  // Try to unblock other channels that were waiting on global capacity
  channelQueues.forEach((queue, queuedChannelId) => {
    if (queue.length > 0 && !activeChannels.has(queuedChannelId)) {
      processChannelQueue(queuedChannelId);
    }
  });
}

export function enqueueTask(channelId: string, task: QueuedTask): boolean {
  if (!channelQueues.has(channelId)) {
    channelQueues.set(channelId, []);
  }

  const isQueued = activeChannels.has(channelId);
  channelQueues.get(channelId)!.push(task);
  processChannelQueue(channelId);
  return isQueued;
}

export function isChannelActive(channelId: string): boolean {
  return activeChannels.has(channelId);
}
