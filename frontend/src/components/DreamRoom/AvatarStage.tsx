import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AmbientLight,
  AnimationMixer,
  Box3,
  Clock,
  DirectionalLight,
  LoopOnce,
  LoopRepeat,
  Object3D,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { AnimationAction, AnimationClip } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import {
  createVRMAnimationClip,
  VRMAnimationLoaderPlugin,
  type VRMAnimation,
} from '@pixiv/three-vrm-animation';
import { Live2DCanvas, type Live2DState } from '../AvatarView/Live2DAdapter';
import {
  AVATAR_ACTION_KEYS,
  AVATAR_EXPRESSION_KEYS,
  type AvatarDetectedCapabilities,
  type AvatarExpressionKey,
  type CharacterActivity,
} from './avatarContracts';
import styles from './AvatarStage.module.scss';

interface AvatarStageProps {
  avatar: AvatarRecord | null;
  live2dRuntime?: AvatarListResult['runtime'];
  activity: CharacterActivity;
  expressionOverride?: AvatarExpressionKey | null;
  lowPower?: boolean;
  onStatusChange?: (status: 'empty' | 'loading' | 'ready' | 'paused' | 'error') => void;
  onCapabilitiesDetected?: (capabilities: AvatarDetectedCapabilities) => void;
}

const ACTION_PATTERNS: Record<CharacterActivity, string[]> = {
  'idle.default': ['idle', 'default', 'stand', 'breath'],
  'chat.thinking': ['think', 'thinking', 'ponder', 'listen'],
  'chat.ready': ['ready', 'notice', 'nod'],
  'chat.deliver': ['talk', 'speak', 'chat', 'deliver'],
  'focus.enter': ['focusstart', 'focusenter', 'sitdown', 'studybegin'],
  'focus.loop': ['focus', 'study', 'read', 'write', 'work'],
  'focus.complete': ['complete', 'success', 'finish', 'celebrate'],
  attention: ['attention', 'wave', 'greet', 'look'],
};

const EXPRESSION_PATTERNS: Record<AvatarExpressionKey, string[]> = {
  neutral: ['neutral', 'default'],
  joy: ['joy', 'happy', 'smile', 'fun'],
  sad: ['sad', 'sorrow'],
  angry: ['angry', 'mad'],
  surprised: ['surprised', 'surprise', 'astonished'],
  calm: ['calm', 'relaxed', 'relax'],
};

const ACTION_EXPRESSION: Record<CharacterActivity, AvatarExpressionKey> = {
  'idle.default': 'neutral',
  'chat.thinking': 'calm',
  'chat.ready': 'surprised',
  'chat.deliver': 'joy',
  'focus.enter': 'calm',
  'focus.loop': 'calm',
  'focus.complete': 'joy',
  attention: 'surprised',
};

function normalizedCapabilityName(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '');
}

function autoMatch(
  values: string[],
  patterns: string[],
  explicit?: string,
): string | undefined {
  const explicitName = explicit?.replace(/^clip:/, '').replace(/^expression:/, '');
  if (explicitName && values.includes(explicitName)) return explicitName;
  for (const pattern of patterns) {
    const match = values.find((value) => normalizedCapabilityName(value).includes(pattern));
    if (match) return match;
  }
  return undefined;
}

function frameObject(camera: PerspectiveCamera, object: Object3D): void {
  const box = new Box3().setFromObject(object);
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());
  const height = Math.max(size.y, 0.8);
  const distance = height / (2 * Math.tan((camera.fov * Math.PI) / 360));
  camera.position.set(center.x, center.y + height * 0.04, center.z + distance * 1.18);
  camera.near = Math.max(0.01, distance / 100);
  camera.far = Math.max(100, distance * 10);
  camera.lookAt(center.x, center.y + height * 0.02, center.z);
  camera.updateProjectionMatrix();
}

function disposeScene(scene: Scene): void {
  // three-vrm's utility covers geometry, materials and texture slots,
  // including extension-owned objects that a shallow traversal can miss.
  VRMUtils.deepDispose(scene);
  scene.clear();
}

export default function AvatarStage({
  avatar,
  live2dRuntime,
  activity,
  expressionOverride = null,
  lowPower = false,
  onStatusChange,
  onCapabilitiesDetected,
}: AvatarStageProps) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const activityRef = useRef(activity);
  const expressionOverrideRef = useRef(expressionOverride);
  const statusCallbackRef = useRef(onStatusChange);
  const capabilitiesCallbackRef = useRef(onCapabilitiesDetected);
  const [status, setStatus] = useState<'empty' | 'loading' | 'ready' | 'paused' | 'error'>(
    avatar ? 'loading' : 'empty',
  );
  const [message, setMessage] = useState('');
  const live2dGate = live2dRuntime?.live2d;
  const live2dAllowed = avatar?.kind === 'live2d'
    && Boolean(live2dGate?.available)
    && Boolean(live2dGate?.licenseAccepted || live2dGate?.developmentOnly);
  const live2dCapabilities = useMemo<AvatarDetectedCapabilities>(() => {
    const animationClips = avatar?.detected?.animationClips ?? [];
    const expressions = avatar?.detected?.expressions ?? [];
    return {
      animationClips,
      expressions,
      actionMatches: Object.fromEntries(
        AVATAR_ACTION_KEYS
          .map((key) => [
            key,
            autoMatch(animationClips, ACTION_PATTERNS[key], avatar?.mapping?.actions?.[key]),
          ])
          .filter((entry): entry is [CharacterActivity, string] => Boolean(entry[1])),
      ),
      expressionMatches: Object.fromEntries(
        AVATAR_EXPRESSION_KEYS
          .map((key) => [
            key,
            autoMatch(expressions, EXPRESSION_PATTERNS[key], avatar?.mapping?.expressions?.[key]),
          ])
          .filter((entry): entry is [AvatarExpressionKey, string] => Boolean(entry[1])),
      ),
      vrmaPlayback: false,
    };
  }, [avatar]);
  const live2dExpressionKey = expressionOverride || ACTION_EXPRESSION[activity];
  const live2dExpression = live2dCapabilities.expressionMatches[live2dExpressionKey] || 'neutral';

  useEffect(() => {
    activityRef.current = activity;
  }, [activity]);

  useEffect(() => {
    expressionOverrideRef.current = expressionOverride;
  }, [expressionOverride]);

  useEffect(() => {
    statusCallbackRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    capabilitiesCallbackRef.current = onCapabilitiesDetected;
  }, [onCapabilitiesDetected]);

  useEffect(() => {
    const report = (next: typeof status, detail = '') => {
      setStatus(next);
      setMessage(detail);
      statusCallbackRef.current?.(next);
    };
    const host = hostRef.current;
    if (!host || !avatar) {
      report('empty');
      return undefined;
    }
    if (avatar.kind === 'live2d') {
      if (!live2dAllowed || !avatar.entryUrl) {
        report(
          'error',
          live2dGate?.reason
            || (!live2dGate?.licenseAccepted && !live2dGate?.developmentOnly
              ? t('dream.live2dLicenseMissing')
              : t('dream.live2dRuntimeUnavailable')),
        );
      } else {
        report('loading');
      }
      return undefined;
    }
    if (!avatar.entryUrl) {
      report('error', t('dream.avatarEntryUnavailable'));
      return undefined;
    }

    let disposed = false;
    let frame = 0;
    let model: Object3D | null = null;
    let vrm: VRM | null = null;
    let mixer: AnimationMixer | null = null;
    let activeAnimation: AnimationAction | null = null;
    let animationClips: AnimationClip[] = [];
    let actionMatches: Partial<Record<CharacterActivity, string>> = {};
    let expressionMatches: Partial<Record<AvatarExpressionKey, string>> = {};
    let lastAppliedState = '';
    let lastFrameAt = 0;
    let contextLost = false;
    let appSuspended = false;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const scene = new Scene();
    const camera = new PerspectiveCamera(30, 1, 0.01, 100);
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({
        alpha: true,
        antialias: !lowPower,
        powerPreference: lowPower ? 'low-power' : 'high-performance',
      });
      renderer.outputColorSpace = SRGBColorSpace;
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.domElement.className = styles.canvas;
      renderer.domElement.setAttribute('aria-hidden', 'true');
      host.replaceChildren(renderer.domElement);
    } catch (error) {
      disposeScene(scene);
      report(
        'error',
        error instanceof Error ? error.message : t('dream.graphicsUnavailable'),
      );
      return undefined;
    }
    scene.add(new AmbientLight(0xfff6ef, 1.6));
    const keyLight = new DirectionalLight(0xffdfc7, 2.4);
    keyLight.position.set(1.6, 2.8, 2.4);
    scene.add(keyLight);

    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    let resizeObserver: ResizeObserver | null = null;
    let resizeOnWindow = false;
    try {
      if (typeof ResizeObserver === 'undefined') {
        resizeOnWindow = true;
        window.addEventListener('resize', resize);
      } else {
        resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(host);
      }
      resize();
    } catch (error) {
      resizeObserver?.disconnect();
      if (resizeOnWindow) window.removeEventListener('resize', resize);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      disposeScene(scene);
      report(
        'error',
        error instanceof Error ? error.message : t('dream.graphicsUnavailable'),
      );
      return undefined;
    }

    const targetFps = lowPower || reducedMotion.matches ? 15 : 30;
    const interval = 1000 / targetFps;
    const clock = new Clock();
    const shouldRun = () => (
      !disposed
      && !contextLost
      && !appSuspended
      && !document.hidden
    );
    const playClip = (clipName: string, activityKey: CharacterActivity) => {
      if (!mixer || reducedMotion.matches) return false;
      const clip = animationClips.find((item) => item.name === clipName);
      if (!clip) return false;
      activeAnimation?.stop();
      mixer.stopAllAction();
      const next = mixer.clipAction(clip);
      const looping = [
        'idle.default',
        'chat.thinking',
        'focus.loop',
      ].includes(activityKey);
      next.reset();
      next.enabled = true;
      next.clampWhenFinished = !looping;
      next.setLoop(looping ? LoopRepeat : LoopOnce, looping ? Infinity : 1);
      next.play();
      activeAnimation = next;
      return true;
    };
    const applyActivity = () => {
      const activityKey = activityRef.current;
      const expressionOverrideKey = expressionOverrideRef.current;
      const stateKey = `${activityKey}:${expressionOverrideKey || ''}`;
      if (!model || lastAppliedState === stateKey) return;
      lastAppliedState = stateKey;
      vrm?.expressionManager?.resetValues();
      if (expressionOverrideKey) {
        const expression = expressionMatches[expressionOverrideKey];
        if (expression && vrm?.expressionManager?.getExpression(expression)) {
          activeAnimation?.stop();
          mixer?.stopAllAction();
          activeAnimation = null;
          vrm.expressionManager.setValue(expression, 0.72);
          return;
        }
      }
      const requestedAction = actionMatches[activityKey];
      if (requestedAction && playClip(requestedAction, activityKey)) return;

      // Contractual failure order: missing action -> expression -> idle.
      const expressionKey = ACTION_EXPRESSION[activityKey];
      const expression = expressionMatches[expressionKey];
      if (expression && vrm?.expressionManager?.getExpression(expression)) {
        activeAnimation?.stop();
        mixer?.stopAllAction();
        activeAnimation = null;
        vrm.expressionManager.setValue(expression, expressionKey === 'neutral' ? 0.35 : 0.62);
        return;
      }

      const idleClip = actionMatches['idle.default'];
      if (idleClip && activityKey !== 'idle.default') {
        playClip(idleClip, 'idle.default');
      } else {
        activeAnimation?.stop();
        mixer?.stopAllAction();
        activeAnimation = null;
      }
    };
    const animate = (time: number) => {
      if (!shouldRun()) {
        frame = 0;
        return;
      }
      frame = requestAnimationFrame(animate);
      if (time - lastFrameAt < interval) return;
      const delta = Math.min(clock.getDelta(), 0.1);
      lastFrameAt = time;
      applyActivity();
      mixer?.update(delta);
      vrm?.update(delta);
      renderer.render(scene, camera);
    };
    const start = () => {
      if (!model || !shouldRun() || frame) return;
      clock.start();
      applyActivity();
      renderer.render(scene, camera);
      report('ready');
      frame = requestAnimationFrame(animate);
    };
    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      clock.stop();
      if (!disposed && model) report('paused');
    };
    const handleVisibility = () => (document.hidden ? stop() : start());
    const handleLifecycle = (event: { state: string }) => {
      appSuspended = ['suspend', 'hidden', 'lock', 'shutdown'].includes(event.state);
      if (appSuspended) stop();
      else start();
    };
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      stop();
      report('paused', t('dream.graphicsUnavailable'));
    };
    const handleContextRestored = () => {
      contextLost = false;
      resize();
      start();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    renderer.domElement.addEventListener('webglcontextlost', handleContextLost);
    renderer.domElement.addEventListener('webglcontextrestored', handleContextRestored);
    const unsubscribeLifecycle = window.electronAPI?.onAppLifecycle?.(handleLifecycle);

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const loadVrmaClip = (motion: AvatarMotionRecord, targetVrm: VRM) => (
      new Promise<AnimationClip | null>((resolve) => {
        const motionLoader = new GLTFLoader();
        motionLoader.register((parser) => new VRMAnimationLoaderPlugin(parser));
        motionLoader.load(
          motion.url,
          (motionGltf) => {
            try {
              const animations = (motionGltf.userData.vrmAnimations ?? []) as VRMAnimation[];
              const animation = animations[0];
              if (!animation) return resolve(null);
              const clip = createVRMAnimationClip(animation, targetVrm);
              clip.name = `vrma:${motion.id}`;
              return resolve(clip);
            } catch {
              return resolve(null);
            } finally {
              VRMUtils.deepDispose(motionGltf.scene);
            }
          },
          undefined,
          () => resolve(null),
        );
      })
    );
    report('loading');
    try {
      loader.load(
        avatar.entryUrl,
        async (gltf) => {
          if (disposed) {
            VRMUtils.deepDispose(gltf.scene);
            return;
          }
          try {
            vrm = (gltf.userData.vrm as VRM | undefined) ?? null;
            if (vrm) {
              VRMUtils.rotateVRM0(vrm);
              model = vrm.scene;
            } else {
              model = gltf.scene;
            }
            animationClips = gltf.animations.map((clip, index) => {
              if (!clip.name.trim()) clip.name = `animation-${index + 1}`;
              return clip;
            });
            if (vrm && avatar.motions?.length) {
              const attached = await Promise.all(
                avatar.motions.map((motion) => loadVrmaClip(motion, vrm!)),
              );
              if (disposed) {
                VRMUtils.deepDispose(gltf.scene);
                return;
              }
              animationClips.push(...attached.filter((clip): clip is AnimationClip => clip !== null));
            }
            if (animationClips.length) mixer = new AnimationMixer(model);
            const clipNames = animationClips.map((clip) => clip.name);
            const expressionNames = vrm?.expressionManager
              ? Object.keys(vrm.expressionManager.expressionMap)
              : [];
            actionMatches = Object.fromEntries(
              AVATAR_ACTION_KEYS
                .map((key) => [
                  key,
                  autoMatch(clipNames, ACTION_PATTERNS[key], avatar.mapping?.actions?.[key]),
                ])
                .filter((entry): entry is [CharacterActivity, string] => Boolean(entry[1])),
            );
            expressionMatches = Object.fromEntries(
              AVATAR_EXPRESSION_KEYS
                .map((key) => [
                  key,
                  autoMatch(
                    expressionNames,
                    EXPRESSION_PATTERNS[key],
                    avatar.mapping?.expressions?.[key],
                  ),
                ])
                .filter((entry): entry is [AvatarExpressionKey, string] => Boolean(entry[1])),
            );
            capabilitiesCallbackRef.current?.({
              animationClips: clipNames,
              expressions: expressionNames,
              actionMatches,
              expressionMatches,
              vrmaPlayback: Boolean(vrm),
            });
            scene.add(model);
            frameObject(camera, model);
            start();
          } catch (error) {
            if (model?.parent === scene) scene.remove(model);
            VRMUtils.deepDispose(gltf.scene);
            model = null;
            vrm = null;
            mixer = null;
            animationClips = [];
            report('error', error instanceof Error ? error.message : t('dream.avatarLoadFailed'));
          }
        },
        undefined,
        (error) => {
          if (!disposed) {
            report('error', error instanceof Error ? error.message : t('dream.avatarLoadFailed'));
          }
        },
      );
    } catch (error) {
      report('error', error instanceof Error ? error.message : t('dream.avatarLoadFailed'));
    }

    return () => {
      disposed = true;
      stop();
      document.removeEventListener('visibilitychange', handleVisibility);
      renderer.domElement.removeEventListener('webglcontextlost', handleContextLost);
      renderer.domElement.removeEventListener('webglcontextrestored', handleContextRestored);
      unsubscribeLifecycle?.();
      resizeObserver?.disconnect();
      if (resizeOnWindow) window.removeEventListener('resize', resize);
      activeAnimation?.stop();
      mixer?.stopAllAction();
      if (mixer && model) mixer.uncacheRoot(model);
      disposeScene(scene);
      renderer.renderLists.dispose();
      renderer.dispose();
      // Explicitly release the WebGL context so repeatedly changing models
      // cannot accumulate GPU processes/resources.
      renderer.forceContextLoss();
      renderer.domElement.remove();
      model = null;
      vrm = null;
      mixer = null;
      activeAnimation = null;
      animationClips = [];
    };
  }, [avatar, live2dAllowed, live2dGate, live2dRuntime, lowPower, t]);

  const handleLive2DState = useCallback((next: Live2DState, detail: string | null) => {
    const mapped = {
      pending: 'loading',
      loading: 'loading',
      mounted: 'ready',
      suspended: 'paused',
      error: 'error',
    }[next] as typeof status;
    setStatus(mapped);
    setMessage(detail || '');
    statusCallbackRef.current?.(mapped);
    if (mapped === 'ready') capabilitiesCallbackRef.current?.(live2dCapabilities);
  }, [live2dCapabilities]);

  return (
    <div
      className={styles.stage}
      data-avatar-status={status}
      data-character-activity={activity}
      aria-label={avatar
        ? t('dream.avatarStageNamed', { name: avatar.name })
        : t('dream.avatarStageGeneric')}
    >
      <div ref={hostRef} className={styles.renderHost} hidden={avatar?.kind === 'live2d'} />
      {avatar?.kind === 'live2d' && live2dAllowed && avatar.entryUrl && (
        <Live2DCanvas
          className={styles.canvas}
          config={{ width: 640, height: 720, resolution: lowPower ? 1 : 1.5, maxFps: lowPower ? 15 : 30 }}
          modelUrl={avatar.entryUrl}
          expression={live2dExpression}
          onStateChange={handleLive2DState}
        />
      )}
      {status !== 'ready' && status !== 'paused' && (
        <div className={styles.stageNotice} role={status === 'error' ? 'alert' : 'status'}>
          <span aria-hidden="true">{status === 'error' ? '!' : '✦'}</span>
          <strong>
            {status === 'empty'
              ? t('dream.avatarStageEmpty')
              : status === 'loading'
                ? t('dream.avatarStageLoading')
                : t('dream.avatarStageError')}
          </strong>
          {message && <small>{message}</small>}
        </div>
      )}
    </div>
  );
}
