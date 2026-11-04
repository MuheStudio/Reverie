import license from '../../../../LICENSE?raw';
import notice from '../../../../NOTICE?raw';
import credits from '../../../../CREDITS.md?raw';
export default function About() {
  return <section aria-label="关于与开源许可">
    <h2>关于 Reverie</h2><p>幻梦 · 本地优先的数字人格陪伴</p>
    <p>当前为本地测试版本。宿主许可仍为 GPLv3；Apache-2.0／MIT 迁移尚未正式执行。</p>
    {[['宿主许可证',license],['第三方通知',notice],['来源与致谢',credits]].map(([title,text]) => <details key={title}><summary>{title}</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12,lineHeight:1.6}}>{text}</pre></details>)}
    <p>Live2D Core、模型与声音的适用条件单独处理，本地测试签名不代表正式分发。</p>
  </section>;
}
