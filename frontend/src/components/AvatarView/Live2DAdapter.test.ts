import { afterEach, describe, expect, it, vi } from 'vitest';
import { calculateHeadCentredGaze, Live2DRenderer } from './Live2DAdapter';

type MotionListener = () => void;

function createModel(initialArm = 0) {
  const parameters: Record<string, number> = {
    ParamarmupL: initialArm,
    Paramanime: 0,
  };
  const listeners = new Set<MotionListener>();
  const registeredListeners: MotionListener[] = [];
  const motionManager = {
    on: vi.fn((event: string, listener: MotionListener) => {
      if (event === 'motionFinish') {
        listeners.add(listener);
        registeredListeners.push(listener);
      }
    }),
    off: vi.fn((event: string, listener: MotionListener) => {
      if (event === 'motionFinish') listeners.delete(listener);
    }),
    stopAllMotions: vi.fn(),
    expressionManager: { resetExpression: vi.fn() },
    finish: () => {
      for (const listener of listeners) listener();
    },
    finishStale: () => {
      for (const listener of registeredListeners) listener();
    },
  };
  const coreModel = {
    _model: { parameters: { ids: Object.keys(parameters) } },
    getParameterValueById: (id: string) => parameters[id],
    setParameterValueById: vi.fn((id: string, value: number) => {
      parameters[id] = value;
    }),
  };
  const model = {
    internalModel: { coreModel, motionManager },
    motion: vi.fn(),
  };
  return { model, motionManager, parameters, coreModel };
}

function mountModel(renderer: Live2DRenderer, model: ReturnType<typeof createModel>['model']) {
  const internals = renderer as unknown as {
    model: typeof model | null;
    app: { stage: object; renderer: { render: ReturnType<typeof vi.fn> } };
    attachContinuousRuntime(candidate: typeof model): void;
    destroyModel(): void;
  };
  internals.app = { stage: {}, renderer: { render: vi.fn() } };
  internals.model = model;
  internals.attachContinuousRuntime(model);
  return internals;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Live2D head-centred gaze', () => {
  it('is neutral at the face anchor and preserves the Cubism up-positive axis', () => {
    expect(calculateHeadCentredGaze({
      pointerX: 320,
      pointerY: 180,
      headX: 320,
      headY: 180,
      modelWidth: 400,
      modelHeight: 700,
    })).toEqual({ x: 0, y: 0 });
    const upRight = calculateHeadCentredGaze({
      pointerX: 390,
      pointerY: 110,
      headX: 320,
      headY: 180,
      modelWidth: 400,
      modelHeight: 700,
    });
    expect(upRight.x).toBeGreaterThan(0);
    expect(upRight.y).toBeGreaterThan(0);
  });

  it('clamps hostile and zero-sized geometry to finite focus values', () => {
    expect(calculateHeadCentredGaze({
      pointerX: Number.MAX_SAFE_INTEGER,
      pointerY: Number.MIN_SAFE_INTEGER,
      headX: 0,
      headY: 0,
      modelWidth: 0,
      modelHeight: 0,
    })).toEqual({ x: 1, y: 1 });
  });
});

describe('Live2D motion watchdog integration', () => {
  it('playMotion starts the motion and arms the ten-second watchdog', () => {
    vi.useFakeTimers();
    const renderer = new Live2DRenderer({ width: 400, height: 700 });
    const current = createModel();
    mountModel(renderer, current.model);

    renderer.playMotion('Wave');

    expect(current.model.motion).toHaveBeenCalledWith('Wave');
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(9_999);
    expect(current.motionManager.stopAllMotions).not.toHaveBeenCalled();
  });

  it('restores the attached idle pose when a motion finishes naturally', () => {
    vi.useFakeTimers();
    const renderer = new Live2DRenderer({ width: 400, height: 700 });
    const current = createModel();
    mountModel(renderer, current.model);
    renderer.playMotion('Wave');
    current.parameters.ParamarmupL = 1;
    current.parameters.Paramanime = 1;

    current.motionManager.finish();

    expect(current.motionManager.stopAllMotions).toHaveBeenCalledOnce();
    expect(current.parameters).toMatchObject({ ParamarmupL: 0, Paramanime: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops and restores a motion that has not finished after ten seconds', () => {
    vi.useFakeTimers();
    const renderer = new Live2DRenderer({ width: 400, height: 700 });
    const current = createModel();
    mountModel(renderer, current.model);
    renderer.playMotion('Wave');
    current.parameters.ParamarmupL = 1;
    current.parameters.Paramanime = 1;

    vi.advanceTimersByTime(10_000);

    expect(current.motionManager.stopAllMotions).toHaveBeenCalledOnce();
    expect(current.parameters).toMatchObject({ ParamarmupL: 0, Paramanime: 0 });
  });

  it('repeated clicks reset the deadline without snapshotting the raised pose', () => {
    vi.useFakeTimers();
    const renderer = new Live2DRenderer({ width: 400, height: 700 });
    const current = createModel();
    mountModel(renderer, current.model);
    renderer.playMotion('Wave');
    current.parameters.ParamarmupL = 1;
    vi.advanceTimersByTime(5_000);

    renderer.playMotion('Wave');
    vi.advanceTimersByTime(9_999);
    expect(current.motionManager.stopAllMotions).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(current.model.motion).toHaveBeenCalledTimes(2);
    expect(current.parameters.ParamarmupL).toBe(0);
  });

  it('stale finish and timeout work cannot mutate a replacement model', () => {
    vi.useFakeTimers();
    const timeoutCallbacks: Array<() => void> = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: TimerHandler) => {
      timeoutCallbacks.push(callback as () => void);
      return timeoutCallbacks.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const renderer = new Live2DRenderer({ width: 400, height: 700 });
    const old = createModel();
    const internals = mountModel(renderer, old.model);
    renderer.playMotion('Wave');
    const staleTimeout = timeoutCallbacks[0];
    old.parameters.ParamarmupL = 1;

    internals.destroyModel();
    const replacement = createModel(0.25);
    internals.model = replacement.model;
    internals.attachContinuousRuntime(replacement.model);
    old.motionManager.finishStale();
    staleTimeout();

    expect(old.motionManager.off).toHaveBeenCalledOnce();
    expect(replacement.parameters.ParamarmupL).toBe(0.25);
    expect(replacement.motionManager.stopAllMotions).not.toHaveBeenCalled();
    expect(replacement.coreModel.setParameterValueById).not.toHaveBeenCalled();
  });
});
