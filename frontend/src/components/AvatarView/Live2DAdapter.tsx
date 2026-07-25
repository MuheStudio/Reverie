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
      // 动态导入 PixiJS + Live2D（可选依赖，变量路径绕过 Rollup 静态分析）
      const pixiApp = '@pixi/app';
      const pixiExt = '@pixi/extensions';
      const pixiTicker = '@pixi/ticker';
      const live2dMod = 'pixi-live2d-display/cubism4';
      const [{ Application }, { extensions }, { Ticker, TickerPlugin }, { Live2DModel }] =
        await Promise.all([
          import(/* @vite-ignore */ pixiApp),
          import(/* @vite-ignore */ pixiExt),
          import(/* @vite-ignore */ pixiTicker),
          import(/* @vite-ignore */ live2dMod),
        ]);

      if (this.destroyed || token !== this.lifecycleToken) {
        throw new Error('Live2D initialization was cancelled');
      }
      Live2DModel.registerTicker(Ticker);
      extensions.add(TickerPlugin);

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
    const live2dMod = 'pixi-live2d-display/cubism4';
    const { Live2DModel, Live2DFactory } = await import(/* @vite-ignore */ live2dMod);
    const model = new Live2DModel();
    try {
      await Live2DFactory.setupLive2DModel(
        model,
        { url: options.url, id: options.modelId },
        { autoInteract: options.autoInteract ?? false }
      );
      if (this.destroyed || this.suspended || token !== this.modelToken || !this.app) {
        this.destroyDetachedModel(model);
        return false;
      }
      this.model = model;
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
    if (this.model?.internalModel?.motionManager) {
      try {
        this.model.internalModel.motionManager.expression = expression;
      } catch {}
    }
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
}: {
  config: Live2DConfig;
  modelUrl?: string;
  expression?: string;
  speaking?: boolean;
  className?: string;
}) {
  const { containerRef, state, error, loadModel, setExpression, setSpeaking } = useLive2D(config);
  const loadedModelUrlRef = useRef('');
  const loadingModelUrlRef = useRef('');
  const failedModelUrlRef = useRef('');

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
          failedModelUrlRef.current = '';
        } else {
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
    <div className={className} style={{ position: 'relative', width: config.width, height: config.height }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {state === 'loading' && (
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
