/**
 * AIRI Live2D → React 纯 JS 渲染适配器。
 *
 * 从 AIRI 的 Vue 组件中提取 PixiJS + pixi-live2d-display 核心渲染逻辑，
 * 封装为框架无关的纯 TypeScript 类，再通过 React Hook 暴露。
 *
 * 原始渲染代码: Project AIRI (MIT) Canvas.vue / Model.vue
 * 适配修改: Muhe Studio 2026
 */
import { useRef, useEffect, useCallback, useState } from 'react';
import * as PIXI from 'pixi.js';
import { install as installPixiCspAdapter } from '@pixi/unsafe-eval';

const { Application, Ticker } = PIXI;
installPixiCspAdapter(PIXI);
(globalThis as typeof globalThis & { PIXI?: typeof PIXI }).PIXI = PIXI;

const LIVE2D_CORE_URL = 'reverie-live2d-core://runtime/core.js';
let coreLoadPromise: Promise<void> | null = null;
let live2DModulePromise: Promise<typeof import('pixi-live2d-display/cubism4')> | null = null;

function ensureLive2DCore(): Promise<void> {
  const runtime = window as Window & { Live2DCubismCore?: unknown };
  if (runtime.Live2DCubismCore) return Promise.resolve();
  if (coreLoadPromise) return coreLoadPromise;
  coreLoadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${LIVE2D_CORE_URL}"]`,
    );
    const script = existing ?? document.createElement('script');
    const timer = window.setTimeout(() => {
      coreLoadPromise = null;
      reject(new Error('Live2D Cubism Core load timed out'));
    }, 10_000);
    const finish = () => {
      window.clearTimeout(timer);
      if (runtime.Live2DCubismCore) {
        resolve();
      } else {
        coreLoadPromise = null;
        reject(new Error('Live2D Cubism Core did not initialize'));
      }
    };
    script.addEventListener('load', finish, { once: true });
    script.addEventListener('error', () => {
      window.clearTimeout(timer);
      coreLoadPromise = null;
      reject(new Error('Live2D Cubism Core is unavailable'));
    }, { once: true });
    if (!existing) {
      script.src = LIVE2D_CORE_URL;
      script.async = true;
      document.head.appendChild(script);
    }
  });
  return coreLoadPromise;
}

async function loadLive2DRuntime(): Promise<typeof import('pixi-live2d-display/cubism4')> {
  await ensureLive2DCore();
  live2DModulePromise ??= import('pixi-live2d-display/cubism4').catch((error) => {
    live2DModulePromise = null;
    throw error;
  });
  return live2DModulePromise;
}

// ── 类型定义 ──────────────────────────────────────────

export interface Live2DConfig {
  width: number;
  height: number;
  resolution?: number;   // default 2
  maxFps?: number;        // 0 = unlimited
  backgroundAlpha?: number;
}

export interface Live2DModelOptions {
  url: string;            // URL or path to model3.json or .zip
  modelId?: string;
  autoInteract?: boolean;
}

export type Live2DState = 'pending' | 'loading' | 'mounted' | 'suspended' | 'error';

export function calculateHeadCentredGaze(input: {
  pointerX: number;
  pointerY: number;
  headX: number;
  headY: number;
  modelWidth: number;
  modelHeight: number;
}): { x: number; y: number } {
  const clamp = (value: number) => Math.max(-1, Math.min(1, value));
  return {
    x: clamp((input.pointerX - input.headX) / Math.max(1, input.modelWidth * 0.7)),
    y: clamp((input.headY - input.pointerY) / Math.max(1, input.modelHeight * 0.55)),
  };
}

// ── 核心渲染器（框架无关）─────────────────────────────

class Live2DRenderer {
  private app: any = null;
  private model: any = null;
  private canvas: HTMLCanvasElement | null = null;
  private container: HTMLElement | null = null;
  private config: Live2DConfig;
  private destroyed = false;
  private suspended = false;
  private lifecycleToken = 0;
  private modelToken = 0;
  private desiredModel: Live2DModelOptions | null = null;
  private detachModelRuntime: (() => void) | null = null;
  private detachCanvasRuntime: (() => void) | null = null;
  private mouthOpen = 0;

  constructor(
    config: Live2DConfig,
    private readonly reportRuntimeState?: (state: Live2DState, error: string | null) => void,
  ) {
    this.config = {
      resolution: 2,
      maxFps: 0,
      backgroundAlpha: 0,
      ...config,
    };
  }

  async init(container: HTMLElement): Promise<HTMLCanvasElement> {
    const token = ++this.lifecycleToken;
    this.container = container;
    this.destroyed = false;
    this.suspended = false;

    try {
      if (this.destroyed || token !== this.lifecycleToken) {
        throw new Error('Live2D initialization was cancelled');
      }
      const { Live2DModel } = await loadLive2DRuntime();
      if (this.destroyed || token !== this.lifecycleToken) {
        throw new Error('Live2D initialization was cancelled');
      }
      Live2DModel.registerTicker(Ticker);

      const res = this.config.resolution!;
      const app = new Application({
        width: this.config.width * res,
        height: this.config.height * res,
        backgroundAlpha: this.config.backgroundAlpha,
        preserveDrawingBuffer: false,
        autoDensity: false,
        resolution: 1,
      });
      if (this.destroyed || token !== this.lifecycleToken) {
        app.destroy(true, { children: true, texture: true, baseTexture: true });
        throw new Error('Live2D initialization was cancelled');
      }
      this.app = app;
      this.setMaxFps(this.config.maxFps ?? 0);

      this.app.stage.scale.set(res);
      this.canvas = this.app.view as HTMLCanvasElement;
      this.canvas.style.width = '100%';
      this.canvas.style.height = '100%';
      this.canvas.style.objectFit = 'cover';
      this.canvas.style.display = 'block';
      const handleContextLost = (event: Event) => {
        event.preventDefault();
        this.suspended = true;
        this.reportRuntimeState?.('suspended', 'Live2D WebGL context was lost');
        try { this.app?.ticker?.stop?.(); } catch (error) {
          console.warn('[Live2D] Failed to stop the renderer after context loss', error);
        }
      };
      const handleContextRestored = () => {
        if (this.destroyed) return;
        this.suspended = false;
        this.reportRuntimeState?.('loading', null);
        try { this.app?.ticker?.start?.(); } catch (error) {
          console.warn('[Live2D] Failed to restart the renderer after context restore', error);
        }
        const desired = this.desiredModel;
        if (desired) {
          void this.loadModel(desired).then((loaded) => {
            if (!this.destroyed && loaded) this.reportRuntimeState?.('mounted', null);
            else if (!this.destroyed) {
              this.reportRuntimeState?.(
                'error',
                'Live2D model did not recover after WebGL context restoration',
              );
            }
          }).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            this.reportRuntimeState?.('error', message);
            console.error('[Live2D] Model reload after WebGL restore failed', error);
          });
        } else {
          this.reportRuntimeState?.('mounted', null);
        }
      };
      this.canvas.addEventListener('webglcontextlost', handleContextLost);
      this.canvas.addEventListener('webglcontextrestored', handleContextRestored);
      this.detachCanvasRuntime = () => {
        this.canvas?.removeEventListener('webglcontextlost', handleContextLost);
        this.canvas?.removeEventListener('webglcontextrestored', handleContextRestored);
      };

      if (container.isConnected && !this.destroyed) container.appendChild(this.canvas);
    } catch (error) {
      if (this.destroyed || token !== this.lifecycleToken) throw error;
      // A painted placeholder is not a mounted Live2D runtime. Reporting it
      // as success would bypass both capability checks and the release
      // licence gate, so initialization must fail closed.
      this.canvas = null;
      this.app = null;
      throw new Error(
        error instanceof Error
          ? `Live2D runtime unavailable: ${error.message}`
          : 'Live2D runtime unavailable',
      );
    }
    if (!this.canvas || this.destroyed || token !== this.lifecycleToken) {
      throw new Error('Live2D initialization was cancelled');
    }
    return this.canvas!;
  }

  async loadModel(options: Live2DModelOptions): Promise<boolean> {
    this.desiredModel = { ...options };
    const token = ++this.modelToken;
    if (!this.app || this.destroyed || this.suspended) return false;
    this.destroyModel();
    const { Live2DModel } = await loadLive2DRuntime();
    const model = await Live2DModel.from(options.url, {
      autoInteract: options.autoInteract ?? false,
    });
    try {
      if (this.destroyed || this.suspended || token !== this.modelToken || !this.app) {
        this.destroyDetachedModel(model);
        return false;
      }
      this.model = model;
      model.anchor.set(0.5, 0.5);
      const fit = Math.min(
        this.config.width / Math.max(1, model.width),
        this.config.height / Math.max(1, model.height),
      ) * 0.92;
      model.scale.set(fit);
      model.position.set(this.config.width / 2, this.config.height / 2);
      this.app.stage.addChild(model);
      this.attachContinuousRuntime(model);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (this.destroyed || this.suspended || token !== this.modelToken || this.model !== model) {
        return false;
      }
      this.app.renderer.render(this.app.stage);
      return true;
    } catch (error) {
      this.destroyDetachedModel(model);
      if (this.destroyed || this.suspended || token !== this.modelToken) return false;
      throw error;
    }
  }

  private destroyDetachedModel(model: any): void {
    try { model?.internalModel?.motionManager?.stopAllMotions?.(); } catch {}
    try { model?.destroy?.({ children: true, texture: true, baseTexture: true }); } catch {
      try { model?.destroy?.(); } catch {}
    }
  }

  private destroyModel(): void {
    const model = this.model;
    this.model = null;
    this.detachModelRuntime?.();
    this.detachModelRuntime = null;
    if (!model) return;
    try { this.app?.stage?.removeChild?.(model); } catch {}
    this.destroyDetachedModel(model);
    try { this.app?.renderer?.textureGC?.run?.(); } catch {}
  }

  private attachContinuousRuntime(model: any): void {
    const internal = model?.internalModel;
    const focusController = internal?.focusController;
    const coreModel = internal?.coreModel;
    if (!focusController || !this.canvas) return;
    try {
      if (model.automator) model.automator.autoFocus = false;
    } catch {}

    let lastPointerAt = 0;
    let targetX = 0;
    let targetY = 0;
    let currentX = 0;
    let currentY = 0;
    const followPointer = (event: PointerEvent) => {
      if (this.destroyed || this.suspended || this.model !== model || !this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const scaleX = rect.width / Math.max(1, this.config.width);
      const scaleY = rect.height / Math.max(1, this.config.height);
      const headX = rect.left + model.x * scaleX;
      const modelTop = model.y - model.height / 2;
      const headY = rect.top + (modelTop + model.height * 0.18) * scaleY;
      const gaze = calculateHeadCentredGaze({
        pointerX: event.clientX,
        pointerY: event.clientY,
        headX,
        headY,
        modelWidth: model.width * scaleX,
        modelHeight: model.height * scaleY,
      });
      targetX = gaze.x;
      targetY = gaze.y;
      focusController.focus(gaze.x, gaze.y);
      lastPointerAt = performance.now();
    };
    const centerGaze = () => {
      targetX = 0;
      targetY = 0;
      focusController.focus(0, 0, false);
    };
    window.addEventListener('pointermove', followPointer, { passive: true });
    window.addEventListener('blur', centerGaze);
    this.canvas.addEventListener('pointerleave', centerGaze);

    // The model ticker drives Cubism breath and eye blink continuously. A
    // subtle pose drift keeps packages without an Idle motion alive too.
    const idleTick = () => {
      if (!coreModel) return;
      const seconds = performance.now() / 1000;
      try {
        const idle = performance.now() - lastPointerAt >= 2_500;
        const idleX = idle ? Math.sin(seconds * 0.42) * 0.05 : 0;
        const idleY = idle ? Math.sin(seconds * 0.31 + 1.2) * 0.035 : 0;
        currentX += (targetX + idleX - currentX) * 0.18;
        currentY += (targetY + idleY - currentY) * 0.18;
        coreModel.addParameterValueById('ParamAngleX', currentX * 24, 0.72);
        coreModel.addParameterValueById('ParamAngleY', currentY * 18, 0.68);
        coreModel.addParameterValueById('ParamAngleZ', currentX * currentY * -8, 0.45);
        coreModel.addParameterValueById('ParamBodyAngleX', currentX * 8, 0.42);
        coreModel.setParameterValueById('ParamEyeBallX', currentX);
        coreModel.setParameterValueById('ParamEyeBallY', currentY);
        coreModel.setParameterValueById('ParamMouthOpenY', this.mouthOpen);
      } catch (error) {
        console.warn('[Live2D] Gaze parameter update failed', error);
      }
    };
    internal.on?.('afterMotionUpdate', idleTick);

    this.detachModelRuntime = () => {
      window.removeEventListener('pointermove', followPointer);
      window.removeEventListener('blur', centerGaze);
      this.canvas?.removeEventListener('pointerleave', centerGaze);
      try { internal.off?.('afterMotionUpdate', idleTick); } catch (error) {
        console.warn('[Live2D] Failed to detach gaze ticker', error);
      }
      try { focusController.focus(0, 0, true); } catch (error) {
        console.warn('[Live2D] Failed to reset gaze', error);
      }
    };
  }

  async setActive(active: boolean): Promise<void> {
    if (this.destroyed) return;
    if (!active) {
      this.suspended = true;
      this.modelToken += 1;
      this.destroyModel();
      try { this.app?.ticker?.stop?.(); } catch {}
      try { this.app?.renderer?.textureGC?.run?.(); } catch {}
      return;
    }
    if (!this.suspended) return;
    this.suspended = false;
    try { this.app?.ticker?.start?.(); } catch {}
    if (this.desiredModel) {
      try {
        const loaded = await this.loadModel(this.desiredModel);
        if (!loaded) throw new Error('Live2D model did not resume to a rendered frame');
      } catch (error) {
        this.suspended = true;
        try { this.app?.ticker?.stop?.(); } catch {}
        throw error;
      }
    }
  }

  setExpression(expression: string): void {
    try {
      if (!expression) {
        this.model?.internalModel?.motionManager?.expressionManager?.resetExpression?.();
        return;
      }
      const result = this.model?.expression?.(expression);
      void Promise.resolve(result).then((applied) => {
        if (applied === false) console.warn(`[Live2D] Expression is unavailable: ${expression}`);
      }).catch((error) => {
        console.warn(`[Live2D] Expression failed: ${expression}`, error);
      });
    } catch (error) {
      console.warn(`[Live2D] Expression failed: ${expression}`, error);
    }
  }

  playMotion(group: string): void {
    if (!group) return;
    try {
      const result = this.model?.motion?.(group);
      void Promise.resolve(result).then((applied) => {
        if (applied === false) console.warn(`[Live2D] Motion is unavailable: ${group}`);
      }).catch((error) => {
        console.warn(`[Live2D] Motion failed: ${group}`, error);
      });
    } catch (error) {
      console.warn(`[Live2D] Motion failed: ${group}`, error);
    }
  }

  setMouthOpen(ratio: number): void {
    this.mouthOpen = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
    if (this.model?.internalModel?.coreModel) {
      try {
        this.model.internalModel.coreModel.setParameterValueById(
          'ParamMouthOpenY',
          this.mouthOpen,
        );
      } catch {}
    }
  }

  resize(width: number, height: number): void {
    this.config.width = width;
    this.config.height = height;
    if (this.app) {
      const res = this.config.resolution!;
      this.app.renderer.resize(width * res, height * res);
      this.app.stage.scale.set(res);
      this.model?.position?.set(width / 2, height / 2);
    }
  }

  setMaxFps(fps: number): void {
    if (this.app?.ticker) {
      this.app.ticker.maxFPS = fps > 0 ? fps : 0;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.suspended = true;
    this.lifecycleToken += 1;
    this.modelToken += 1;
    this.destroyModel();
    this.detachCanvasRuntime?.();
    this.detachCanvasRuntime = null;
    if (this.app) {
      try { this.app.ticker?.stop?.(); } catch {}
      try {
        this.app.destroy(true, { children: true, texture: true, baseTexture: true });
      } catch {
        try { this.app.destroy?.(true); } catch {}
      }
      this.app = null;
    }
    try { this.canvas?.remove(); } catch {}
    this.canvas = null;
    if (this.container) {
      this.container.innerHTML = '';
      this.container = null;
    }
  }
}

// ── React Hook ─────────────────────────────────────────

export function useLive2D(config: Live2DConfig) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Live2DRenderer | null>(null);
  const [state, setState] = useState<Live2DState>('pending');
  const [error, setError] = useState<string | null>(null);

  // 初始化渲染器
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let active = true;
    let renderer: Live2DRenderer;
    renderer = new Live2DRenderer(config, (nextState, nextError) => {
      if (!active || rendererRef.current !== renderer) return;
      setError(nextError);
      setState(nextState);
    });
    rendererRef.current = renderer;
    setState('loading');

    renderer
      .init(container)
      .then(() => {
        if (active && rendererRef.current === renderer) setState('mounted');
      })
      .catch((err) => {
        if (active && rendererRef.current === renderer) {
          setError(err instanceof Error ? err.message : String(err));
          setState('error');
        }
      });

    return () => {
      active = false;
      renderer.destroy();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
  }, [config.width, config.height, config.resolution, config.maxFps, config.backgroundAlpha]);

  // 加载模型
  const loadModel = useCallback(async (options: Live2DModelOptions) => {
    const renderer = rendererRef.current;
    if (!renderer) return false;
    try {
      setError(null);
      setState('loading');
      const loaded = await renderer.loadModel(options);
      if (rendererRef.current === renderer) {
        if (loaded) {
          setState(document.hidden ? 'suspended' : 'mounted');
        } else {
          setError('Live2D model did not reach its first rendered frame');
          setState('error');
        }
      }
      return loaded;
    } catch (err: unknown) {
      if (rendererRef.current === renderer) {
        setError(err instanceof Error ? err.message : String(err));
        setState('error');
      }
      return false;
    }
  }, []);

  const setActive = useCallback(async (active: boolean) => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    try {
      setState(active ? 'loading' : 'suspended');
      await renderer.setActive(active);
      if (active && rendererRef.current === renderer) setState('mounted');
    } catch (err: unknown) {
      if (rendererRef.current === renderer) {
        setError(err instanceof Error ? err.message : String(err));
        setState('error');
      }
    }
  }, []);

  useEffect(() => {
    const handleVisibility = () => { void setActive(!document.hidden); };
    const handleLifecycle = (event: { state?: string }) => {
      const active = !document.hidden
        && !['inactive', 'suspend', 'lock-screen', 'hidden'].includes(event?.state || '');
      void setActive(active);
    };
    document.addEventListener('visibilitychange', handleVisibility);
    const unsubscribe = window.electronAPI?.onAppLifecycle?.(handleLifecycle);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      unsubscribe?.();
    };
  }, [setActive]);

  const setExpression = useCallback((expr: string) => {
    rendererRef.current?.setExpression(expr);
  }, []);

  const setSpeaking = useCallback((speaking: boolean) => {
    rendererRef.current?.setMouthOpen(speaking ? 0.7 : 0.0);
  }, []);

  const playMotion = useCallback((group: string) => {
    rendererRef.current?.playMotion(group);
  }, []);

  return {
    containerRef,
    state,
    error,
    loadModel,
    setExpression,
    setSpeaking,
    setActive,
    playMotion,
  };
}

// ── React 组件 ─────────────────────────────────────────

export function Live2DCanvas({
  config,
  modelUrl,
  expression = 'neutral',
  speaking = false,
  motion = '',
  className,
  onStateChange,
}: {
  config: Live2DConfig;
  modelUrl?: string;
  expression?: string;
  speaking?: boolean;
  motion?: string;
  className?: string;
  onStateChange?: (state: Live2DState, error: string | null) => void;
}) {
  const {
    containerRef,
    state,
    error,
    loadModel,
    setExpression,
    setSpeaking,
    playMotion,
  } = useLive2D(config);
  const loadedModelUrlRef = useRef('');
  const loadingModelUrlRef = useRef('');
  const failedModelUrlRef = useRef('');
  const [modelReadyUrl, setModelReadyUrl] = useState('');

  useEffect(() => {
    const publicState = state === 'mounted' && modelUrl && modelReadyUrl !== modelUrl
      ? 'loading'
      : state;
    onStateChange?.(publicState, error);
  }, [error, modelReadyUrl, modelUrl, onStateChange, state]);

  useEffect(() => {
    if (
      modelUrl
      && state === 'mounted'
      && loadedModelUrlRef.current !== modelUrl
      && loadingModelUrlRef.current !== modelUrl
      && failedModelUrlRef.current !== modelUrl
    ) {
      loadingModelUrlRef.current = modelUrl;
      void loadModel({ url: modelUrl }).then((loaded) => {
        if (loaded) {
          loadedModelUrlRef.current = modelUrl;
          setModelReadyUrl(modelUrl);
          failedModelUrlRef.current = '';
        } else {
          setModelReadyUrl('');
          failedModelUrlRef.current = modelUrl;
        }
        if (loadingModelUrlRef.current === modelUrl) loadingModelUrlRef.current = '';
      });
    }
  }, [modelUrl, state, loadModel]);

  useEffect(() => {
    setExpression(expression);
  }, [expression, setExpression]);

  useEffect(() => {
    setSpeaking(speaking);
  }, [speaking, setSpeaking]);

  useEffect(() => {
    if (modelReadyUrl === modelUrl && motion) {
      playMotion(motion.split('#', 1)[0]);
    }
  }, [modelReadyUrl, modelUrl, motion, playMotion]);

  return (
    <div className={className} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {(state === 'loading' || (modelUrl && modelReadyUrl !== modelUrl && state !== 'error')) && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' }}>
          Loading model...
        </div>
      )}
      {state === 'error' && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#f66', fontSize: 12, textAlign: 'center', padding: 8 }}>
          {error}
        </div>
      )}
    </div>
  );
}
