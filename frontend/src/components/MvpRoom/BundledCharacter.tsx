import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Live2DCanvas,
  type Live2DState,
} from '@/components/AvatarView/Live2DAdapter';
import styles from './MvpRoom.module.scss';

type Props = {
  emotions: Record<string, number>;
  speaking: boolean;
};

type CharacterSnapshot = {
  record: AvatarRecord | null;
  runtime?: AvatarRuntime;
};

const EXPRESSION_ORDER = ['joy', 'sad', 'angry', 'surprised', 'calm'] as const;

function expressionFor(
  emotions: Record<string, number>,
  record: AvatarRecord | null,
): string {
  const aliases: Record<string, string> = {
    sadness: 'sad',
    anger: 'angry',
    excitement: 'joy',
    touched: 'joy',
  };
  const dominant = Object.entries(emotions)
    .map(([name, value]) => [aliases[name] || name, value] as const)
    .filter(([name, value]) => (
      EXPRESSION_ORDER.includes(name as typeof EXPRESSION_ORDER[number])
      && Number.isFinite(value)
      && value > 0.2
    ))
    .sort((left, right) => right[1] - left[1])[0]?.[0] || 'neutral';
  if (dominant === 'neutral' || dominant === 'calm') return '';
  const mapped = record?.mapping?.expressions?.[dominant] || '';
  return mapped.replace(/^expression:/, '');
}

export default function BundledCharacter({ emotions, speaking }: Props) {
  const [snapshot, setSnapshot] = useState<CharacterSnapshot>({
    record: null,
  });
  const [state, setState] = useState<Live2DState>('pending');
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [motionRequest, setMotionRequest] = useState('');
  const motionSequence = useRef(0);
  const previousSad = useRef(false);

  useEffect(() => {
    let disposed = false;
    void window.electronAPI?.character?.get()
      .then((value) => {
        if (!disposed) setSnapshot(value);
      })
      .catch(() => {
        if (!disposed) setSnapshot({ record: null });
      });
    return () => {
      disposed = true;
    };
  }, []);

  const record = snapshot.record;
  const runtime = snapshot.runtime?.live2d;
  const canRender = Boolean(
    record
    && record.kind === 'live2d'
    && record.status === 'ready'
    && record.entryUrl
    && runtime?.available
    && (runtime.licenseAccepted || runtime.developmentOnly),
  );
  const expression = useMemo(
    () => expressionFor(emotions, record),
    [emotions, record],
  );
  const clips = new Set(record?.detected?.animationClips || []);
  const requestMotion = (group: string) => {
    if (!canRender || !clips.has(group)) return;
    motionSequence.current += 1;
    setMotionRequest(`${group}#${motionSequence.current}`);
  };

  useEffect(() => {
    const sad = (emotions.sad ?? emotions.sadness ?? 0) > 0.45;
    if (sad && !previousSad.current) requestMotion('tear');
    previousSad.current = sad;
  }, [canRender, emotions, record?.id]);

  return (
    <section className={styles.character} aria-label="内置陪伴角色">
      {canRender ? (
        <div
          className={styles.live2dInteraction}
          role="button"
          tabIndex={0}
          aria-label="Yumi Live2D 角色；点击挥手"
          onClick={() => requestMotion('wave')}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              requestMotion('wave');
            }
          }}
        >
          <Live2DCanvas
            className={styles.live2d}
            config={{
              width: 620,
              height: 760,
              resolution: Math.min(1.5, window.devicePixelRatio || 1),
              maxFps: document.hidden ? 15 : 30,
              backgroundAlpha: 0,
            }}
            modelUrl={record?.entryUrl}
            expression={expression}
            speaking={speaking}
            motion={motionRequest}
            onStateChange={(nextState, error) => {
              setState(nextState);
              setRuntimeError(error);
            }}
          />
        </div>
      ) : (
        <div className={styles.characterPlaceholder} role="img" aria-label="角色素材待授权">
          <span>R</span>
          <small>CHARACTER ASSET PENDING LICENSE</small>
        </div>
      )}
      <div className={styles.characterCaption}>
        <strong>{record?.name || 'Reverie'}</strong>
        <span>
          {canRender
            ? state === 'mounted'
              ? '在你身边 · 点击角色会挥手'
              : state === 'error'
                ? `角色加载失败：${runtimeError || '未知错误'}`
                : '正在准备角色…'
            : '静态模式 · Live2D 资源或发布许可尚未就绪'}
        </span>
      </div>
    </section>
  );
}
