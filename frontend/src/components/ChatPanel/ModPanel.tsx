import React, { useState } from 'react';
import { X, Plus, Trash2, RotateCcw, Check } from 'lucide-react';
import {
  type ModConfig,
  type ModState,
  type ModCollection,
  type ModEntry,
  type Stage,
  ModManager,
  generateModId,
  getModList,
} from '@/lib/modManager';
import styles from './panel.module.scss';

interface ModPanelProps {
  collection: ModCollection;
  onSave: (collection: ModCollection) => void;
  onClose: () => void;
  initialEditId?: string;
}

const ModPanel: React.FC<ModPanelProps> = ({ collection, onSave, onClose, initialEditId }) => {
  const [col, setCol] = useState<ModCollection>(() => ({ ...collection }));
  const [editingId, setEditingId] = useState<string | null>(initialEditId ?? null);

  const mods = getModList(col);
  const activeId = col.activeId;
  const editingEntry = editingId ? col.items[editingId] : null;

  const handleSelect = (id: string) => {
    setCol({ ...col, activeId: id });
  };

  const handleDelete = (id: string) => {
    if (mods.length <= 1) return;
    const items = { ...col.items };
    delete items[id];
    const newActiveId = col.activeId === id ? Object.keys(items)[0] : col.activeId;
    setCol({ activeId: newActiveId, items });
    if (editingId === id) setEditingId(null);
  };

  const handleAdd = () => {
    const id = generateModId();
    const newMod: ModConfig = {
      id,
      mod_name: 'New Mod',
      mod_name_en: 'New Mod',
      mod_description: '',
      stage_count: 1,
      stages: {
        0: {
          stage_index: 0,
          stage_name: 'Stage 1',
          stage_description: '',
          stage_targets: { 1: 'First target' },
        },
      },
    };
    const newState: ModState = {
      current_stage_index: 0,
      total_stage_count: 1,
      is_finished: false,
      completed_targets: [],
    };
    setCol({ ...col, items: { ...col.items, [id]: { config: newMod, state: newState } } });
    setEditingId(id);
  };

  const handleSave = () => {
    onSave(col);
  };

  if (editingEntry) {
    return (
      <ModEditor
        entry={editingEntry}
        onSave={(updatedEntry) => {
          setCol({ ...col, items: { ...col.items, [updatedEntry.config.id]: updatedEntry } });
          setEditingId(null);
        }}
        onClose={() => setEditingId(null)}
      />
    );
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={`${styles.panel} ${styles.panelWide}`} onClick={(e) => e.stopPropagation()}>
        <div className={styles.panelHeader}>
          <span className={styles.panelTitle}>Story Mods</span>
          <button className={styles.closeBtn} onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className={styles.panelBody}>
          <div className={styles.listView}>
            {mods.map((entry) => {
              const cfg = entry.config;
              const st = entry.state;
              const mm = new ModManager(cfg, st);
              const progress = st.is_finished
                ? 'Completed'
                : `Stage ${st.current_stage_index + 1}/${cfg.stage_count}`;

              return (
                <div
                  key={cfg.id}
                  className={`${styles.listItem} ${cfg.id === activeId ? styles.listItemActive : ''}`}
                  onClick={() => handleSelect(cfg.id)}
                >
                  <div className={styles.listItemInfo} style={{ flex: 1 }}>
                    <div className={styles.listItemName}>{cfg.mod_name_en || cfg.mod_name}</div>
                    <div className={styles.listItemDesc}>
                      {progress} &middot; {cfg.mod_description?.slice(0, 60) || 'No description'}
                    </div>
                    {/* Mini progress bar */}
                    <div className={styles.miniProgress}>
                      {Array.from({ length: cfg.stage_count }).map((_, i) => (
                        <div
                          key={i}
                          className={`${styles.miniDot} ${
                            i < mm.currentStageIndex || st.is_finished
                              ? styles.miniDotDone
                              : i === mm.currentStageIndex && !st.is_finished
                                ? styles.miniDotCurrent
                                : ''
                          }`}
                        />
                      ))}
                    </div>
                  </div>
                  <div className={styles.listItemActions}>
                    {cfg.id === activeId && (
                      <span className={styles.activeBadge}>
                        <Check size={12} />
                      </span>
                    )}
                    <button
                      className={styles.listItemBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingId(cfg.id);
                      }}
                      title="Edit"
                    >
                      Edit
                    </button>
                    {mods.length > 1 && (
                      <button
                        className={styles.listItemBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(cfg.id);
                        }}
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className={styles.panelFooter}>
          <button className={styles.addBtn} onClick={handleAdd}>
            <Plus size={14} /> New Mod
          </button>
          <div style={{ flex: 1 }} />
          <button className={styles.cancelBtn} onClick={onClose}>
            Cancel
          </button>
          <button className={styles.saveBtn} onClick={handleSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Mod Editor — edit a single mod (Progress + Edit tabs)
// ---------------------------------------------------------------------------

interface EditableStage {
  stage_name: string;
  stage_description: string;
  targets: { id: number; description: string }[];
}

function configToEditable(config: ModConfig): EditableStage[] {
  return Object.values(config.stages)
    .sort((a, b) => a.stage_index - b.stage_index)
    .map((s) => ({
      stage_name: s.stage_name,
      stage_description: s.stage_description,
      targets: Object.entries(s.stage_targets).map(([id, desc]) => ({
        id: Number(id),
        description: desc,
      })),
    }));
}

function editableToConfig(
  stages: EditableStage[],
  id: string,
  modName: string,
  modNameEn: string,
  modDescription: string,
): ModConfig {
  const stagesMap: Record<number, Stage> = {};
  stages.forEach((s, i) => {
    const targetsMap: Record<number, string> = {};
    s.targets.forEach((t) => {
      targetsMap[t.id] = t.description;
    });
    stagesMap[i] = {
      stage_index: i,
      stage_name: s.stage_name,
      stage_description: s.stage_description,
      stage_targets: targetsMap,
    };
  });
  return {
    id,
    mod_name: modName,
    mod_name_en: modNameEn,
    mod_description: modDescription,
    stage_count: stages.length,
    stages: stagesMap,
  };
}

let nextTargetId = 100;

const ModEditor: React.FC<{
  entry: ModEntry;
  onSave: (entry: ModEntry) => void;
  onClose: () => void;
}> = ({ entry, onSave, onClose }) => {
  const config = entry.config;
  const state = entry.state;

  const [modName, setModName] = useState(config.mod_name);
  const [modNameEn, setModNameEn] = useState(config.mod_name_en);
  const [modDescription, setModDescription] = useState(config.mod_description);
  const [stages, setStages] = useState<EditableStage[]>(configToEditable(config));
  const [activeTab, setActiveTab] = useState<'progress' | 'edit'>('progress');
  const [currentState] = useState<ModState>({ ...state });

  const handleAddStage = () => {
    setStages([
      ...stages,
      {
        stage_name: `Stage ${stages.length + 1}`,
        stage_description: '',
        targets: [{ id: nextTargetId++, description: '' }],
      },
    ]);
  };

  const handleRemoveStage = (index: number) => {
    setStages(stages.filter((_, i) => i !== index));
  };

  const updateStage = (
    index: number,
    field: 'stage_name' | 'stage_description',
    value: string,
  ) => {
    setStages((current) =>
      current.map((stage, stageIndex) =>
        stageIndex === index ? { ...stage, [field]: value } : stage,
      ),
    );
  };

  const handleAddTarget = (stageIndex: number) => {
    const updated = [...stages];
    updated[stageIndex].targets.push({ id: nextTargetId++, description: '' });
    setStages(updated);
  };

  const handleRemoveTarget = (stageIndex: number, targetIndex: number) => {
    const updated = [...stages];
    updated[stageIndex].targets = updated[stageIndex].targets.filter((_, i) => i !== targetIndex);
    setStages(updated);
  };

  const updateTarget = (stageIndex: number, targetIndex: number, value: string) => {
    const updated = [...stages];
    updated[stageIndex].targets[targetIndex].description = value;
    setStages(updated);
  };

  const handleSave = () => {
    const newConfig = editableToConfig(stages, config.id, modName, modNameEn, modDescription);
    onSave({ config: newConfig, state: currentState });
  };

  const handleSaveAndReset = () => {
    const newConfig = editableToConfig(stages, config.id, modName, modNameEn, modDescription);
    onSave({
      config: newConfig,
      state: {
        current_stage_index: 0,
        total_stage_count: newConfig.stage_count,
        is_finished: false,
        completed_targets: [],
      },
    });
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={`${styles.panel} ${styles.panelWide}`} onClick={(e) => e.stopPropagation()}>
        <div className={styles.panelHeader}>
          <span className={styles.panelTitle}>Edit Mod</span>
          <div className={styles.tabs}>
            <button
              className={`${styles.tab} ${activeTab === 'progress' ? styles.tabActive : ''}`}
              onClick={() => setActiveTab('progress')}
            >
              Progress
            </button>
            <button
              className={`${styles.tab} ${activeTab === 'edit' ? styles.tabActive : ''}`}
              onClick={() => setActiveTab('edit')}
            >
              Edit
            </button>
          </div>
          <button className={styles.closeBtn} onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className={styles.panelBody}>
          {activeTab === 'progress' ? (
            <ProgressView config={config} state={currentState} />
          ) : (
            <EditView
              modName={modName}
              setModName={setModName}
              modNameEn={modNameEn}
              setModNameEn={setModNameEn}
              modDescription={modDescription}
              setModDescription={setModDescription}
              stages={stages}
              updateStage={updateStage}
              handleAddStage={handleAddStage}
              handleRemoveStage={handleRemoveStage}
              handleAddTarget={handleAddTarget}
              handleRemoveTarget={handleRemoveTarget}
              updateTarget={updateTarget}
            />
          )}
        </div>

        <div className={styles.panelFooter}>
          <button className={styles.cancelBtn} onClick={onClose}>
            Back
          </button>
          {activeTab === 'edit' && (
            <button className={styles.resetBtn} onClick={handleSaveAndReset}>
              <RotateCcw size={14} />
              Save & Reset
            </button>
          )}
          <button className={styles.saveBtn} onClick={handleSave}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Progress View
// ---------------------------------------------------------------------------

const ProgressView: React.FC<{ config: ModConfig; state: ModState }> = ({ config, state }) => {
  const allStages = Object.values(config.stages).sort((a, b) => a.stage_index - b.stage_index);

  return (
    <div className={styles.progressView}>
      <div className={styles.modTitle}>{config.mod_name_en || config.mod_name}</div>
      <div className={styles.modDesc}>{config.mod_description}</div>

      <div className={styles.stageList}>
        {allStages.map((stage) => {
          const isCurrent = stage.stage_index === state.current_stage_index && !state.is_finished;
          const isCompleted = stage.stage_index < state.current_stage_index || state.is_finished;

          return (
            <div
              key={stage.stage_index}
              className={`${styles.stageCard} ${isCurrent ? styles.stageCardCurrent : ''} ${isCompleted ? styles.stageCardCompleted : ''}`}
            >
              <div className={styles.stageCardHeader}>
                <span className={styles.stageCardIndex}>
                  {isCompleted ? <Check size={14} /> : stage.stage_index + 1}
                </span>
                <span className={styles.stageCardName}>{stage.stage_name}</span>
                {isCurrent && <span className={styles.stageCardBadge}>Current</span>}
              </div>
              <div className={styles.stageCardDesc}>{stage.stage_description}</div>
              <div className={styles.targetList}>
                {Object.entries(stage.stage_targets).map(([id, desc]) => {
                  const completed = state.completed_targets.includes(Number(id));
                  return (
                    <div
                      key={id}
                      className={`${styles.targetItem} ${completed ? styles.targetCompleted : ''}`}
                    >
                      <span className={styles.targetCheck}>
                        {completed ? <Check size={12} /> : '\u25CB'}
                      </span>
                      <span>{desc}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {state.is_finished && <div className={styles.finishedBanner}>All stages completed!</div>}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Edit View
// ---------------------------------------------------------------------------

const EditView: React.FC<{
  modName: string;
  setModName: (v: string) => void;
  modNameEn: string;
  setModNameEn: (v: string) => void;
  modDescription: string;
  setModDescription: (v: string) => void;
  stages: EditableStage[];
  updateStage: (
    i: number,
    field: 'stage_name' | 'stage_description',
    value: string,
  ) => void;
  handleAddStage: () => void;
  handleRemoveStage: (i: number) => void;
  handleAddTarget: (si: number) => void;
  handleRemoveTarget: (si: number, ti: number) => void;
  updateTarget: (si: number, ti: number, value: string) => void;
}> = ({
  modName,
  setModName,
  modNameEn,
  setModNameEn,
  modDescription,
  setModDescription,
  stages,
  updateStage,
  handleAddStage,
  handleRemoveStage,
  handleAddTarget,
  handleRemoveTarget,
  updateTarget,
}) => {
  return (
    <div className={styles.editView}>
      <div className={styles.field}>
        <label className={styles.label}>Mod Name</label>
        <input
          className={styles.input}
          value={modName}
          onChange={(e) => setModName(e.target.value)}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label}>English Name</label>
        <input
          className={styles.input}
          value={modNameEn}
          onChange={(e) => setModNameEn(e.target.value)}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label}>Description</label>
        <textarea
          className={styles.textarea}
          value={modDescription}
          onChange={(e) => setModDescription(e.target.value)}
          rows={3}
        />
      </div>

      <div className={styles.sectionHeader}>
        <span>Stages ({stages.length})</span>
        <button className={styles.addBtn} onClick={handleAddStage}>
          <Plus size={14} /> Add Stage
        </button>
      </div>

      {stages.map((stage, si) => (
        <div key={si} className={styles.stageEditCard}>
          <div className={styles.stageEditHeader}>
            <span className={styles.stageEditIndex}>Stage {si + 1}</span>
            <button className={styles.removeBtn} onClick={() => handleRemoveStage(si)}>
              <Trash2 size={14} />
            </button>
          </div>
          <input
            className={styles.input}
            value={stage.stage_name}
            onChange={(e) => updateStage(si, 'stage_name', e.target.value)}
            placeholder="Stage name"
          />
          <textarea
            className={styles.textarea}
            value={stage.stage_description}
            onChange={(e) => updateStage(si, 'stage_description', e.target.value)}
            rows={2}
            placeholder="Stage description"
          />
          <div className={styles.targetsSection}>
            <span className={styles.targetsLabel}>Targets</span>
            {stage.targets.map((t, ti) => (
              <div key={t.id} className={styles.targetEditRow}>
                <input
                  className={styles.input}
                  value={t.description}
                  onChange={(e) => updateTarget(si, ti, e.target.value)}
                  placeholder={`Target ${ti + 1}`}
                />
                <button className={styles.removeBtn} onClick={() => handleRemoveTarget(si, ti)}>
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <button className={styles.addTargetBtn} onClick={() => handleAddTarget(si)}>
              <Plus size={12} /> Add Target
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};

export default ModPanel;
