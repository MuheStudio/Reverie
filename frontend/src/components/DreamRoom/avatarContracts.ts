export const AVATAR_ACTION_KEYS = [
  'idle.default',
  'chat.thinking',
  'chat.ready',
  'chat.deliver',
  'focus.enter',
  'focus.loop',
  'focus.complete',
  'attention',
] as const;

export const AVATAR_EXPRESSION_KEYS = [
  'neutral',
  'joy',
  'sad',
  'angry',
  'surprised',
  'calm',
] as const;

export type CharacterActivity = typeof AVATAR_ACTION_KEYS[number];
export type AvatarExpressionKey = typeof AVATAR_EXPRESSION_KEYS[number];

export interface AvatarDetectedCapabilities {
  animationClips: string[];
  expressions: string[];
  actionMatches: Partial<Record<CharacterActivity, string>>;
  expressionMatches: Partial<Record<AvatarExpressionKey, string>>;
  vrmaPlayback: boolean;
}
