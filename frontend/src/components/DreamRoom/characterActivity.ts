import type { ChatDeliveryState } from './chatDeliveryMachine';
import type { CharacterActivity } from './AvatarStage';

interface CharacterActivityInput {
  focusActive: boolean;
  isTyping: boolean;
  requestStates: Iterable<ChatDeliveryState | string>;
  needsAttention: boolean;
}

/**
 * Resolve one visible character action with an explicit, stable priority.
 *
 * A single action is important for deterministic avatar mapping: lower-priority
 * ambient events must never interrupt focus or an in-flight delivery.
 */
export function deriveCharacterActivity({
  focusActive,
  isTyping,
  requestStates,
  needsAttention,
}: CharacterActivityInput): CharacterActivity {
  if (focusActive) return 'focus.loop';

  const states = new Set(requestStates);
  if (isTyping || states.has('delivering')) return 'chat.deliver';
  if (states.has('ready_waiting')) return 'chat.ready';
  if (states.has('generating') || states.has('queued')) return 'chat.thinking';
  if (needsAttention) return 'attention';
  return 'idle.default';
}
