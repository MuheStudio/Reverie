/**
 * Opening-line extraction for imported character cards.
 *
 * A SillyTavern-imported persona carries its first message and alternate
 * greetings inside the identity document. This module turns that untrusted
 * payload into a bounded, display-only list of greeting options for the chat
 * panel's empty state. It never executes anything and never sends messages.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export const GREETING_OPTION_LIMIT = 50;

/**
 * Collect the imported character's opening lines (first message plus alternate
 * greetings) from the active persona's identity. Returns an empty array when
 * the persona was not imported from a character card or carries no greeting.
 */
export function greetingOptionsFromPersona(persona: unknown): string[] {
  const record = isRecord(persona) ? persona : null;
  const identity = isRecord(record?.identity) ? record.identity : null;
  if (!identity) return [];
  const first = asString(identity.first_message).trim();
  const alternates = Array.isArray(identity.alternate_greetings)
    ? identity.alternate_greetings
      .map(asString)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, GREETING_OPTION_LIMIT)
    : [];
  return [first, ...alternates].filter(Boolean);
}