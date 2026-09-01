type ProactiveMessageLike = {
  source?: unknown;
  proactive_id?: unknown;
  proactiveId?: unknown;
  bubble_index?: unknown;
  bubbleIndex?: unknown;
};

export function proactiveBubbleKey(value: ProactiveMessageLike): string | null {
  if (value.source !== 'proactive') return null;
  const proactiveId = typeof value.proactive_id === 'string'
    ? value.proactive_id
    : typeof value.proactiveId === 'string'
      ? value.proactiveId
      : '';
  const bubbleIndex = typeof value.bubble_index === 'number'
    ? value.bubble_index
    : typeof value.bubbleIndex === 'number'
      ? value.bubbleIndex
      : null;
  return proactiveId && bubbleIndex !== null ? `${proactiveId}:${bubbleIndex}` : null;
}

export function appendUniqueProactive<T extends ProactiveMessageLike>(
  current: T[],
  incoming: T[],
): T[] {
  const seen = new Set(current.map(proactiveBubbleKey).filter((key): key is string => key !== null));
  const additions = incoming.filter((message) => {
    const key = proactiveBubbleKey(message);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return additions.length ? [...current, ...additions] : current;
}

export function mergeHistoryWithLiveProactive<T extends ProactiveMessageLike>(
  history: T[],
  current: T[],
): T[] {
  return appendUniqueProactive(
    history,
    current.filter((message) => proactiveBubbleKey(message) !== null),
  );
}
