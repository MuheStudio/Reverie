import { lazy, Suspense, useEffect, useState } from 'react';
import type { ArchiveClient } from '../DreamRoom/archiveClient';
import type { PhoneAppPanelId } from '../DreamRoom/roomState';
import type { MainSection } from './Workspace';
import ModelManager from './ModelManager';
import styles from './Workspace.module.scss';

const Archive = lazy(() => import('../DreamRoom/ArchivePanels').then(m => ({ default: m.ArchiveManagerPanel })));
const Memory = lazy(() => import('../DreamRoom/ArchivePanels').then(m => ({ default: m.MemorySettingsPanel })));
const Backup = lazy(() => import('../DreamRoom/ArchivePanels').then(m => ({ default: m.BackupPanel })));
const Profile = lazy(() => import('../DreamRoom/ArchivePanels').then(m => ({ default: m.UserProfilePanel })));
const Game = lazy(() => import('../DreamRoom/MiniGamePanel'));
const games: Array<{ id: PhoneAppPanelId; name: string }> = [
  { id: 'xiangqi', name: '中国象棋' }, { id: 'chess', name: '国际象棋' }, { id: 'gomoku', name: '五子棋' },
  { id: 'go', name: '围棋' }, { id: 'tetris', name: '俄罗斯方块' }, { id: 'snake', name: '贪吃蛇' },
];
type Feature = 'models' | 'archive' | 'profile' | 'worldBook' | 'memory' | 'backup';
export default function FeaturePages({ section, client, onInviteAI }: {
  section: MainSection; client: ArchiveClient; onInviteAI(game: PhoneAppPanelId, stateLine?: string): void;
}) {
  const [character, setCharacter] = useState<Feature>('models');
  const [memory, setMemory] = useState<Feature>('worldBook');
  const [game, setGame] = useState<PhoneAppPanelId | null>(null);
  const [visited, setVisited] = useState(new Set<Feature>(['models']));
  const feature = section === 'character' ? character : memory;
  useEffect(() => {
    if (section === 'character' || section === 'memory') setVisited(current => current.has(feature) ? current : new Set([...current, feature]));
  }, [section, feature]);
  const select = (value: Feature) => {
    setVisited(current => new Set([...current, value]));
    if (section === 'character') setCharacter(value); else setMemory(value);
  };
  const links: Array<[Feature, string]> = section === 'character'
    ? [['models', '模型'], ['archive', '人格与角色卡'], ['profile', '我的资料']]
    : [['worldBook', '世界书'], ['memory', '记忆设置与摘要'], ['backup', '备份与导入导出']];
  return <div className={styles.feature} data-testid="feature-pages">
    {section !== 'activities' && <nav className={styles.tabs} aria-label="资料子页面">
      {links.map(([id, label]) => <button key={id} type="button" aria-current={feature === id ? 'page' : undefined} onClick={() => select(id)}>{label}</button>)}
    </nav>}
    <Suspense fallback={<p role="status">正在加载功能…</p>}>
      <div hidden={section !== 'character' || feature !== 'models'}><ModelManager /></div>
      {(['archive','worldBook','memory','backup','profile'] as const).filter(id => visited.has(id) || section === 'memory' && id === 'worldBook').map(id => {
        const visible = (section === 'character' || section === 'memory') && feature === id;
        const ws = { ...client, viewActive: visible };
        return <div key={id} hidden={!visible}>
          {id === 'archive' && <Archive ws={ws} />}
          {id === 'worldBook' && <Archive ws={ws} initialTab="worldBook" />}
          {id === 'memory' && <Memory ws={ws} />}
          {id === 'backup' && <Backup ws={ws} />}
          {id === 'profile' && <Profile ws={ws} />}
        </div>;
      })}
      <div hidden={section !== 'activities'}>
        <h2>一起玩一会儿</h2><p>棋谱保存在当前人格的本机加密档案中。练习模式使用内置陪练。</p>
        <div className={styles.tabs} aria-label="小游戏">{games.map(item => <button type="button" key={item.id} aria-current={game === item.id ? 'page' : undefined} onClick={() => setGame(item.id)}>{item.name}</button>)}</div>
        {game && <Game key={`${client.personaScope?.persona_id}:${game}`} game={game} connected={client.connState === 'connected'} gameStateClient={client} onInviteAI={onInviteAI} active={section === 'activities'} />}
      </div>
    </Suspense>
  </div>;
}
