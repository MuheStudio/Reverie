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
import {
  applyMotionPoseSnapshot,
  collectMotionPoseSnapshot,
  type MotionPoseSnapshot,
} from './motionPose';

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
    } else {
      // A pre-existing script may have already fired (or never fire again)
      // its load event; the load listener alone would wait out the full
      // timeout. Probe for the core instead, which resolves as soon as the
      // runtime actually lands.
      const probe = window.setInterval(() => {
        if (runtime.Live2DCubismCore) {
          window.clearInterval(probe);
          finish();
        }
      }, 100);
      window.setTimeout(() => window.clearInterval(probe), 10_000);
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

// One-shot motions (wave, tear) must always hand the pose back. The real
// culprit behind "the arm never comes down" is that a motion's own final
// keyframes do NOT return the pose: yumi's wave ends with Paramanime at 1 and
// its physics-driven arm parameters carry no return keyframes, so after the
// runtime fires motionFinish the model stays frozen in the wave's last
// evaluated state. Every motion therefore gets an idle-pose restore when it
// finishes, plus this long-stop watchdog as a backstop for finishes that never
// fire (well past any motion's authored duration — wave is 4.5s).
const MOTION_MAX_MS = 10_000;

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

export class Live2DRenderer {
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
  private keepAlive: number | null = null;
  private rebuilding = false;
  private lostTicks = 0;
  private lastRebuildAt = 0;
  private watchdogTicks = 0;
  private rebuildCount = 0;
  private mouthOpen = 0;
  private motionWatchdog: number | null = null;
  private motionSnapshot: MotionPoseSnapshot | null = null;
  private detachMotionFinish: (() => void) | null = null;

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
        // Do not stop the ticker here: rendering into a lost context is a
        // safe no-op, and keeping the loop alive means the character is back
        // the moment the context returns — even when the visibility signal
        // is stuck on "hidden" and rAF never resumes on its own.
        this.reportRuntimeState?.('suspended', 'Live2D WebGL context was lost');
      };
      const handleContextRestored = () => {
        if (this.destroyed) return;
        this.suspended = false;
        // GL objects born under the old context cannot be trusted to survive
        // its restoration; rebuild the whole renderer instead of hoping the
        // model reload lands on healthy GL state.
        void this.rebuildRenderer().catch((error) => {
          console.error('[Live2D] Renderer rebuild after context restore failed', error);
          this.reportRuntimeState?.('error', 'Live2D renderer rebuild failed after WebGL restore');
        });
      };
      this.canvas.addEventListener('webglcontextlost', handleContextLost);
      this.canvas.addEventListener('webglcontextrestored', handleContextRestored);
      this.detachCanvasRuntime = () => {
        this.canvas?.removeEventListener('webglcontextlost', handleContextLost);
        this.canvas?.removeEventListener('webglcontextrestored', handleContextRestored);
      };

      // rAF freezes at 0Hz whenever Chromium believes the page is hidden, and
      // that belief can stick after a minimize/restore. One manual tick per
      // second keeps the model painted (worst case choppy) no matter what the
      // visibility signal does; when rAF runs normally this is a harmless
      // extra frame. The tick also watches for a context that was lost
      // without its restoration event ever arriving.
      this.keepAlive = window.setInterval(() => {
        this.watchdogTicks += 1;
        if (this.destroyed || !this.app) return;
        // Self-heal first: whatever path dropped the model (a race, a stuck
        // visibility signal, a half-handled context loss), a resident
        // desiredModel with no live model is always wrong. Rebuild at most
        // once every 5s so a hard failure degrades to slow retries instead
        // of a hot loop.
        if (!this.model && this.desiredModel && !this.rebuilding) {
          if (performance.now() - this.lastRebuildAt >= 5_000) {
            this.lastRebuildAt = performance.now();
            this.rebuildCount += 1;
            console.debug('[Live2D] watchdog: model missing, rebuilding renderer');
            void this.rebuildRenderer().catch((error) => {
              console.error('[Live2D] Renderer rebuild by watchdog failed', error);
            });
          }
          return;
        }
        const gl = (this.app.renderer as { gl?: { isContextLost?: () => boolean } }).gl;
        if (gl?.isContextLost?.()) {
          this.lostTicks += 1;
          if (this.lostTicks >= 2) {
            this.lostTicks = 0;
            this.lastRebuildAt = performance.now();
            this.rebuildCount += 1;
            void this.rebuildRenderer().catch((error) => {
              console.error('[Live2D] Renderer rebuild after stuck context loss failed', error);
            });
          }
          return;
        }
        this.lostTicks = 0;
        try { this.app.ticker?.update?.(performance.now()); } catch {}
      }, 1000);

      // Read-only diagnostic surface for packaged-build triage (CDP).
      (globalThis as { __reverieLive2D?: unknown }).__reverieLive2D = () => ({
        hasApp: !!this.app,
        tickerStarted: this.app?.ticker?.started === true,
        hasModel: !!this.model,
        suspended: this.suspended,
        destroyed: this.destroyed,
        rebuilding: this.rebuilding,
        canvasConnected: !!this.canvas?.isConnected,
        watchdogTicks: this.watchdogTicks,
        rebuildCount: this.rebuildCount,
        hasDesired: !!this.desiredModel,
        motionWatchdogArmed: this.motionWatchdog !== null,
      });

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
    console.debug('[Live2D] load:start', token);
    if (!this.app || this.destroyed) {
      console.debug('[Live2D] load:early-false', token);
      return false;
    }
    this.destroyModel();
    const { Live2DModel } = await loadLive2DRuntime();
    let model: any;
    try {
      console.debug('[Live2D] load:fetch-begin', token);
      model = await Live2DModel.from(options.url, {
        autoInteract: options.autoInteract ?? false,
      });
      console.debug('[Live2D] load:fetch-resolved', token);
    } catch (error) {
      console.debug('[Live2D] load:fetch-failed', token, error);
      throw error;
    }
    try {
      if (this.destroyed || token !== this.modelToken || !this.app) {
        console.debug('[Live2D] load:abort-post-fetch', token, {
          destroyed: this.destroyed, stale: token !== this.modelToken,
        });
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
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
        // rAF is suspended at 0Hz for pages Chromium believes are hidden, so
        // never hang the load on it; the explicit render below draws the
        // first frame either way.
        setTimeout(resolve, 500);
      });
      if (this.destroyed || token !== this.modelToken || this.model !== model) {
        console.debug('[Live2D] load:abort-post-frame', token, {
          destroyed: this.destroyed, stale: token !== this.modelToken,
          swapped: this.model !== model,
        });
        return false;
      }
      this.app.renderer.render(this.app.stage);
      console.debug('[Live2D] load:done', token);
      return true;
    } catch (error) {
      console.debug('[Live2D] load:failed', token, error);
      this.destroyDetachedModel(model);
      if (this.destroyed || token !== this.modelToken) return false;
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
    this.detachMotionFinish?.();
    this.detachMotionFinish = null;
    this.clearMotionWatchdog();
    // The idle-pose snapshot belongs to the destroyed model — drop it so the
    // next attach captures a fresh one instead of restoring into a corpse.
    this.motionSnapshot = null;
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
    // Capture the pose BEFORE any motion can run — this is the model's neutral
    // state and the restore target for every motion finish and watchdog stop.
    if (!this.motionSnapshot) {
      this.motionSnapshot = collectMotionPoseSnapshot(model);
    }
    const motionManager = internal?.motionManager;
    if (motionManager && typeof motionManager.on === 'function') {
      const onMotionFinish = () => {
        if (this.model !== model) return;
        this.clearMotionWatchdog();
        // A natural finish does NOT guarantee the pose came back: yumi's wave
        // leaves Paramanime at 1 and its physics arms unsettled. Restore the
        // idle snapshot on every finish, not only on the watchdog ceiling.
        this.stopActiveMotion(this.motionSnapshot);
      };
      try { motionManager.on('motionFinish', onMotionFinish); } catch {}
      this.detachMotionFinish = () => {
        try { motionManager.off?.('motionFinish', onMotionFinish); } catch {}
      };
    }
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
      if (this.destroyed || this.model !== model || !this.canvas) return;
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
      // Flag-only. Chromium already throttles requestAnimationFrame to zero
      // for hidden pages, so the render loop pauses itself. Stopping the
      // ticker or destroying the model here made the character vanish
      // permanently whenever Windows' occlusion tracker left visibilityState
      // stuck on "hidden" after a minimize/restore — the resume event never
      // arrived and nothing restarted the loop.
      this.suspended = true;
      return;
    }
    if (!this.suspended) return;
    this.suspended = false;
    try { this.app?.ticker?.start?.(); } catch {}
    if (!this.desiredModel) return;
    if (!this.model) {
      // A genuine WebGL context loss can leave the stage without the model.
      // Rebuild exactly once here instead of trusting the mounted flag.
      try {
        const loaded = await this.loadModel(this.desiredModel);
        if (!loaded) throw new Error('Live2D model did not resume to a rendered frame');
      } catch (error) {
        this.suspended = true;
        try { this.app?.ticker?.stop?.(); } catch {}
        throw error;
      }
      return;
    }
    // The model survived the hidden period; repaint immediately so the first
    // visible frame is not stale or blank.
    try { this.app?.renderer?.render(this.app.stage); } catch {}
  }

  /**
   * Tear down and recreate the whole PIXI application. A WebGL context lost
   * during a minimize can come back (or never come back) in arbitrary state
   * while the visibility signal is stuck lying, so model-level reloads are
   * not enough — a fresh canvas means a fresh context with no history.
   */
  private async rebuildRenderer(): Promise<void> {
    if (this.destroyed || this.rebuilding || !this.container) return;
    this.rebuilding = true;
    try {
      this.destroyModel();
      this.detachCanvasRuntime?.();
      this.detachCanvasRuntime = null;
      if (this.keepAlive) {
        window.clearInterval(this.keepAlive);
        this.keepAlive = null;
      }
      if (this.app) {
        try { this.app.ticker?.stop?.(); } catch {}
        try {
          this.app.destroy(true, { children: true, texture: true, baseTexture: true });
        } catch {
          try { this.app.destroy?.(true); } catch {}
        }
        this.app = null;
      }
      this.canvas = null;
      if (this.container) this.container.innerHTML = '';
      await this.init(this.container);
      if (this.destroyed) return;
      this.reportRuntimeState?.('loading', null);
      if (this.desiredModel) {
        const loaded = await this.loadModel(this.desiredModel);
        if (this.destroyed) return;
        this.reportRuntimeState?.(
          loaded ? 'mounted' : 'error',
          loaded ? null : 'Live2D model did not recover after the renderer rebuild',
        );
      } else {
        this.reportRuntimeState?.('mounted', null);
      }
    } finally {
      this.rebuilding = false;
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

  /**
   * The idle-pose snapshot is captured once at attach time (before any motion
   * can run). This only falls back to an arm-time capture when attach-time
   * collection failed — re-clicking an ongoing motion must never re-snapshot,
   * or a raised arm would be frozen into the "idle" reference.
   */
  private armMotionWatchdog(): void {
    if (!this.motionSnapshot && this.model) {
      this.motionSnapshot = collectMotionPoseSnapshot(this.model);
    }
    const snapshot = this.motionSnapshot;
    if (this.motionWatchdog) window.clearTimeout(this.motionWatchdog);
    this.motionWatchdog = window.setTimeout(() => {
      this.motionWatchdog = null;
      this.stopActiveMotion(snapshot);
    }, MOTION_MAX_MS);
  }

  private clearMotionWatchdog(): void {
    if (this.motionWatchdog) {
      window.clearTimeout(this.motionWatchdog);
      this.motionWatchdog = null;
    }
    // this.motionSnapshot is the model's standing idle-pose reference; it
    // survives until destroyModel drops it with the model itself.
  }

  private stopActiveMotion(snapshot: MotionPoseSnapshot | null): void {
    if (!snapshot || this.destroyed || this.model !== snapshot.model) return;
    const model = snapshot.model as {
      internalModel?: {
        motionManager?: {
          stopAllMotions?: () => void;
          expressionManager?: { resetExpression?: () => void };
        };
      };
    } | null;
    try { model?.internalModel?.motionManager?.stopAllMotions?.(); } catch {}
    applyMotionPoseSnapshot(snapshot);
    try {
      model?.internalModel?.motionManager?.expressionManager?.resetExpression?.();
    } catch {}
    try { this.app?.renderer?.render?.(this.app.stage); } catch {}
    console.debug('[Live2D] motion ended: restored idle pose');
  }

  playMotion(group: string): void {
    if (!group) return;
    try {
      this.armMotionWatchdog();
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
    if (this.keepAlive) {
      window.clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
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
  // Bumped every time the renderer is (re)created. Callers gate per-renderer
  // bookkeeping (e.g. the "already loaded this URL" refs) on it, or a
  // recreated renderer would inherit a stale "loaded" mark and never load.
  const [epoch, setEpoch] = useState(0);

  // 初始化渲染器
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let active = true;
    let renderer: Live2DRenderer;
    setEpoch((value) => value + 1);
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
          // Rendering no longer tracks visibility, so a successful load is a
          // mounted runtime even if the visibility signal is stuck lying.
          setState('mounted');
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

  const setMouth = useCallback((ratio: number) => {
    rendererRef.current?.setMouthOpen(ratio);
  }, []);

  const playMotion = useCallback((group: string) => {
    rendererRef.current?.playMotion(group);
  }, []);

  return {
    containerRef,
    state,
    error,
    epoch,
    loadModel,
    setExpression,
    setSpeaking,
    setMouth,
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
  mouthLevel,
  motion = '',
  className,
  onStateChange,
}: {
  config: Live2DConfig;
  modelUrl?: string;
  expression?: string;
  speaking?: boolean;
  mouthLevel?: number;
  motion?: string;
  className?: string;
  onStateChange?: (state: Live2DState, error: string | null) => void;
}) {
  const {
    containerRef,
    state,
    error,
    epoch,
    loadModel,
    setExpression,
    setSpeaking,
    setMouth,
    playMotion,
  } = useLive2D(config);
  const loadedModelUrlRef = useRef('');
  const loadingModelUrlRef = useRef('');
  const failedModelUrlRef = useRef('');
  const [modelReadyUrl, setModelReadyUrl] = useState('');

  // A recreated renderer knows nothing about previously loaded models. If the
  // per-renderer bookkeeping survived (refs do), the "already loaded" gate
  // would silently block the model from ever loading again.
  useEffect(() => {
    loadedModelUrlRef.current = '';
    loadingModelUrlRef.current = '';
    failedModelUrlRef.current = '';
    setModelReadyUrl('');
  }, [epoch]);

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
    if (typeof mouthLevel === 'number') {
      setMouth(mouthLevel);
    } else {
      setSpeaking(speaking);
    }
  }, [speaking, mouthLevel, setMouth, setSpeaking]);

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
