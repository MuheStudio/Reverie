import { useCallback, useEffect, useMemo, useState } from 'react';
import { Flame, Headphones, Pause, Play, Plus, RotateCcw, Trash2, Volume2, VolumeX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFocusSession } from './useFocusSession';
import { useFocusSoundscape, type Soundscape } from './useFocusSoundscape';
import styles from './FocusPanel.module.scss';

interface FocusPanelProps {
  onCompleted: (id: string, content: string) => void;
  onActivityChange?: (active: boolean) => void;
  generationInFlight?: boolean;
  onCancelGeneration?: () => void;
  onAtmosphereChange?: (weather: 'none' | 'rain' | 'wind') => void;
}

const PRESETS = [25, 45, 60] as const;
function formatRemaining(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

export default function FocusPanel({
  onCompleted,
  onActivityChange,
  generationInFlight = false,
  onCancelGeneration,
  onAtmosphereChange,
}: FocusPanelProps) {
  const { t } = useTranslation();
  const [customMinutes, setCustomMinutes] = useState(25);
  const handleCompleted = useCallback((id: string, seconds: number) => {
    const minutes = Math.max(1, Math.round(seconds / 60));
    onCompleted(id, t('dream.focusCompletionMessage', { count: minutes }));
    onActivityChange?.(false);
  }, [onActivityChange, onCompleted, t]);
  const focus = useFocusSession(handleCompleted);
  const running = focus.state.phase === 'running';
  const active = running
    || focus.state.phase === 'paused'
    || focus.state.phase === 'starting';
  const audio = useFocusSoundscape(
    running,
    focus.state.id,
    focus.state.requiresAudioRearm === true,
  );
  const phaseLabel = useMemo(() => ({
    idle: t('dream.focusReady'),
    starting: t('dream.focusRunning'),
    running: t('dream.focusRunning'),
    paused: t('dream.focusPaused'),
    completed: t('dream.focusCompleted'),
    stopped: t('dream.focusReady'),
  }[focus.state.phase]), [focus.state.phase, t]);
  const soundLabels: Record<Soundscape, string> = {
    rain: t('dream.soundRain'),
    wind: t('dream.soundWind'),
    fire: t('dream.soundFire'),
    library: t('dream.soundLibrary'),
    pink: t('dream.soundPink'),
  };

  useEffect(() => {
    const weather = running && audio.playing && (audio.sound === 'rain' || audio.sound === 'wind')
      ? audio.sound
      : 'none';
    onAtmosphereChange?.(weather);
    return () => onAtmosphereChange?.('none');
  }, [audio.playing, audio.sound, onAtmosphereChange, running]);

  useEffect(() => {
    onActivityChange?.(active);
  }, [active, onActivityChange]);

  const start = (minutes: number) => {
    if (generationInFlight && !window.confirm(t('dream.focusGenerationWarning'))) return;
    if (generationInFlight) onCancelGeneration?.();
    const audioReady = audio.autoStart ? audio.arm() : null;
    void focus.start(minutes).then((ok) => {
      if (!ok) return;
      if (audioReady) {
        void audioReady.then((ready) => {
          if (ready) void audio.startForSession();
        });
      }
    });
  };

  const resume = () => {
    const audioReady = audio.autoStart ? audio.arm() : null;
    void focus.resume().then((ok) => {
      if (ok && audioReady) {
        void audioReady.then((ready) => {
          if (ready) void audio.startForSession();
        });
      }
    });
  };

  return (
    <section
      className={styles.focus}
      aria-labelledby="focus-title"
      data-focus-phase={focus.state.phase}
      data-sound-playing={audio.playing ? 'true' : 'false'}
    >
      <header>
        <div>
          <span><Flame size={16} /> {t('dream.focusLocal')}</span>
          <h2 id="focus-title">{t('dream.focusTitle')}</h2>
        </div>
        <small>{phaseLabel}</small>
      </header>

      <div
        className={styles.timer}
        role="timer"
        data-testid="companion-timer"
        aria-label={t('dream.focusRemaining', { time: formatRemaining(focus.displayRemaining) })}
      >
        {formatRemaining(focus.displayRemaining)}
      </div>

      {!active ? (
        <>
          <div className={styles.presets} aria-label={t('dream.focusDuration')}>
            {PRESETS.map((minutes) => (
              <button
                key={minutes}
                type="button"
                // Presets fill the picker instead of starting on their own:
                // an accidental click must not launch a 60-minute session,
                // and the user keeps full control through the picker + Start.
                data-preset-active={customMinutes === minutes ? 'true' : 'false'}
                disabled={!focus.available || focus.busy}
                onClick={() => setCustomMinutes(minutes)}
              >
                {t('dream.minutes', { count: minutes })}
              </button>
            ))}
          </div>
          <label className={styles.custom}>
            <span>{t('dream.customMinutes')}</span>
            <input
              type="number"
              data-testid="companion-duration"
              min={1}
              max={180}
              value={customMinutes}
              onChange={(event) => setCustomMinutes(Math.min(180, Math.max(1, Number(event.target.value) || 1)))}
            />
            <button
              type="button"
              data-testid="companion-start"
              disabled={!focus.available || focus.busy}
              onClick={() => start(customMinutes)}
            >
              <Play size={16} /> {t('dream.start')}
            </button>
          </label>
        </>
      ) : (
        <div className={styles.sessionActions}>
          {running ? (
            <button type="button" disabled={focus.busy} onClick={() => void focus.pause()}>
              <Pause size={16} /> {t('dream.pause')}
            </button>
          ) : (
            <button type="button" disabled={focus.busy} onClick={resume}>
              <Play size={16} /> {t('dream.resume')}
            </button>
          )}
          <button
            type="button"
            data-testid="companion-stop"
            disabled={focus.busy}
            onClick={() => void focus.stop()}
          >
            <RotateCcw size={16} /> {t('dream.stop')}
          </button>
        </div>
      )}

      <fieldset className={styles.soundscape}>
        <legend><Headphones size={15} /> {t('dream.soundscape')}</legend>
        <select
          value={audio.sound}
          onChange={(event) => audio.setSound(event.target.value as Soundscape)}
          aria-label={t('dream.soundscapeType')}
        >
          {Object.entries(soundLabels).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
          {audio.customSounds.map((record) => (
            <option key={record.id} value={`custom:${record.id}`}>{record.name}</option>
          ))}
        </select>
        <button type="button" onClick={() => void audio.importSound()}>
          <Plus size={15} /> {t('dream.soundImport')}
        </button>
        {audio.sound.startsWith('custom:') && (
          <button
            type="button"
            onClick={() => void audio.removeSound(audio.sound.slice('custom:'.length))}
          >
            <Trash2 size={15} /> {t('dream.soundRemove')}
          </button>
        )}
        <button
          type="button"
          data-testid="companion-sound-toggle"
          onClick={() => void audio.toggle()}
          aria-pressed={audio.playing}
          title={t('dream.soundManualStart')}
        >
          {audio.playing ? <Volume2 size={17} /> : <VolumeX size={17} />}
          {audio.playing ? t('dream.soundOff') : t('dream.soundOn')}
        </button>
        <label className={styles.autoStart}>
          <input
            type="checkbox"
            checked={audio.autoStart}
            onChange={(event) => audio.setAutoStart(event.target.checked)}
          />
          <span>{t('dream.soundAutoStart')}</span>
        </label>
        <label>
          <span>{t('dream.volume', { value: Math.round(audio.volume * 100) })}</span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(audio.volume * 100)}
            onChange={(event) => audio.setVolume(Number(event.target.value) / 100)}
          />
        </label>
      </fieldset>

      <p className={styles.notice}>
        {t('dream.focusDisclosure')}
        {' '}{t('dream.focusExitWarning')}
      </p>
      {!focus.available && (
        <p className={styles.error} role="status">{t('dream.focusNoBrowserFallback')}</p>
      )}
      {(focus.error || audio.error) && <p className={styles.error} role="alert">{focus.error || audio.error}</p>}
    </section>
  );
}
