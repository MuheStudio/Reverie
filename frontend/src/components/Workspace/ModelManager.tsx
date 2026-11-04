import { lazy, Suspense, useEffect, useState } from 'react';
import styles from './Workspace.module.scss';
const ImportModel = lazy(() => import('../Onboarding/OptionalMediaStep'));
export default function ModelManager() {
  const [models, setModels] = useState<AvatarListResult>({ records: [], activeId: null });
  const [notice, setNotice] = useState('正在读取本机模型…');
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    const api = window.electronAPI?.avatar;
    const apply = (value: AvatarListResult) => { if (alive) { setModels(value); setNotice(''); } };
    const dispose = api?.onChanged(apply);
    void api?.list().then(apply).catch(() => { if (alive) setNotice('模型列表暂时不可用，请稍后重试。'); });
    return () => { alive = false; dispose?.(); };
  }, []);
  const choose = async (id: string) => {
    setBusy(true);
    try { await window.electronAPI?.avatar?.setActive(id); setNotice('已切换全局形象。'); }
    catch (error) { setNotice(error instanceof Error ? error.message : '模型切换失败，原选择保留。'); }
    finally { setBusy(false); }
  };
  const available = models.runtime?.live2d?.available === true;
  return <section className={styles.feature} data-testid="model-manager">
    <h2>你的陪伴形象</h2><p>模型是全应用共用的形象；更换人格或角色卡不会自动换模型。</p>
    {!available && <p role="status" data-testid="model-unavailable">当前环境未提供可用的 Live2D 运行时，真实模型暂不能显示。聊天与其他功能可继续使用。{models.runtime?.live2d?.reason ? `（${models.runtime.live2d.reason}）` : ''}</p>}
    <div className={styles.models}>{models.records.map(model => <article key={model.id}>
      <div><strong>{model.name}</strong><p>{model.id === models.activeId ? '当前形象' : '已保存在本机'} · {model.status === 'ready' ? '资源就绪' : model.status}</p></div>
      <button type="button" disabled={busy || model.id === models.activeId || model.status !== 'ready'} onClick={() => { void choose(model.id); }}>使用此模型</button>
    </article>)}</div>
    {!models.records.length && <p>还没有导入模型。你可以先聊天，之后再添加自己的形象。</p>}
    <button type="button" data-testid="model-import-open" onClick={() => setImportOpen(value => !value)}>{importOpen ? '收起导入' : '导入模型与可选语音'}</button>
    {importOpen && <Suspense fallback={<p>正在准备导入界面…</p>}><ImportModel /></Suspense>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
