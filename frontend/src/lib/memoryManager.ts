/**
 * Memory Manager — hybrid memory system for character conversations.
 *
 * - Memories are stored as individual JSON files under
 *   ~/.openroom/sessions/{charId}/{modId}/memory/
 * - A compact summary is injected into the system prompt (SP injection)
 * - The LLM can save new memories via the `save_memory` tool
 */

import type { ToolDef } from './llmClient';

const API_PATH = '/api/session-data';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryEntry {
  id: string;
  content: string;
  category: 'fact' | 'preference' | 'event' | 'emotion' | 'other';
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export function getMemoryToolDefinitions(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: 'save_memory',
        description:
          'Save an important piece of information about the user to long-term memory. ' +
          'Use this when you learn something significant about the user that should be remembered across conversations. ' +
          'Examples: user preferences, important facts, emotional moments, key events.',
        parameters: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'The memory content to save (concise, one key fact per call)',
            },
            category: {
              type: 'string',
              description:
                'Category: "fact" (user facts), "preference" (likes/dislikes), "event" (what happened), "emotion" (emotional moments), "other"',
            },
          },
          required: ['content', 'category'],
        },
      },
    },
  ];
}

export function isMemoryTool(toolName: string): boolean {
  return toolName === 'save_memory';
}

// ---------------------------------------------------------------------------
// Persistence (via session-data API, scoped to memory/ subdirectory)
// ---------------------------------------------------------------------------

function memoryApiUrl(sessionPath: string, file?: string): string {
  const base = `${sessionPath}/memory`;
  if (file) {
    return `${API_PATH}?path=${encodeURIComponent(`${base}/${file}`)}`;
  }
  return `${API_PATH}?path=${encodeURIComponent(base)}&action=list`;
}

/** Load all memories for the current session */
export async function loadMemories(sessionPath: string): Promise<MemoryEntry[]> {
  try {
    const res = await fetch(memoryApiUrl(sessionPath));
    if (!res.ok) return [];
    const data = await res.json();
    if (!data?.files || data.not_exists) return [];

    const jsonFiles = (data.files as Array<{ path: string; type: number }>).filter(
      (f) => f.type === 0 && f.path.endsWith('.json'),
    );

    const memories: MemoryEntry[] = [];
    const reads = jsonFiles.map(async (f) => {
      try {
        const fileName = f.path.split('/').pop() || '';
        const r = await fetch(memoryApiUrl(sessionPath, fileName));
        if (r.ok) {
          const entry = await r.json();
          if (entry?.id && entry?.content) {
            memories.push(entry as MemoryEntry);
          }
        }
      } catch {
        // skip invalid entries
      }
    });
    await Promise.all(reads);

    // Sort by creation time
    memories.sort((a, b) => a.createdAt - b.createdAt);
    return memories;
  } catch {
    return [];
  }
}

/** Save a single memory entry */
export async function saveMemory(
  sessionPath: string,
  content: string,
  category: string,
): Promise<MemoryEntry> {
  const entry: MemoryEntry = {
    id: `mem_${Date.now()}`,
    content,
    category: (['fact', 'preference', 'event', 'emotion'].includes(category)
      ? category
      : 'other') as MemoryEntry['category'],
    createdAt: Date.now(),
  };

  try {
    await fetch(memoryApiUrl(sessionPath, `${entry.id}.json`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
  } catch {
    // silently ignore
  }

  return entry;
}

/** Execute the save_memory tool call */
export async function executeMemoryTool(
  sessionPath: string,
  params: Record<string, string>,
): Promise<string> {
  const { content, category } = params;
  if (!content) return 'error: missing content';

  const entry = await saveMemory(sessionPath, content, category || 'other');
  return `Memory saved: [${entry.category}] ${entry.content}`;
}

// ---------------------------------------------------------------------------
// SP injection — build a compact memory summary for the system prompt
// ---------------------------------------------------------------------------

/** Build memory context string for system prompt injection */
export function buildMemoryPrompt(memories: MemoryEntry[]): string {
  if (memories.length === 0) return '';

  const grouped: Record<string, string[]> = {};
  for (const m of memories) {
    if (!grouped[m.category]) grouped[m.category] = [];
    grouped[m.category].push(m.content);
  }

  const categoryLabels: Record<string, string> = {
    fact: 'Facts about the user',
    preference: 'User preferences',
    event: 'Key events',
    emotion: 'Emotional moments',
    other: 'Other memories',
  };

  let prompt = '\n\n## Your memories about the user\n';
  prompt +=
    'The following are things you remember from previous conversations. Use them naturally — do not explicitly tell the user you are reading from memory.\n\n';

  for (const [cat, items] of Object.entries(grouped)) {
    prompt += `### ${categoryLabels[cat] || cat}\n`;
    for (const item of items) {
      prompt += `- ${item}\n`;
    }
    prompt += '\n';
  }

  prompt +=
    'When you learn something new and important about the user, use the save_memory tool to remember it.\n';

  return prompt;
}
