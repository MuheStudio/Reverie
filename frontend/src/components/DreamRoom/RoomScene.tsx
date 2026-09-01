import { BookOpen, Smartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import balloon from '@/assets/dreamroom/balloon.svg';
import inkCalm from '@/assets/dreamroom/ink-calm.svg';
import inkRain from '@/assets/dreamroom/ink-rain.svg';
import inkWarm from '@/assets/dreamroom/ink-warm.svg';
import paperGrain from '@/assets/dreamroom/paper-grain.svg';
import plushToys from '@/assets/dreamroom/plush-toys.svg';
import rug from '@/assets/dreamroom/rug.svg';
import starLantern from '@/assets/dreamroom/star-lantern.svg';
import starWire from '@/assets/dreamroom/star-wire.svg';
import CharacterStage from './CharacterStage';
import { type CharacterActivity } from './avatarContracts';
import { type RoomAtmosphere } from './roomState';
import styles from './RoomScene.module.scss';

// Star lanterns hang along the sagging wire (viewBox 400x74, quadratic
// through (0,10) (200,64) (400,10)); positions below are points on that curve
// at t = 0.1 / 0.3 / 0.5 / 0.7 / 0.9, converted to container percentages.
const STAR_POSITIONS = [
  { left: '10%', top: '26%', delay: '0s', duration: '3.1s' },
  { left: '30%', top: '44%', delay: '0.9s', duration: '2.7s' },
  { left: '50%', top: '50%', delay: '1.8s', duration: '3.6s' },
  { left: '70%', top: '44%', delay: '0.5s', duration: '2.9s' },
  { left: '90%', top: '26%', delay: '1.3s', duration: '3.3s' },
] as const;

interface RoomSceneProps {
  mood: RoomAtmosphere;
  personaName: string;
  identityLine: string;
  activity: CharacterActivity;
  speaking?: boolean;
  mouthLevel?: number;
  diaryWriting: boolean;
  phoneAttention: boolean;
  bookPage: number;
  bookTotal: number;
  companionWeather: 'none' | 'rain' | 'wind';
}

function moodPattern(mood: RoomAtmosphere): 'calm' | 'warm' | 'rain' {
  const emotion = mood.dominantEmotion.toLowerCase();
  if (['sad', 'fear', 'anxiety', 'lonely'].some((value) => emotion.includes(value))) return 'rain';
  if (['joy', 'happy', 'love', 'excited'].some((value) => emotion.includes(value))) return 'warm';
  return 'calm';
}

export default function RoomScene({
  mood,
  personaName,
  identityLine,
  activity,
  speaking = false,
  mouthLevel,
  diaryWriting,
  phoneAttention,
  bookPage,
  bookTotal,
  companionWeather,
}: RoomSceneProps) {
  const { t } = useTranslation();
  const pattern = moodPattern(mood);
  return (
    <section
      className={styles.scene}
      data-environment-state={mood.backgroundClass}
      data-character-activity={activity}
      data-companion-weather={companionWeather}
      aria-label={t('dream.roomLabel', { name: personaName })}
      data-module="room-scene"
    >
      <div className={styles.atmosphere} aria-hidden="true">
        <img src={inkCalm} alt="" data-visible={pattern === 'calm'} />
        <img src={inkWarm} alt="" data-visible={pattern === 'warm'} />
        <img src={inkRain} alt="" data-visible={pattern === 'rain'} />
        <img className={styles.grain} src={paperGrain} alt="" />
        <span className={styles.rainEffect} />
        <span className={styles.windEffect}><i /><i /><i /></span>
      </div>
      <div className={styles.window} aria-hidden="true">
        <span className={styles.moon} />
        <span className={styles.horizon} />
      </div>
      <div className={styles.shelf} aria-hidden="true">
        <span /><span /><span /><span />
      </div>
      <div className={styles.starLights} aria-hidden="true">
        <img className={styles.starWire} src={starWire} alt="" />
        {STAR_POSITIONS.map((star) => (
          <img
            key={star.left}
            className={styles.star}
            src={starLantern}
            alt=""
            style={{
              left: star.left,
              top: star.top,
              animationDelay: star.delay,
              animationDuration: star.duration,
            }}
          />
        ))}
      </div>
      <img className={`${styles.balloon} ${styles.balloonA}`} src={balloon} alt="" aria-hidden="true" />
      <img className={`${styles.balloon} ${styles.balloonB}`} src={balloon} alt="" aria-hidden="true" />
      <div className={styles.baseboard} aria-hidden="true" />
      <img className={styles.rug} src={rug} alt="" aria-hidden="true" />
      <img className={styles.plushToys} src={plushToys} alt="" aria-hidden="true" />
      <div className={styles.desk} aria-hidden="true">
        <span className={styles.lamp} />
        <span className={styles.book} data-writing={diaryWriting}>
          <BookOpen size={26} />
          <small>{bookPage}/{bookTotal}</small>
        </span>
        <span className={styles.phone} data-attention={phoneAttention}>
          <Smartphone size={24} />
        </span>
      </div>
      <CharacterStage
        personaName={personaName}
        identityLine={identityLine}
        activity={activity}
        speaking={speaking}
        mouthLevel={mouthLevel}
      />
    </section>
  );
}
