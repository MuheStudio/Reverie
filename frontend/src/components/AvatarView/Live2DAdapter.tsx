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
import { Application, Ticker } from 'pixi.js';

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

  constructor(config: Live2DConfig) {
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

      this.app.stage.scale.set(res);
      this.canvas = this.app.view as HTMLCanvasElement;
      this.canvas.style.width = '100%';
      this.canvas.style.height = '100%';
      this.canvas.style.objectFit = 'cover';
      this.canvas.style.display = 'block';

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
    if (!model) return;
    try { this.app?.stage?.removeChild?.(model); } catch {}
    this.destroyDetachedModel(model);
    try { this.app?.renderer?.textureGC?.run?.(); } catch {}
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
        await this.loadModel(this.desiredModel);
      } catch (error) {
        this.suspended = true;
        try { this.app?.ticker?.stop?.(); } catch {}
        throw error;
      }
    }
  }

  setExpression(expression: string): void {
    try { void this.model?.expression?.(expression); } catch {}
  }

  setMouthOpen(ratio: number): void {
    if (this.model?.internalModel?.coreModel) {
      try {
        this.model.internalModel.coreModel.setParameterValueById('ParamMouthOpenY', ratio);
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
    const renderer = new Live2DRenderer(config);
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
      if (rendererRef.current === renderer) setState(document.hidden ? 'suspended' : 'mounted');
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

  return { containerRef, state, error, loadModel, setExpression, setSpeaking, setActive };
}

// ── React 组件 ─────────────────────────────────────────

export function Live2DCanvas({
  config,
  modelUrl,
  expression = 'neutral',
  speaking = false,
  className,
  onStateChange,
}: {
  config: Live2DConfig;
  modelUrl?: string;
  expression?: string;
  speaking?: boolean;
  className?: string;
  onStateChange?: (state: Live2DState, error: string | null) => void;
}) {
  const { containerRef, state, error, loadModel, setExpression, setSpeaking } = useLive2D(config);
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
