import type { ReactNode } from 'react';
import { MessageCircle, UserRound, BookOpen, Shapes, Settings2 } from 'lucide-react';
import styles from './Workspace.module.scss';
import { ModelVisibility } from './modelVisibility';

export type MainSection = 'chat' | 'character' | 'memory' | 'activities' | 'settings';
export const sections = [
  { id: 'chat', label: '陪伴 / 聊天', icon: MessageCircle, subtitle: '此刻，在你身边' },
  { id: 'character', label: '角色与模型', icon: UserRound, subtitle: '认识她，也选择她的形象' },
  { id: 'memory', label: '记忆与资料', icon: BookOpen, subtitle: '把共同经历慢慢收好' },
  { id: 'activities', label: '活动', icon: Shapes, subtitle: '一起做点喜欢的事' },
  { id: 'settings', label: '设置与关于', icon: Settings2, subtitle: '按你的习惯安排' },
] as const;

export default function Workspace({ section, onNavigate, name, connected, notice, children }: {
  section: MainSection; onNavigate(section: MainSection): void; name: string;
  connected: boolean; notice?: string; children: ReactNode;
}) {
  const current = sections.find(item => item.id === section)!;
  return <div className={styles.workspace} data-testid="workspace" data-section={section}>
    <header className={styles.titlebar}><span>REVERIE</span><span>幻梦 · 本地陪伴</span></header>
    <aside className={styles.sidebar}>
      <div className={styles.brand}><span>R</span><div><strong>Reverie</strong><small>留一点时间给彼此</small></div></div>
      <nav aria-label="主要功能">
        {sections.map(({ id, label, icon: Icon }) => <button key={id} type="button" data-nav={id}
          aria-label={label} title={label} aria-current={section === id ? 'page' : undefined} onClick={() => onNavigate(id)}>
          <Icon size={19} /><span>{label}</span>
        </button>)}
      </nav>
      <div className={styles.session}><span data-ready={connected} /><div><strong>{name}</strong><small>{connected ? '本地服务已连接' : '正在连接本地服务'}</small></div></div>
    </aside>
    <div className={styles.content}>
      <header className={styles.pageHeader}><div><small>{current.subtitle}</small><h1>{current.label.replace(' / ', '与')}</h1></div><span className={styles.local}>本地优先</span></header>
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      <div className={styles.surface}><ModelVisibility.Provider value={section === 'chat' || section === 'character'}>{children}</ModelVisibility.Provider></div>
    </div>
  </div>;
}
