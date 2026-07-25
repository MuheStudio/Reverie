import { BookOpen, Smartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import inkCalm from '@/assets/dreamroom/ink-calm.svg';
import inkRain from '@/assets/dreamroom/ink-rain.svg';
import inkWarm from '@/assets/dreamroom/ink-warm.svg';
import paperGrain from '@/assets/dreamroom/paper-grain.svg';
import CharacterStage from './CharacterStage';
import { type CharacterActivity } from './avatarContracts';
import { type RoomAtmosphere } from './roomState';
import styles from './RoomScene.module.scss';

interface RoomSceneProps {
  mood: RoomAtmosphere;
  personaName: string;
  identityLine: string;
  activity: CharacterActivity;
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
      />
    </section>
  );
}
