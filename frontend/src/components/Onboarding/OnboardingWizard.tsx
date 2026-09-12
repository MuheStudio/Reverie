import { useEffect, useRef, useState } from 'react';
import { requestWindowsBrowserLocation } from '@/lib/windowsGeolocation';
import {
  ONBOARDING_STEPS,
  ONBOARDING_VERSION,
  canContinue,
  initialOnboardingStep,
  moveStep,
  stepIndex,
  type ExperienceMode,
  type OnboardingDraft,
  type OnboardingStep,
  type ProviderPreset,
} from './onboardingState';
import styles from './OnboardingWizard.module.scss';
import OptionalMediaStep from './OptionalMediaStep';

const DEEPSEEK_URL = 'https://api.deepseek.com';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';

// 开向导外链必须带 target="_blank"：主进程只放行 window-open 通道上的
// https 链接（转交系统浏览器），主窗口导航本身始终锁定。
const DEEPSEEK_LINKS = [
  { href: 'https://platform.deepseek.com/', label: '官方平台' },
  { href: 'https://platform.deepseek.com/api_keys', label: 'API Key' },
  { href: 'https://platform.deepseek.com/top_up', label: '充值' },
  { href: 'https://api-docs.deepseek.com/', label: '官方文档' },
];
const AMAP_KEY_URL = 'https://console.amap.com/dev/key/app';
const GOOGLE_KEY_URL = 'https://console.cloud.google.com/apis/credentials';

const STEP_LABELS: Record<OnboardingStep, string> = {
  welcome: '欢迎', mode: '体验模式', profile: '年龄与称呼', deepseek: 'AI 服务',
  'optional-media': '形象与语音', features: '功能导览', rooms: '房间导览',
  cards: '角色卡与世界书', location: '位置与地图', pet: '桌面宠物', finish: '完成',
};
const CHUB_URL = 'https://chub.ai/';
const WEB_SURFING_DISCLAIMER = '因用户所设置的‘网络冲浪系统’而引发的一系列问题由用户自行承担，与本项目及本项目的所有者将不承担任何责任。';

type Props = {
  initialUi: Record<string, unknown> | null;
  initialProfile: Record<string, unknown> | null;
  hostReady?: boolean;
  updateSettings: (payload: Record<string, unknown>) => unknown;
  completeOnboarding: (
    profile: Record<string, unknown>,
    finalFields: { onboarding_version: number; onboarding_last_step: string; experience_mode: ExperienceMode },
    searchConsent?: { nativeSearch: boolean; keylessSearch: boolean },
  ) => Promise<boolean>;
  importCharacterCard?: (file: File) => Promise<string>;
  importWorldBook?: (file: File) => Promise<string>;
  onCompleted?: (result: { experienceMode: ExperienceMode }) => void;
};

function stringValue(value: unknown): string { return typeof value === 'string' ? value : ''; }
function numberValue(value: unknown): number { return typeof value === 'number' ? value : 18; }

export default function OnboardingWizard({
  initialUi, initialProfile, hostReady = true, updateSettings, completeOnboarding, importCharacterCard, importWorldBook, onCompleted,
}: Props) {
  const savedMode = initialUi?.experience_mode === 'core' ? 'core' : 'full';
  const [draft, setDraft] = useState<OnboardingDraft>({
    step: initialOnboardingStep(
      initialUi?.onboarding_last_step,
      initialUi?.onboarding_version,
      initialUi?.onboarding_completed,
    ),
    experienceMode: savedMode,
    age: numberValue(initialProfile?.age),
    nickname: stringValue(initialProfile?.nickname),
    adultConfirmed: false,
    aiConfirmed: false,
    profileAccepted: initialUi?.onboarding_state === 'committing'
      && numberValue(initialProfile?.age) >= 18,
    providerCommitted: false,
    live2dInstalled: false,
  });
  const [providerPreset, setProviderPreset] = useState<ProviderPreset>('deepseek');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(DEEPSEEK_MODEL);
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [providerStatus, setProviderStatus] = useState('请输入 API Key，然后先测试连接。');
  const [tested, setTested] = useState<{ key: string; receipt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [placesStatus, setPlacesStatus] = useState('尚未检查地图密钥。');
  const [locationStatus, setLocationStatus] = useState('定位默认关闭，只有点击测试时才会请求 Windows 权限。');
  const [placeProvider, setPlaceProvider] = useState<'amap' | 'google'>('amap');
  const [placeKey, setPlaceKey] = useState('');
  const [petEnabled, setPetEnabled] = useState(false);
  const [finishStatus, setFinishStatus] = useState('');
  const [nativeSearch, setNativeSearch] = useState(false);
  const [keylessSearch, setKeylessSearch] = useState(false);
  const [cardStatus, setCardStatus] = useState('可跳过。出厂是星野幻月，你是星野白夜；之后都能换。');
  const titleRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  const [hostDownSeconds, setHostDownSeconds] = useState(0);

  useEffect(() => {
    if (hostReady) {
      setHostDownSeconds(0);
      return undefined;
    }
    const interval = window.setInterval(() => {
      setHostDownSeconds((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [hostReady]);

  const activeProvider = providerPreset === 'deepseek' ? 'deepseek' : 'openai';
  const activeBaseUrl = providerPreset === 'deepseek' ? DEEPSEEK_URL : customBaseUrl.trim();
  const providerReady = providerPreset === 'deepseek'
    || (customBaseUrl.trim().startsWith('https://') || customBaseUrl.trim().startsWith('http://'));

  useEffect(() => { titleRef.current?.focus(); }, [draft.step]);

  useEffect(() => {
    let active = true;
    const config = window.electronAPI?.providerConfig?.get?.();
    const credentials = window.electronAPI?.credentials?.status?.();
    if (config && credentials) {
      void Promise.all([config, credentials]).then(([value, status]) => {
        if (!active || !value?.llm) return;
        const provider = value.llm.provider;
        const baseUrl = typeof value.llm.baseUrl === 'string' ? value.llm.baseUrl : '';
        if (provider === 'deepseek') {
          setProviderPreset('deepseek');
          setModel(typeof value.llm.model === 'string' && value.llm.model ? value.llm.model : DEEPSEEK_MODEL);
        } else if (provider === 'openai' && baseUrl) {
          setProviderPreset('custom');
          setCustomBaseUrl(baseUrl);
          setModel(typeof value.llm.model === 'string' && value.llm.model ? value.llm.model : '');
        } else {
          return;
        }
        if (status?.llm?.hasApiKey && status.llm.sessionOnly !== true && status.persistentAvailable !== false) {
          setDraft((current) => ({ ...current, providerCommitted: true }));
          setProviderStatus('检测到已由 Windows 加密存储保存的 AI 配置；可直接继续，或输入新密钥重新测试并保存。');
        }
      }).catch(() => undefined);
    }
    void window.electronAPI?.pet?.isVisible?.().then((visible) => {
      if (active) setPetEnabled(visible);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (draft.step !== 'location') return;
    void window.electronAPI?.places?.status?.().then((status) => {
      const configured = [status.configured.amap && '高德', status.configured.google && 'Google'].filter(Boolean);
      setPlacesStatus(configured.length ? `已配置：${configured.join('、')}。` : '未配置地图密钥；可跳过，稍后再设置。');
    }).catch(() => setPlacesStatus('暂时无法读取地图配置；可跳过。'));
  }, [draft.step]);

  const persistProgress = (step: OnboardingStep, mode = draft.experienceMode) => {
    if (step === 'finish') return;
    updateSettings({
      section: 'onboarding',
      onboarding_version: ONBOARDING_VERSION,
      onboarding_state: 'in_progress',
      onboarding_last_step: step,
      experience_mode: mode,
    });
  };

  const go = (direction: 1 | -1) => {
    const step = moveStep(draft.step, direction);
    setDraft((current) => ({
      ...current,
      step,
      profileAccepted: current.profileAccepted || (current.step === 'profile' && canContinue(current)),
    }));
    if (step !== 'finish') persistProgress(step);
  };

  const keepFocusInside = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) || []);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const testProvider = async () => {
    const api = window.electronAPI?.providerConfig;
    if (!api?.test || !apiKey.trim() || !model.trim() || !providerReady) return;
    setBusy(true);
    setTested(null);
    setDraft((current) => ({ ...current, providerCommitted: false }));
    setProviderStatus('正在测试 AI 服务连接…');
    const key = JSON.stringify({ apiKey, model, baseUrl: activeBaseUrl });
    try {
      const result = await api.test(
        { llm: { provider: activeProvider, baseUrl: activeBaseUrl, model: model.trim() } },
        { apiKey },
      );
      if (result.ok) {
        setTested({ key, receipt: result.receipt });
        setProviderStatus(`连接成功（${result.latencyMs}ms）。请保存到 Windows 加密存储。`);
      } else setProviderStatus(`测试失败：${result.message}`);
    } catch (error) {
      setProviderStatus(`测试失败：${error instanceof Error ? error.message : '本地服务未响应。'}`);
    } finally { setBusy(false); }
  };

  const commitProvider = async () => {
    const api = window.electronAPI?.providerConfig;
    const key = JSON.stringify({ apiKey, model, baseUrl: activeBaseUrl });
    if (!api?.commit || tested?.key !== key) return;
    setBusy(true);
    setProviderStatus('正在通过 DPAPI 事务安全保存…');
    try {
      const result = await api.commit(
        { llm: { provider: activeProvider, baseUrl: activeBaseUrl, model: model.trim() } },
        { apiKey },
        'persistent',
        tested.receipt,
      );
      if (result.status.writeError || result.status.persistentAvailable === false) {
        setProviderStatus(`保存失败：${result.status.writeError?.message || '当前系统无法使用 Windows 加密存储。'}`);
        return;
      }
      setApiKey('');
      setTested(null);
      setDraft((current) => ({ ...current, providerCommitted: true }));
      setProviderStatus(result.status.runtimePending || result.status.runtimeApplied === false
        ? '已由 Windows DPAPI 加密保存；本地服务仍在同步，两个房间会自动使用新配置。'
        : '已由 Windows DPAPI 加密保存并应用到两个房间。');
    } catch (error) {
      setProviderStatus(`保存失败：${error instanceof Error ? error.message : '本地服务拒绝了提交。'}`);
    } finally { setBusy(false); }
  };

  const savePlaceKey = async () => {
    if (!placeKey.trim() || !window.electronAPI?.places?.setKey) return;
    setBusy(true);
    try {
      const result = await window.electronAPI.places.setKey(placeProvider, placeKey);
      setPlaceKey('');
      setPlacesStatus(result.configured ? '地图密钥已保存到系统安全存储。' : '地图密钥未能保存。');
    } catch { setPlacesStatus('地图密钥保存失败；可以跳过并稍后重试。'); }
    finally { setBusy(false); }
  };

  const testLocation = async () => {
    setBusy(true);
    setLocationStatus('正在请求一次 Windows 定位权限…');
    try {
      const result = await requestWindowsBrowserLocation();
      if (result.ok) {
        setLocationStatus(`系统定位可用，当前精度约 ${Math.round(result.accuracy)} 米。坐标不会由本向导保存。`);
      } else {
        const reasons: Record<string, string> = {
          REVERIE_LOCATION_PERMISSION_DENIED: '你拒绝了定位权限，可稍后在 Windows 设置中重新允许。',
          REVERIE_LOCATION_DEVICE_UNAVAILABLE: 'Windows 暂时无法提供位置，可能是系统定位服务关闭或设备不可用。',
          REVERIE_LOCATION_TIMEOUT: '定位请求超时，请检查系统定位服务后重试。',
          REVERIE_LOCATION_NATIVE_FAILURE: '定位返回了无效结果，请重启应用或报告此原因。',
        };
        setLocationStatus(reasons[result.code] || '定位不可用。');
      }
    } catch (error) {
      setLocationStatus(`定位测试失败：${error instanceof Error ? error.message : '系统定位接口未响应。'}`);
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (!canContinue(draft)) return;
    setBusy(true);
    setFinishStatus('正在保存个人资料并完成引导…');
    const ok = await completeOnboarding({
      name: '', nickname: draft.nickname.trim(), age: draft.age, birthday: '', identity: '', schedule: '',
      interests: [], hobbies: [], favorite_topics: [], favorite_games: [], favorite_anime: [], important_dates: {},
    }, {
      onboarding_version: ONBOARDING_VERSION,
      onboarding_last_step: 'finish',
      experience_mode: draft.experienceMode,
    }, {
      nativeSearch,
      keylessSearch,
    });
    setBusy(false);
    if (ok) onCompleted?.({ experienceMode: draft.experienceMode });
    else setFinishStatus('资料或完成标记未完整保存。请重试，并报告界面显示的原因。');
  };

  const setMode = (mode: ExperienceMode) => {
    setDraft((current) => ({ ...current, experienceMode: mode }));
    persistProgress(draft.step, mode);
  };

  const selectPreset = (preset: ProviderPreset) => {
    setProviderPreset(preset);
    setTested(null);
    setDraft((current) => ({ ...current, providerCommitted: false }));
    if (preset === 'deepseek') {
      setModel(DEEPSEEK_MODEL);
      setProviderStatus('请输入 API Key，然后先测试连接。');
    } else {
      setProviderStatus('填写 OpenAI 兼容服务地址、模型名与 API Key 后测试。');
    }
  };

  const renderStep = () => {
    switch (draft.step) {
      case 'welcome': return <>
        <p className={styles.eyebrow}>新手引导</p><h1 ref={titleRef} tabIndex={-1}>欢迎来到 Reverie</h1>
        <p className={styles.lead}>这个向导会一次性帮你配好：连接她的 AI 大脑、导入 Live2D 形象（完整模式必做）、认识两个房间。安装包不附带任何 Live2D 角色模型；请选择包含 <code>*.model3.json</code> 的文件夹、直接选该文件，或导入 zip。角色卡只改人设，不会换成另一套 Live2D。你的 API 密钥全程只进 Windows 加密存储。</p>
        <p className={styles.notice}>正常使用无需安装 Bun、Node、Python、Conda 或 FFmpeg，安装包已捆绑运行时。若出现异常运行时错误，请先使用修复/重试并报告界面显示的原因；高级用户也可以手动安装与提示相匹配的环境。</p>
        {!hostReady && <p className={styles.repair} role="status">本地聊天服务还在启动。你可以先走完形象导入；保存 API Key 和点「完成」需要服务恢复。</p>}
      </>;
      case 'mode': return <>
        <p className={styles.eyebrow}>选择起点</p><h2 ref={titleRef} tabIndex={-1}>完整体验或核心体验</h2>
        <div className={styles.choiceGrid}>
          <label className={styles.choice} data-selected={draft.experienceMode === 'full'}><input type="radio" name="mode" checked={draft.experienceMode === 'full'} onChange={() => setMode('full')} /><strong>完整模式（推荐）</strong><span>必须导入一套 Live2D 形象（语音包可选），从“她的房间”开始。全应用共用这一套形象；角色卡不会换皮。</span></label>
          <label className={styles.choice} data-selected={draft.experienceMode === 'core'}><input type="radio" name="mode" checked={draft.experienceMode === 'core'} onChange={() => setMode('core')} /><strong>核心模式</strong><span>只要聊天，可先不导入形象与语音；之后随时可在设置里补齐。</span></label>
        </div>
      </>;
      case 'profile': return <>
        <p className={styles.eyebrow}>使用边界</p><h2 ref={titleRef} tabIndex={-1}>年龄、AI 认知与称呼</h2>
        <p>Reverie 面向 18 岁以上用户。AI 可能出错，不替代现实关系，也不能替代危机、医疗、法律或财务方面的专业支持。</p>
        <label className={styles.field}>年龄<input type="number" min={18} max={120} value={draft.age} onChange={(event) => setDraft((current) => ({ ...current, age: Number(event.target.value) }))} /></label>
        <label className={styles.field}>希望被怎样称呼（可选）<input maxLength={80} value={draft.nickname} onChange={(event) => setDraft((current) => ({ ...current, nickname: event.target.value }))} /></label>
        <label className={styles.check}><input type="checkbox" checked={draft.adultConfirmed} onChange={(event) => setDraft((current) => ({ ...current, adultConfirmed: event.target.checked }))} /><span>我已年满 18 岁。</span></label>
        <label className={styles.check}><input type="checkbox" checked={draft.aiConfirmed} onChange={(event) => setDraft((current) => ({ ...current, aiConfirmed: event.target.checked }))} /><span>我理解这是 AI 角色，可能出错，也不会替代现实支持。</span></label>
      </>;
      case 'deepseek': return <>
        <p className={styles.eyebrow}>必需配置</p><h2 ref={titleRef} tabIndex={-1}>连接她的 AI 大脑</h2>
        <p>推荐使用 DeepSeek（注册即送额度，国内直连）。你也可以使用任何 OpenAI 兼容的服务地址。密钥通过 Windows DPAPI 加密保存，MVPRoom 与 DreamRoom 会自动同步。</p>
        <div className={styles.choiceGrid}>
          <label className={styles.choice} data-selected={providerPreset === 'deepseek'}><input type="radio" name="provider-preset" checked={providerPreset === 'deepseek'} onChange={() => selectPreset('deepseek')} /><strong>DeepSeek（推荐）</strong><span>官方平台购买 API Key，即充即用。</span></label>
          <label className={styles.choice} data-selected={providerPreset === 'custom'}><input type="radio" name="provider-preset" checked={providerPreset === 'custom'} onChange={() => selectPreset('custom')} /><strong>自定义 OpenAI 兼容</strong><span>使用你自己的服务地址与模型（OpenAI 兼容协议）。</span></label>
        </div>
        {providerPreset === 'deepseek'
          ? <div className={styles.links}>{DEEPSEEK_LINKS.map((link) => (
            <a key={link.href} href={link.href} target="_blank" rel="noreferrer">{link.label}</a>
          ))}</div>
          : <p className={styles.notice}>请在你所选服务商的控制台创建 API Key；服务地址需兼容 OpenAI Chat Completions 协议。</p>}
        {providerPreset === 'deepseek'
          ? <label className={styles.field}>服务地址<div className={styles.fixedValue}>{DEEPSEEK_URL}</div></label>
          : <label className={styles.field}>服务地址（OpenAI 兼容）<input value={customBaseUrl} maxLength={512} spellCheck={false} placeholder="https://api.example.com/v1" onChange={(event) => { setCustomBaseUrl(event.target.value); setTested(null); setDraft((current) => ({ ...current, providerCommitted: false })); }} /></label>}
        <label className={styles.field}>模型<input value={model} maxLength={512} spellCheck={false} onChange={(event) => { setModel(event.target.value); setTested(null); setDraft((current) => ({ ...current, providerCommitted: false })); }} /></label>
        <label className={styles.field}>API Key<input type="password" autoComplete="off" maxLength={16_384} value={apiKey} onChange={(event) => { setApiKey(event.target.value); setTested(null); }} /></label>
        <div className={styles.links}><button type="button" disabled={busy || !apiKey.trim() || !model.trim() || !providerReady} onClick={() => void testProvider()}>测试连接</button><button type="button" disabled={busy || tested?.key !== JSON.stringify({ apiKey, model, baseUrl: activeBaseUrl })} onClick={() => void commitProvider()}>用 Windows DPAPI 保存</button></div>
        <p className={styles.status} role="status">{providerStatus}</p>
      </>;
      case 'optional-media': return <>
        <p className={styles.eyebrow}>{draft.experienceMode === 'full' ? '必需配置' : '可稍后配置'}</p>
        <h2 ref={titleRef} tabIndex={-1}>Live2D 与语音</h2>
        {draft.experienceMode === 'core' ? <div className={styles.notice}>
          <strong>核心模式可先不导入形象。</strong>
          <p>Live2D 与 GPT-SoVITS 语音包都不影响聊天。本步骤不会打开文件选择器。之后仍可在设置里导入同一套共用形象——角色卡只改人设，不会换成另一套 Live2D。</p>
        </div> : <>
          <p>安装包按 Live2D Cubism 分发规则<strong>不附带任何角色模型</strong>。完整模式必须导入你自己的 Live2D：选择模型文件夹、直接选 <code>*.model3.json</code>，或导入 zip。全应用只有这一套 Live2D；导入角色卡只会改人设，不会跟卡换皮。</p>
          <OptionalMediaStep onLive2dInstalled={(installed) => {
            setDraft((current) => ({ ...current, live2dInstalled: installed }));
          }} />
        </>}
      </>;
      case 'features': return <>
        <p className={styles.eyebrow}>功能导览</p><h2 ref={titleRef} tabIndex={-1}>她会像真人一样存在</h2>
        <ul>
          <li><strong>表情图片系统</strong> —— 导入你自己的表情包，她会收藏、按情绪使用，还会记住你的偏好。</li>
          <li><strong>主动聊天</strong> —— 她会先开口找你：早晚问候、事件分享、提醒约定；应用在后台时以系统通知送达。</li>
          <li><strong>两个界面</strong> —— MVPRoom 是简洁的聊天主界面；在“设置”里选择“她的房间”，即可进入沉浸的 DreamRoom。</li>
          <li><strong>手机</strong> —— DreamRoom 里的手机集成五子棋、围棋、中国象棋、国际象棋的 AI 陪玩，还有音乐、视频与回忆。</li>
          <li><strong>加密日记</strong> —— 每天由她写下内心独白，加密保存；只有特定时机才能偷看。</li>
          <li><strong>真实与沉浸</strong> —— 授权定位后，她能聊起你附近的真实地点。</li>
        </ul>
        <label className={styles.check}><input type="checkbox" checked={nativeSearch} onChange={(event) => setNativeSearch(event.target.checked)} /><span>默认开启联网搜索：使用 AI 服务自带的搜索能力，无需额外搜索 API；所用服务不支持时自动忽略；“政治/社会热点”类内容始终禁止</span></label>
        <label className={styles.check}><input type="checkbox" checked={keylessSearch} onChange={(event) => setKeylessSearch(event.target.checked)} /><span>开启本地免 Key 搜索：使用无需任何 API 密钥的公共搜索源，她聊到网络话题时会附逐字摘录与来源；只查询安全话题词，不发送你的任何私人信息；“政治/社会热点”类内容始终禁止。勾选即同时开启网络冲浪并同意免责声明，无需稍后在设置里再开一次。</span></label>
        {keylessSearch ? <p className={styles.notice}><strong>免责声明</strong>{WEB_SURFING_DISCLAIMER} 搜索刷新默认在 20:00–23:00，间隔约 3 小时；窗口外她不会现场去搜。</p> : null}
      </>;
      case 'rooms': return <>
        <p className={styles.eyebrow}>界面导览</p><h2 ref={titleRef} tabIndex={-1}>MVPRoom 与 DreamRoom</h2>
        <div className={styles.choiceGrid}><div className={styles.choice}><strong>MVPRoom</strong><span>简洁主界面，集中提供聊天、记忆和设置。</span></div><div className={styles.choice}><strong>DreamRoom</strong><span>“她的房间”沉浸界面，包含手机、日记与表情库。两种界面可在设置中切换。</span></div></div>
      </>;
      case 'cards': return <>
        <p className={styles.eyebrow}>可选导入</p><h2 ref={titleRef} tabIndex={-1}>角色卡与世界书</h2>
        <p>出厂角色是星野幻月，你的档案是星野白夜。两者都可以替换，也可以之后在「她的房间 → 设置 → 档案」里恢复预设。</p>
        <p>推荐从 <a href={CHUB_URL} target="_blank" rel="noreferrer">chub.ai</a> 获取酒馆角色卡和世界书。请下载 PNG/JSON 原文件；微信、论坛压缩过的图会丢掉角色数据。</p>
        <p className={styles.notice}>角色卡决定「她是谁」和世界设定，<strong>不会</strong>更换 Live2D。全应用共用你导入的那一套形象；换卡只换人设。</p>
        <div className={styles.links}>
          <label className={styles.fileButton}>导入角色卡 PNG/JSON
            <input type="file" accept="application/json,.json,image/png,.png" disabled={busy} onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file || !importCharacterCard) return;
              setBusy(true);
              setCardStatus('正在导入角色卡…');
              void importCharacterCard(file).then((message) => setCardStatus(message)).catch((error) => {
                setCardStatus(error instanceof Error ? error.message : '角色卡导入失败，可跳过。');
              }).finally(() => setBusy(false));
            }} />
          </label>
          <label className={styles.fileButton}>导入世界书 JSON
            <input type="file" accept="application/json,.json" disabled={busy} onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file || !importWorldBook) return;
              setBusy(true);
              setCardStatus('正在导入世界书…');
              void importWorldBook(file).then((message) => setCardStatus(message)).catch((error) => {
                setCardStatus(error instanceof Error ? error.message : '世界书导入失败，可跳过。');
              }).finally(() => setBusy(false));
            }} />
          </label>
        </div>
        <p className={styles.status} role="status">{cardStatus}</p>
      </>;
      case 'location': return <>
        <p className={styles.eyebrow}>可选设置</p><h2 ref={titleRef} tabIndex={-1}>位置与地图服务</h2>
        <p>附近地点功能仅在你主动同意并使用时向所选地图提供商发送位置。地图密钥可现在保存，也可以跳过。</p>
        <p>还没有密钥？点击申请（将在系统浏览器打开）：
          {placeProvider === 'amap'
            ? <a href={AMAP_KEY_URL} target="_blank" rel="noreferrer"> 高德开放平台 · 创建 API Key</a>
            : <a href={GOOGLE_KEY_URL} target="_blank" rel="noreferrer"> Google Cloud · API 凭据</a>}
        </p>
        <div><button type="button" disabled={busy} onClick={() => void testLocation()}>测试 Windows 定位</button></div>
        <p className={styles.status} role="status">{locationStatus}</p>
        <label className={styles.field}>地图提供商<select value={placeProvider} onChange={(event) => setPlaceProvider(event.target.value as 'amap' | 'google')}><option value="amap">高德地图</option><option value="google">Google Maps</option></select></label>
        <label className={styles.field}>地图 API Key（可选）<input type="password" autoComplete="off" value={placeKey} onChange={(event) => setPlaceKey(event.target.value)} /></label>
        <div><button type="button" disabled={busy || !placeKey.trim()} onClick={() => void savePlaceKey()}>安全保存地图密钥</button></div>
        <p className={styles.status} role="status">{placesStatus}</p>
      </>;
      case 'pet': return <>
        <p className={styles.eyebrow}>可选功能</p><h2 ref={titleRef} tabIndex={-1}>桌面宠物</h2>
        <p>她可以一直住在你的桌面上：拖着走、在窗口底部直接聊天和发表情，回复会以漫画气泡的方式从她身边冒出来。此选择不会影响聊天、个人资料或已经保存的配置。</p>
        <label className={styles.check}><input type="checkbox" checked={petEnabled} onChange={(event) => { const enabled = event.target.checked; setPetEnabled(enabled); void (enabled ? window.electronAPI?.pet?.show?.() : window.electronAPI?.pet?.hide?.()); }} /><span>显示桌面宠物</span></label>
      </>;
      case 'finish': return <>
        <p className={styles.eyebrow}>准备完成</p><h2 ref={titleRef} tabIndex={-1}>配置摘要</h2>
        <ul><li>体验模式：{draft.experienceMode === 'full' ? '完整模式' : '核心模式'}</li><li>称呼：{draft.nickname.trim() || '未填写'}</li><li>AI 服务：{draft.providerCommitted ? '已安全配置并同步到两个房间' : '尚未保存'}</li><li>Live2D：{draft.live2dInstalled ? '已导入（全应用共用这一套，角色卡不换皮）' : (draft.experienceMode === 'full' ? '尚未导入，完整模式不能完成' : '核心模式可稍后导入')}</li><li>桌面宠物：{petEnabled ? '显示' : '不显示'}</li></ul>
        <p>点击完成后才会保存个人资料并写入完成标记。完整模式会进入“她的房间”；核心模式留在简洁主界面。之后的 AI、界面与宠物设置都可以随时调整。</p>
        {!hostReady && <p className={styles.repair} role="status">本地服务尚未就绪，暂时不能写入完成标记。{hostDownSeconds >= 60 ? '服务超过 60 秒未恢复；你可以强制完成，但 API 配置可能需要重启后生效。' : '请等顶部提示消失后再点完成。'}</p>}
        <p className={styles.status} role="status">{finishStatus}</p>
      </>;
    }
  };

  return <div className={styles.backdrop}>
    <section ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-label="Reverie 新手引导" onKeyDown={keepFocusInside}>
      <aside className={styles.rail}><strong>Reverie</strong><p>第 {stepIndex(draft.step) + 1} / {ONBOARDING_STEPS.length} 步</p><ol>{ONBOARDING_STEPS.map((step) => <li key={step} data-active={step === draft.step}>{STEP_LABELS[step]}</li>)}</ol></aside>
      <div className={styles.body}><div className={styles.content}>{renderStep()}</div><footer className={styles.footer}><div>{/* 左侧留空：向导只出现一次，没有中途关闭入口 */}</div><div><button type="button" disabled={busy || draft.step === 'welcome'} onClick={() => go(-1)}>上一步</button>{draft.step === 'finish' ? <button type="button" disabled={busy || (!hostReady && hostDownSeconds < 60) || !canContinue(draft)} onClick={() => void finish()}>{!hostReady && hostDownSeconds >= 60 ? '强制完成' : '完成并进入'}</button> : <button type="button" disabled={busy || !canContinue(draft)} onClick={() => go(1)}>下一步</button>}</div></footer></div>
    </section>
  </div>;
}
