import { describe, expect, it } from 'vitest';
import { applyMotionPoseSnapshot, collectMotionPoseSnapshot } from './motionPose';

function fakeCoreModel(parameters: Record<string, number>) {
  return {
    _model: { parameters: { ids: Object.keys(parameters) } },
    getParameterValueById: (id: string) => parameters[id],
    setParameterValueById: (id: string, value: number) => {
      parameters[id] = value;
    },
  };
}

function fakeModel(coreModel: unknown) {
  return { internalModel: { coreModel } };
}

function coreParameterValue(core: unknown, id: string): number {
  return (core as { getParameterValueById(id: string): number }).getParameterValueById(id);
}

describe('motion pose snapshot', () => {
  it('collects every finite parameter value from the core model', () => {
    const core = fakeCoreModel({ ParamAngleX: 0, ParamarmupL: 0, ParamEyeOpenL: 1 });
    const snapshot = collectMotionPoseSnapshot(fakeModel(core));
    expect(snapshot).not.toBeNull();
    expect(snapshot!.model).toBeDefined();
    expect(snapshot!.values).toEqual([
      { id: 'ParamAngleX', value: 0 },
      { id: 'ParamarmupL', value: 0 },
      { id: 'ParamEyeOpenL', value: 1 },
    ]);
  });

  it('drops non-finite values instead of freezing NaN into the pose', () => {
    const core = fakeCoreModel({ ParamAngleX: Number.NaN, ParamarmupL: 0.5 });
    const snapshot = collectMotionPoseSnapshot(fakeModel(core));
    expect(snapshot!.values).toEqual([{ id: 'ParamarmupL', value: 0.5 }]);
  });

  it('returns null when the core model cannot be read', () => {
    expect(collectMotionPoseSnapshot(null)).toBeNull();
    expect(collectMotionPoseSnapshot({})).toBeNull();
    expect(collectMotionPoseSnapshot({ internalModel: { coreModel: {} } })).toBeNull();
  });

  it('restores every snapshot value back onto the core model', () => {
    const parameters = { ParamarmupL: 0, Paramanime: 0, ParamEyeOpenL: 1 };
    const core = fakeCoreModel(parameters);
    const snapshot = collectMotionPoseSnapshot(fakeModel(core));
    // Simulate a wave motion's residual final state (arm up, toggle stuck at
    // 1) — the exact "arm never comes down" symptom.
    core.setParameterValueById('ParamarmupL', 1);
    core.setParameterValueById('Paramanime', 1);
    expect(coreParameterValue(core, 'ParamarmupL')).toBe(1);
    applyMotionPoseSnapshot(snapshot);
    expect(coreParameterValue(core, 'ParamarmupL')).toBe(0);
    expect(coreParameterValue(core, 'Paramanime')).toBe(0);
    expect(coreParameterValue(core, 'ParamEyeOpenL')).toBe(1);
  });

  it('tolerates missing model or core during restore', () => {
    expect(() => applyMotionPoseSnapshot(null)).not.toThrow();
    expect(() => applyMotionPoseSnapshot({ model: null, values: [] })).not.toThrow();
    expect(() => applyMotionPoseSnapshot({
      model: { internalModel: { coreModel: {} } },
      values: [{ id: 'ParamarmupL', value: 0 }],
    })).not.toThrow();
  });
});
