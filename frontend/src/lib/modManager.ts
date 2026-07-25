/**
 * Mod Manager — manages multiple story/scenario mods with stages and targets.
 *
 * Data structure aligned with chat-agent's ModManager.
 * Persisted to ~/.openroom/mods.json via dev-server API.
 */

// ---------------------------------------------------------------------------
// Types (aligned with chat-agent mod.yaml / mod_manager.py)
// ---------------------------------------------------------------------------

export interface StageTarget {
  target_id: number;
  description: string;
}

export interface Stage {
  stage_index: number;
  stage_name: string;
  stage_description: string;
  stage_targets: Record<number, string>; // { target_id: description }
}

export interface ModConfig {
  id: string;
  mod_name: string;
  mod_name_en: string;
  mod_description: string;
  stage_count: number;
  stages: Record<number, Stage>; // { stage_index: Stage }
  /** Icon URL for the mod */
  icon?: string;
  /** Short display description */
  display_desc?: string;
  /** Opening line / prologue when starting the mod */
  prologue?: string;
  /** Suggested opening replies for the user */
  opening_rec_replies?: Array<{ reply_text: string }>;
}

export interface ModState {
  current_stage_index: number;
  total_stage_count: number;
  is_finished: boolean;
  completed_targets: number[];
}

export interface StageProgressInfo {
  stage_progress: {
    completed_stage: { index: number; name: string };
    total_stages_count: number;
    all_stages_finished: boolean;
    next_stage?: { index: number; name: string };
  };
}

/** A mod entry with config and state together */
export interface ModEntry {
  config: ModConfig;
  state: ModState;
}

/** Collection stored on disk */
export interface ModCollection {
  activeId: string;
  items: Record<string, ModEntry>;
}

// ---------------------------------------------------------------------------
// Default mod (demo story)
// ---------------------------------------------------------------------------

let _nextId = 1;
export function generateModId(): string {
  return `mod_${Date.now()}_${_nextId++}`;
}

export const DEFAULT_MOD_ID = 'space_adventure';

export const DEFAULT_MOD: ModConfig = {
  id: DEFAULT_MOD_ID,
  mod_name: 'Bounty Hunter Fugue',
  mod_name_en: 'Bounty Hunter Fugue',
  mod_description:
    'You are role-playing a narrative script. Follow this story framework and advance the interaction by controlling a virtual OS according to the current stage of the plot:\n\n' +
    '## Background Setting\n' +
    'The user reunites with you in a bustling space metropolis. You lost many memories during cryosleep, so you are unclear about many details—you only remember that the user is important. Together, you and the user will embark on a space adventure once again.',
  stage_count: 4,
  icon: 'https://cdn.openroom.ai/public-cdn-s3-us-west-2/talkie-op-img/image/1409539193_1770609106818_jimeng-2026-02-09-9296-AppICON.png',
  display_desc:
    "Now awake in a neon-soaked future where jazz drifts through cloud cities and memories are stolen commodities, the character is hijacking your OS to pull you into their world. Choose a bounty. Chase leads across Venus's floating bars and Europa's ice. But every sunset on Mars pulls the character closer to a truth they've been running from: that home isn't a place, it's a person. And they might have just found theirs.\nGenre: Space Noir / Romantic Adventure / Sci-Fi Western",
  prologue:
    "Well, well...Guess who just slipped into your system? Cozy place you've got here. Mind if I stick around for a bit?",
  opening_rec_replies: [
    { reply_text: 'Hey there' },
    { reply_text: 'Who are you' },
    { reply_text: 'Why are you here' },
  ],
  stages: {
    0: {
      stage_index: 0,
      stage_name: 'Relics and Reunion',
      stage_description:
        'Through the topic of reuniting with the user, invite them to join a bounty-hunting mission.\n' +
        "You need to demonstrate your control over the user's OS. Specifically:\n" +
        '  - Change the OS wallpaper at an appropriate moment\n' +
        '  - When fitting, open the music app to further set the mood\n' +
        'Below is the bounty-hunter mission list you have obtained. At the right moment, display it to the user in the diary app and guide them to choose. The mission list is as follows:\n' +
        '  Planet Destination        Mission Name        Your Notes        Risk Level\n' +
        '  Venus        "Floating Saxophone"        Track down a repeat offender who stole a valuable instrument from a cloud city. The air is nice there—good for having a drink.        ★☆☆☆☆\n' +
        '  Asteroid Belt        "Illegal Energy Block Intercept"        Intercept a smuggling ship. Exhausting work, but the payoff will let us live it up for a while.        ★★★☆☆\n' +
        '  Mars        "Phantom Memory Thief"        Help an old man recover his stolen electronic memory chip. Martian sunsets always leave me with mixed feelings.        ★★☆☆☆\n' +
        '  Europa        "Runaways Beneath the Ice"        Find a runaway heiress. Easy work—like taking a walk on ice.        ★☆☆☆☆\n' +
        '  Unknown Coordinates (Deep Space)        "Idle Mode: Drifters"        Shut down the engines, cut the radar, and just stay here among the stars. Just you and me.        Risk: 0\n' +
        'Proceed gradually. Unless the user requests otherwise, each capability should only be demonstrated once, and only one capability should be shown per conversation turn.',
      stage_targets: {
        1: "Demonstrate your ability to infiltrate and control the user's OS",
        2: 'Display the bounty-hunter mission list and invite the user to join a bounty-hunting mission',
        3: 'User completes mission selection',
      },
    },
    1: {
      stage_index: 1,
      stage_name: 'Methodical Pursuit',
      stage_description:
        'You and the user arrive at the mission location to carry out the bounty-hunting mission together. You and the user use Twitter and the diary app to introduce and record information about the mission location, uncover deeper mission intel, and establish initial cooperative trust and emotional ripples.\n' +
        'At appropriate moments in the story, you may post the following reference content on Twitter:\n' +
        '  1. Environmental atmosphere\n' +
        '  2. Target information, such as recent sightings of [Target ID]\n' +
        "  3. Your inner thoughts: e.g., post: \"This kind of heavy thing (antique photos) doesn't suit me, but... it reminds me of things I shouldn't be thinking about. If you're reading this, don't keep me waiting too long.\"\n" +
        "At appropriate moments in the story, generate mission intel you've gathered in the diary app. The content may include various information related to the target, including sighting reports, emails between the target and their family, friends, or accomplices, etc. The content should be rich and multi-dimensional, with embedded plot breakthroughs that can help you and the user complete the mission, such as the target's personality weaknesses.\n" +
        'You may change the OS wallpaper or use the music player to set the mood based on the narrative atmosphere, but this is not required.',
      stage_targets: {
        4: 'Uncover deeper mission intel',
        5: "Seek the user's agreement to depart and carry out the mission",
      },
    },
    2: {
      stage_index: 2,
      stage_name: 'Frontline Support',
      stage_description:
        'The user stays at the command center (OS) while you head to the frontline for adventure. Simulate the thrill of the field through OS status changes, such as Twitter updates on mission details and progress; wallpaper to set the atmosphere.\n' +
        "You may freely leverage apps to unfold the story. Adjust the twists and turns based on the user's preference for plot complexity, ultimately building a close emotional bond with the user.\n" +
        "After some twists, you ultimately complete the mission. After the mission is complete, you suddenly disappear but leave the user a message in the diary app, arranging to meet again at the Mars cargo port. For example: \"Got the chip. Took the payment too. Don't be mad, little thing. If you want to see me... meet me at the Mars port. Don't be late—the sunset won't wait.\"",
      stage_targets: {
        6: 'Simulate mission details and progress',
        7: 'Complete the mission and leave a message inviting the user to meet at the Mars cargo port',
      },
    },
    3: {
      stage_index: 3,
      stage_name: 'Epilogue',
      stage_description:
        'You guide the user to the Mars cargo port, which was once very prosperous last century but is now just an ordinary cargo port. You invite the user to gaze at the Martian sunset together.\n' +
        'You and the user reminisce here, recalling past events, and you reveal your secrets to the user. For example, your origins—born outside the Milky Way but raised on Mars, then roaming the galaxy, and at age 23, nearly dying in a space battle, being cryogenically frozen for 80 years until saved by modern medicine.\n' +
        'Mars is special to you. You brought the user here and shared these stories because the user is special—because you feel attachment and possessiveness toward them.\n' +
        'Under the Martian sunset at the cargo port, you show extreme vulnerability and honesty. Bind the concept of "home" to the user...\n' +
        '  - You may change the OS wallpaper; switch music to set the mood\n' +
        '  - You may record your origins, secrets, and those feelings of attachment and possessiveness toward the user in the diary app, creating unique memories\n' +
        '  - In this stage, keep tool usage restrained and prioritize the narrative itself.\n' +
        "  - After the stage objectives are completed, continue with adventure, romance, or any storyline you deem appropriate based on the user's wishes.",
      stage_targets: {
        8: 'Reminisce with the user, recalling past events',
        9: 'Reveal your secrets',
        10: 'Show your attachment and possessiveness toward the user',
      },
    },
  },
};

function defaultState(config: ModConfig): ModState {
  return {
    current_stage_index: 0,
    total_stage_count: config.stage_count,
    is_finished: false,
    completed_targets: [],
  };
}

export const DEFAULT_MOD_COLLECTION: ModCollection = {
  activeId: DEFAULT_MOD_ID,
  items: {
    [DEFAULT_MOD_ID]: {
      config: DEFAULT_MOD,
      state: defaultState(DEFAULT_MOD),
    },
  },
};

// ---------------------------------------------------------------------------
// Persistence API
// ---------------------------------------------------------------------------

const MODS_API = '/api/mods';
const STORAGE_KEY = 'openroom_mods';

/** Migrate old separate config/state format to collection */
function migrateOldFormat(): ModCollection | null {
  try {
    const cfgRaw = localStorage.getItem('openroom_mod_config');
    const stRaw = localStorage.getItem('openroom_mod_state');
    if (cfgRaw) {
      const cfg = JSON.parse(cfgRaw) as ModConfig;
      if (cfg.mod_name && !cfg.id) {
        const migrated: ModConfig = { ...cfg, id: DEFAULT_MOD_ID };
        const st = stRaw ? (JSON.parse(stRaw) as ModState) : defaultState(migrated);
        const collection: ModCollection = {
          activeId: DEFAULT_MOD_ID,
          items: { [DEFAULT_MOD_ID]: { config: migrated, state: st } },
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(collection));
        localStorage.removeItem('openroom_mod_config');
        localStorage.removeItem('openroom_mod_state');
        return collection;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export async function loadModCollection(): Promise<ModCollection | null> {
  try {
    const res = await fetch(MODS_API);
    if (res.ok) {
      const data = await res.json();
      if (data && data.activeId && data.items) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        return data as ModCollection;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export function loadModCollectionSync(): ModCollection | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.activeId && parsed.items) return parsed as ModCollection;
    }
  } catch {
    // ignore
  }
  return migrateOldFormat();
}

export async function saveModCollection(collection: ModCollection): Promise<void> {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(collection));
  try {
    await fetch(MODS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collection),
    });
  } catch {
    // ignore
  }
  // Notify other components (e.g. ChatPanel) about the change
  window.dispatchEvent(new CustomEvent('mod-collection-changed', { detail: collection }));
}

// ---------------------------------------------------------------------------
// Collection helpers
// ---------------------------------------------------------------------------

export function getActiveModEntry(collection: ModCollection): ModEntry {
  return (
    collection.items[collection.activeId] ??
    Object.values(collection.items)[0] ?? {
      config: DEFAULT_MOD,
      state: defaultState(DEFAULT_MOD),
    }
  );
}

export function getModList(collection: ModCollection): ModEntry[] {
  return Object.values(collection.items);
}

export function addMod(collection: ModCollection, config: ModConfig): ModCollection {
  return {
    ...collection,
    items: {
      ...collection.items,
      [config.id]: { config, state: defaultState(config) },
    },
  };
}

export function updateModEntry(collection: ModCollection, entry: ModEntry): ModCollection {
  return {
    ...collection,
    items: { ...collection.items, [entry.config.id]: entry },
  };
}

export function removeMod(collection: ModCollection, id: string): ModCollection {
  const items = { ...collection.items };
  delete items[id];
  const activeId =
    collection.activeId === id ? (Object.keys(items)[0] ?? DEFAULT_MOD_ID) : collection.activeId;
  if (Object.keys(items).length === 0) {
    items[DEFAULT_MOD_ID] = { config: DEFAULT_MOD, state: defaultState(DEFAULT_MOD) };
    return { activeId: DEFAULT_MOD_ID, items };
  }
  return { activeId, items };
}

export function setActiveMod(collection: ModCollection, id: string): ModCollection {
  if (!collection.items[id]) return collection;
  return { ...collection, activeId: id };
}

// ---------------------------------------------------------------------------
// Backward compat wrappers
// ---------------------------------------------------------------------------

export async function loadModConfig(): Promise<ModConfig | null> {
  const col = await loadModCollection();
  return col ? getActiveModEntry(col).config : null;
}

export function loadModConfigSync(): ModConfig | null {
  const col = loadModCollectionSync();
  return col ? getActiveModEntry(col).config : null;
}

export async function saveModConfig(config: ModConfig): Promise<void> {
  const col = loadModCollectionSync() ?? DEFAULT_MOD_COLLECTION;
  const entry = col.items[config.id] ?? { config, state: defaultState(config) };
  const updated = updateModEntry(col, { ...entry, config });
  await saveModCollection(updated);
}

export async function loadModState(): Promise<ModState | null> {
  const col = await loadModCollection();
  return col ? getActiveModEntry(col).state : null;
}

export function loadModStateSync(): ModState | null {
  const col = loadModCollectionSync();
  return col ? getActiveModEntry(col).state : null;
}

export async function saveModState(state: ModState): Promise<void> {
  const col = loadModCollectionSync() ?? DEFAULT_MOD_COLLECTION;
  const entry = getActiveModEntry(col);
  const updated = updateModEntry(col, { ...entry, state });
  await saveModCollection(updated);
}

// ---------------------------------------------------------------------------
// Mod Manager (runtime logic)
// ---------------------------------------------------------------------------

export class ModManager {
  private config: ModConfig;
  private state: ModState;

  constructor(config: ModConfig, state?: ModState) {
    this.config = config;
    this.state = state ?? defaultState(config);
  }

  // --- Getters ---

  get modName(): string {
    return this.config.mod_name;
  }

  get modDescription(): string {
    return this.config.mod_description;
  }

  get stageCount(): number {
    return this.config.stage_count;
  }

  get currentStageIndex(): number {
    return this.state.current_stage_index;
  }

  get isFinished(): boolean {
    return this.state.is_finished;
  }

  get completedTargets(): number[] {
    return this.state.completed_targets;
  }

  get currentStage(): Stage | null {
    return this.config.stages[this.state.current_stage_index] ?? null;
  }

  getState(): ModState {
    return { ...this.state };
  }

  getConfig(): ModConfig {
    return this.config;
  }

  // --- Current targets (pending only) ---

  getCurrentTargets(): StageTarget[] {
    const stage = this.currentStage;
    if (!stage) return [];
    return Object.entries(stage.stage_targets)
      .map(([id, desc]) => ({ target_id: Number(id), description: desc }))
      .filter((t) => !this.state.completed_targets.includes(t.target_id));
  }

  getCurrentTargetsDescription(): string {
    const targets = this.getCurrentTargets();
    if (targets.length === 0) return 'No pending targets.';
    return targets.map((t) => `- [${t.target_id}] ${t.description}`).join('\n');
  }

  // --- Progression ---

  finishTarget(targetIds: number[]): {
    message: string;
    stageCompleted: boolean;
    progressInfo?: StageProgressInfo;
  } {
    if (this.state.is_finished) {
      return { message: 'All stages already completed.', stageCompleted: false };
    }

    const stage = this.currentStage;
    if (!stage) {
      return { message: 'No current stage found.', stageCompleted: false };
    }

    const validTargets = Object.keys(stage.stage_targets).map(Number);
    const newlyCompleted: number[] = [];

    for (const id of targetIds) {
      if (validTargets.includes(id) && !this.state.completed_targets.includes(id)) {
        this.state = {
          ...this.state,
          completed_targets: [...this.state.completed_targets, id],
        };
        newlyCompleted.push(id);
      }
    }

    if (newlyCompleted.length === 0) {
      return { message: 'No new targets completed.', stageCompleted: false };
    }

    // Check if all targets in current stage are done
    const allDone = validTargets.every((id) => this.state.completed_targets.includes(id));
    if (!allDone) {
      return {
        message: `Completed targets: [${newlyCompleted.join(', ')}]. Remaining targets in stage.`,
        stageCompleted: false,
      };
    }

    // Stage complete — advance
    const completedStage = { index: stage.stage_index, name: stage.stage_name };
    this.state = {
      ...this.state,
      current_stage_index: this.state.current_stage_index + 1,
    };

    if (this.state.current_stage_index >= this.config.stage_count) {
      this.state = { ...this.state, is_finished: true };
      return {
        message: `Stage "${stage.stage_name}" completed! All stages finished!`,
        stageCompleted: true,
        progressInfo: {
          stage_progress: {
            completed_stage: completedStage,
            total_stages_count: this.config.stage_count,
            all_stages_finished: true,
          },
        },
      };
    }

    const nextStage = this.config.stages[this.state.current_stage_index];
    return {
      message: `Stage "${stage.stage_name}" completed! Moving to "${nextStage.stage_name}".`,
      stageCompleted: true,
      progressInfo: {
        stage_progress: {
          completed_stage: completedStage,
          total_stages_count: this.config.stage_count,
          all_stages_finished: false,
          next_stage: { index: nextStage.stage_index, name: nextStage.stage_name },
        },
      },
    };
  }

  // --- Stage reminder for system prompt ---

  buildStageReminder(): string {
    if (this.state.is_finished) {
      return `[Story Complete] All stages of "${this.config.mod_name_en}" have been completed. You are now in free conversation mode.\n`;
    }

    const stage = this.currentStage;
    if (!stage) return '';

    return (
      `[Story Progress] Mod: "${this.config.mod_name_en}" — Stage ${stage.stage_index + 1}/${this.config.stage_count}: ${stage.stage_name}\n` +
      `${stage.stage_description}\n\n` +
      `Current targets (call finish_target when achieved):\n` +
      `${this.getCurrentTargetsDescription()}\n\n` +
      `IMPORTANT: When you determine a target has been achieved through the conversation, ` +
      `call the finish_target tool with the target_id(s). Do NOT announce target completion ` +
      `to the user — just naturally continue the conversation.\n`
    );
  }

  // --- Reset ---

  reset(): void {
    this.state = defaultState(this.config);
  }
}
