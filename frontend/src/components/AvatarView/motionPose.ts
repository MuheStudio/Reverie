// Parameter snapshot/restore primitives shared by the Live2D motion-finish
// handler and the motion watchdog. Kept free of renderer dependencies so the
// snapshot semantics can be unit-tested in isolation.

export interface MotionParameterValue {
  id: string;
  value: number;
}

export interface MotionPoseSnapshot {
  model: unknown;
  values: MotionParameterValue[];
}

function readParameterIds(coreModel: any): string[] {
  try {
    const raw = coreModel?._model?.parameters?.ids;
    return Array.isArray(raw) && raw.length ? (raw as string[]) : [];
  } catch {
    return [];
  }
}

export function collectMotionPoseSnapshot(model: any): MotionPoseSnapshot | null {
  const core = model?.internalModel?.coreModel;
  if (!core || typeof core.getParameterValueById !== 'function') return null;
  const values: MotionParameterValue[] = [];
  for (const id of readParameterIds(core)) {
    try {
      const value = core.getParameterValueById(id);
      if (typeof value === 'number' && Number.isFinite(value)) values.push({ id, value });
    } catch {
      // A single unreadable parameter must not abort the whole snapshot.
    }
  }
  return { model, values };
}

export function applyMotionPoseSnapshot(snapshot: MotionPoseSnapshot | null): void {
  if (!snapshot) return;
  const core = (snapshot.model as any)?.internalModel?.coreModel;
  if (!core || typeof core.setParameterValueById !== 'function') return;
  for (const { id, value } of snapshot.values) {
    try {
      core.setParameterValueById(id, value);
    } catch {
      // A single unwritable parameter must not abort the restore.
    }
  }
}
