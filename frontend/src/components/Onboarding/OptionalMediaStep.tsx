import React, { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AvatarDetectedCapabilities } from '../DreamRoom/avatarContracts';
import {
  formatFileSize,
  isExactGptSovitsV2,
  live2dPreviewFailureMessage,
  live2dRuntimeUnavailableMessage,
  parseVoicePackScan,
  type VoicePackScanSummary,
} from './optionalMediaHelpers';
import styles from './OnboardingWizard.module.scss';

const AvatarStage = lazy(() => import('../DreamRoom/AvatarStage'));
const GPT_SOVITS_URL = 'https://github.com/RVC-Boss/GPT-SoVITS';
const EMPTY_DETECTED: AvatarDetected = { animationClips: [], expressions: [] };

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

class PreviewErrorBoundary extends Component<
  { onError: (cause: string) => void; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    this.props.onError(error.message || 'Live2D 候选预览组件崩溃。');
  }

  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

export default function OptionalMediaStep({
  onLive2dInstalled,
}: {
  onLive2dInstalled?: (installed: boolean) => void;
} = {}) {
  const avatarApi = window.electronAPI?.avatar;
  const voiceApi = window.electronAPI?.voicePack;
  const [runtime, setRuntime] = useState<AvatarRuntime>();
  const [candidate, setCandidate] = useState<AvatarImportCandidate | null>(null);
  const candidateRef = useRef<AvatarImportCandidate | null>(null);
  const detectedRef = useRef<AvatarDetected>(EMPTY_DETECTED);
  const confirmingRef = useRef(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarPreviewReady, setAvatarPreviewReady] = useState(false);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [warningsAccepted, setWarningsAccepted] = useState(false);
  const [avatarStatus, setAvatarStatus] = useState('完整模式必须导入一套 Live2D。可选模型文件夹、直接选 *.model3.json，或导入 zip；安装包不附带角色模型。');
  const [voiceScan, setVoiceScan] = useState<VoicePackScanSummary | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceRights, setVoiceRights] = useState(false);
  const [voiceRuntimeConfirmed, setVoiceRuntimeConfirmed] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState('可选，尚未导入。语音包只会复制到本机应用数据目录。');
  const [installedVoicePacks, setInstalledVoicePacks] = useState(0);
  const [runtimeStatus, setRuntimeStatus] = useState('正在检查可选 TTS 运行时…');

  useEffect(() => { candidateRef.current = candidate; }, [candidate]);

  useEffect(() => {
    let active = true;
    if (avatarApi) {
      void avatarApi.list().then((value) => {
        if (!active) return;
        setRuntime(value.runtime);
        const unavailable = live2dRuntimeUnavailableMessage(value.runtime);
        if (unavailable) setAvatarStatus(unavailable);
        const ready = Array.isArray(value.records)
          && value.records.some((record) => record?.status === 'ready' && record.id === value.activeId);
        if (ready) {
          onLive2dInstalled?.(true);
          setAvatarStatus('已检测到本机导入的 Live2D 形象，可继续。全应用共用这一套，角色卡不会换皮。');
        }
      }).catch((reason) => {
        if (active) setAvatarStatus(`无法读取 Live2D 运行时：${errorMessage(reason, '头像服务未响应。')} 修复建议：重启应用后重试；若仍失败，请报告此原因。`);
      });
    }
    if (voiceApi) {
      void voiceApi.list().then((value) => {
        if (!active) return;
        setInstalledVoicePacks(value.records.length);
        const damaged = value.corrupt?.length ?? 0;
        if (!value.available) setVoiceStatus('语音包模块不可用。修复建议：重启或修复安装后重试。');
        else if (damaged) setVoiceStatus(`已安装 ${value.records.length} 个语音包；另有 ${damaged} 个损坏记录被安全跳过，可在设置中删除后重新导入。朗读时会调用本机 GPT-SoVITS（默认 127.0.0.1:9880）。`);
        else if (value.records.length) setVoiceStatus(`已安装 ${value.records.length} 个语音包。请先在本机启动 GPT-SoVITS 官方 api_v2.py（默认 127.0.0.1:9880），打开朗读后会用这个声音开口。`);
      }).catch((reason) => {
        if (active) setVoiceStatus(`无法读取语音包：${errorMessage(reason, '语音包服务未响应。')} 修复建议：重启应用后重试。`);
      });
    }
    void window.electronAPI?.ttsRuntime?.status?.().then((status) => {
      if (!active) return;
      setRuntimeStatus(status.available
        ? `可选内置 TTS 运行时状态：${status.state}。`
        : 'Reverie 不随包装 GPT-SoVITS。导入语音包后，请自行启动官方 api_v2.py（默认 127.0.0.1:9880），打开朗读即可开口。');
    }).catch((reason) => {
      if (active) setRuntimeStatus(`TTS 运行时状态读取失败：${errorMessage(reason, '本地服务未响应。')}`);
    });
    return () => {
      active = false;
      const pending = candidateRef.current;
      if (pending) void avatarApi?.discardImport(pending.importId).catch(() => undefined);
    };
  }, [avatarApi, voiceApi, onLive2dInstalled]);

  const previewAvatar = useMemo<AvatarRecord | null>(() => candidate ? {
    id: `preview:${candidate.importId}`,
    name: candidate.name,
    kind: candidate.kind,
    entryUrl: candidate.preview.url,
    status: 'ready',
    warnings: candidate.warnings,
    detected: candidate.detected,
    capabilities: candidate.preview.capabilities,
  } : null, [candidate]);

  const resetAvatarConfirmation = () => {
    detectedRef.current = EMPTY_DETECTED;
    confirmingRef.current = false;
    setAvatarPreviewReady(false);
    setRightsConfirmed(false);
    setWarningsAccepted(false);
  };

  const discardCandidate = useCallback(async (status?: string) => {
    const pending = candidateRef.current;
    candidateRef.current = null;
    setCandidate(null);
    resetAvatarConfirmation();
    if (status) setAvatarStatus(status);
    if (!pending || !avatarApi) return;
    try { await avatarApi.discardImport(pending.importId); } catch (reason) {
      setAvatarStatus(`候选资源清理失败：${errorMessage(reason, '头像服务未响应。')} 修复建议：重启应用后再导入。`);
    }
  }, [avatarApi]);

  const beginAvatarImport = async () => {
    if (!avatarApi || avatarBusy) return;
    const unavailable = live2dRuntimeUnavailableMessage(runtime);
    if (unavailable) {
      setAvatarStatus(unavailable);
      return;
    }
    if (candidate) await discardCandidate();
    setAvatarBusy(true);
    setAvatarStatus('正在扫描 Live2D 文件夹并准备隔离预览…');
    try {
      const next = await avatarApi.beginImportFolder();
      if (!next) {
        setAvatarStatus('未选择文件夹；Live2D 保持未配置。');
        return;
      }
      await acceptAvatarCandidate(next);
    } catch (reason) {
      setAvatarStatus(`Live2D 扫描失败：${errorMessage(reason, '头像服务未响应。')} 修复建议：确认文件夹完整且可读，然后重试。`);
    } finally { setAvatarBusy(false); }
  };

  const beginAvatarFileImport = async () => {
    if (!avatarApi || avatarBusy) return;
    const unavailable = live2dRuntimeUnavailableMessage(runtime);
    if (unavailable) {
      setAvatarStatus(unavailable);
      return;
    }
    if (candidate) await discardCandidate();
    setAvatarBusy(true);
    setAvatarStatus('正在扫描 model3.json / zip 并准备隔离预览…');
    try {
      const next = await avatarApi.beginImportLive2DFile?.();
      if (!next) {
        setAvatarStatus('未选择文件；Live2D 保持未配置。');
        return;
      }
      await acceptAvatarCandidate(next);
    } catch (reason) {
      setAvatarStatus(`Live2D 文件扫描失败：${errorMessage(reason, '头像服务未响应。')} 修复建议：选择 Cubism 的 *.model3.json，或包含完整模型的 .zip。`);
    } finally { setAvatarBusy(false); }
  };

  const acceptAvatarCandidate = async (next: AvatarImportCandidate) => {
    if (next.kind !== 'live2d') {
      try { await avatarApi?.discardImport(next.importId); } catch { /* cleanup best-effort */ }
      setAvatarStatus('拖入的内容不是可识别的 Live2D 模型。修复建议：拖入模型文件夹、*.model3.json 或完整 .zip。');
      return;
    }
    resetAvatarConfirmation();
    candidateRef.current = next;
    setCandidate(next);
    setAvatarStatus('扫描完成，正在渲染候选模型。预览成功确认前不会安装。');
  };

  const importAvatarFromDrop = async (file: File) => {
    if (!avatarApi || avatarBusy) return;
    const unavailable = live2dRuntimeUnavailableMessage(runtime);
    if (unavailable) {
      setAvatarStatus(unavailable);
      return;
    }
    if (candidate) await discardCandidate();
    setAvatarBusy(true);
    setAvatarStatus('正在扫描拖入的 Live2D 资源并准备隔离预览…');
    try {
      const next = await avatarApi.importDropped(file);
      if (!next) {
        setAvatarStatus('拖入内容无法读取；请改用“选择文件夹”或“选择 model3.json / zip”。');
        return;
      }
      await acceptAvatarCandidate(next);
    } catch (reason) {
      setAvatarStatus(`Live2D 拖入扫描失败：${errorMessage(reason, '头像服务未响应。')} 修复建议：拖入完整模型文件夹、*.model3.json 或 .zip。`);
    } finally { setAvatarBusy(false); }
  };

  const failAvatarPreview = useCallback(async (cause: string) => {
    const pending = candidateRef.current;
    if (!pending || !avatarApi) return;
    candidateRef.current = null;
    setCandidate(null);
    resetAvatarConfirmation();
    setAvatarStatus(live2dPreviewFailureMessage(cause, pending.modelRuntimeVersion));
    try { await avatarApi.failPreview(pending.importId); } catch (reason) {
      setAvatarStatus(`${cause} 候选资源清理失败：${errorMessage(reason, '头像服务未响应。')} 修复建议：重启应用后重试。`);
    }
  }, [avatarApi]);

  useEffect(() => {
    if (!candidate || avatarPreviewReady) return undefined;
    const expiresIn = Date.parse(candidate.preview.expiresAtUtc) - Date.now();
    const timeout = Math.max(0, Math.min(15_000, Number.isFinite(expiresIn) ? expiresIn : 15_000));
    const timer = window.setTimeout(() => {
      void failAvatarPreview('Live2D 候选预览超时。');
    }, timeout);
    return () => window.clearTimeout(timer);
  }, [avatarPreviewReady, candidate, failAvatarPreview]);

  const confirmAvatarPreview = useCallback(async () => {
    const pending = candidateRef.current;
    if (!pending || !avatarApi || confirmingRef.current) return;
    confirmingRef.current = true;
    setAvatarStatus('模型已渲染，正在确认预览结果…');
    try {
      const detected = detectedRef.current;
      const result = await avatarApi.confirmPreview(pending.importId, {
        detected,
        capabilities: {
          expressionPlayback: detected.expressions.length > 0,
          embeddedAnimationPlayback: detected.animationClips.length > 0,
        },
      });
      if (!result.ready) throw new Error('头像服务未接受预览确认');
      setAvatarPreviewReady(true);
      setAvatarStatus('预览成功并已确认。勾选权利声明，接受所列警告后即可安装并设为当前形象。');
    } catch (reason) {
      await failAvatarPreview(`预览确认失败：${errorMessage(reason, '头像服务未响应。')}`);
    } finally { confirmingRef.current = false; }
  }, [avatarApi, failAvatarPreview]);

  const commitAvatar = async () => {
    const pending = candidateRef.current;
    const warningRequired = Boolean(pending?.requiresWarningAcceptance || pending?.warnings.length);
    if (!avatarApi || !pending || !avatarPreviewReady || !rightsConfirmed || (warningRequired && !warningsAccepted)) return;
    setAvatarBusy(true);
    setAvatarStatus('正在事务安装并设为当前形象…');
    try {
      const record = await avatarApi.commitImport(pending.importId, {
        rightsConfirmed,
        warningsAccepted: !warningRequired || warningsAccepted,
      });
      candidateRef.current = null;
      setCandidate(null);
      resetAvatarConfirmation();
      try {
        await avatarApi.setActive(record.id);
        onLive2dInstalled?.(true);
        setAvatarStatus(`“${record.name}”已安装并设为当前形象。全应用共用这一套 Live2D，角色卡只改人设。`);
      } catch (reason) {
        setAvatarStatus(`“${record.name}”已安装，但设为当前形象失败：${errorMessage(reason, '头像服务未响应。')} 修复建议：稍后在形象管理中选择并启用它。`);
      }
    } catch (reason) {
      setAvatarStatus(`Live2D 安装失败：${errorMessage(reason, '头像服务未响应。')} 修复建议：保留当前页面并重试；若源文件已更改，请重新选择文件夹。`);
    } finally { setAvatarBusy(false); }
  };

  const beginVoiceImport = async () => {
    if (!voiceApi || voiceBusy) return;
    setVoiceBusy(true);
    setVoiceScan(null);
    setVoiceRights(false);
    setVoiceRuntimeConfirmed(false);
    setVoiceStatus('正在扫描语音包；不会执行其中的代码或模型。');
    try {
      const result = await voiceApi.beginImport();
      if (!result) {
        setVoiceStatus('未选择文件夹；TTS 保持未配置。');
        return;
      }
      acceptVoiceScan(result);
    } catch (reason) {
      setVoiceStatus(`语音包扫描失败：${errorMessage(reason, '语音包服务未响应。')} 修复建议：确认文件夹仅包含一套 GPT、SoVITS、参考 WAV 和 UTF-8 文本，并按提示修正后重试。`);
    } finally { setVoiceBusy(false); }
  };

  const importVoiceFromDrop = async (file: File) => {
    if (!voiceApi || voiceBusy) return;
    setVoiceBusy(true);
    setVoiceScan(null);
    setVoiceRights(false);
    setVoiceRuntimeConfirmed(false);
    setVoiceStatus('正在扫描拖入的语音包；不会执行其中的代码或模型。');
    try {
      const result = await voiceApi.importDropped(file);
      if (!result) {
        setVoiceStatus('拖入内容无法读取；请改用“选择语音包文件夹”按钮。');
        return;
      }
      acceptVoiceScan(result);
    } catch (reason) {
      setVoiceStatus(`语音包拖入扫描失败：${errorMessage(reason, '语音包服务未响应。')} 修复建议：拖入包含四件套的文件夹，或改用按钮选择。`);
    } finally { setVoiceBusy(false); }
  };

  const acceptVoiceScan = (result: unknown) => {
    const scan = parseVoicePackScan(result);
    if (!scan) throw new Error('语音包服务返回了无效的扫描摘要');
    setVoiceScan(scan);
    setVoiceStatus(isExactGptSovitsV2(scan)
      ? '扫描完成。确认本地使用权利与精确运行时后可安装。'
      : `运行时不匹配：检测到 ${scan.runtimeFamily || '未知'}/${scan.runtimeVersion || '未知'}，仅接受 gpt-sovits/v2。`);
  };

  const commitVoice = async () => {
    if (!voiceApi || !voiceScan || !voiceRights || !voiceRuntimeConfirmed || !isExactGptSovitsV2(voiceScan)) return;
    setVoiceBusy(true);
    setVoiceStatus('正在事务复制并验证语音包…');
    try {
      const record = await voiceApi.commitImport(voiceScan.previewId, {
        rightsAttested: true,
        runtimeFamily: 'gpt-sovits',
        runtimeVersion: 'v2',
      });
      setInstalledVoicePacks((count) => count + 1);
      setVoiceScan(null);
      setVoiceRights(false);
      setVoiceRuntimeConfirmed(false);
      const recordId = typeof record.id === 'string' ? record.id : '';
      try {
        if (recordId) await voiceApi.setActive(recordId);
        setVoiceStatus('语音包已安装并设为当前语音。请在本机启动 GPT-SoVITS 官方 api_v2.py（默认 127.0.0.1:9880），打开朗读后会用这个声音开口。');
      } catch (reason) {
        setVoiceStatus(`语音包已安装，但设为当前语音失败：${errorMessage(reason, '语音包服务未响应。')} 可稍后在语音包管理中启用。`);
      }
    } catch (reason) {
      setVoiceStatus(`语音包安装失败：${errorMessage(reason, '语音包服务未响应。')} 修复建议：若文件在扫描后被修改，请重新选择文件夹；否则重启应用后重试。`);
    } finally { setVoiceBusy(false); }
  };

  const warningRequired = Boolean(candidate?.requiresWarningAcceptance || candidate?.warnings.length);
  const exactVoiceRuntime = isExactGptSovitsV2(voiceScan);
  const live2dUnavailable = live2dRuntimeUnavailableMessage(runtime);

  // Luna-ts dropZone pattern: preventDefault on dragover (or the window
  // navigates away), accept the first dropped File, and let the preload
  // resolve the real path via webUtils. The dialog buttons stay as fallback.
  const filesOnlyDrop = (onFiles: (file: File) => void) => ({
    onDragOver: (event: React.DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      const file = event.dataTransfer.files?.[0];
      if (!file) return;
      event.preventDefault();
      onFiles(file);
    },
  });

  return <>
    <section
      className={styles.mediaCard}
      aria-labelledby="onboarding-live2d-title"
      {...filesOnlyDrop((file) => void importAvatarFromDrop(file))}
    >
      <div className={styles.mediaHeading}><div><h3 id="onboarding-live2d-title">Live2D 形象（完整模式必做）</h3><p>把模型文件夹、*.model3.json 或 .zip 拖到本卡片，或点按钮选择。安装包不附带角色模型。用户资源不会上传。</p></div><div className={styles.actionRow}><button type="button" disabled={!avatarApi || avatarBusy || Boolean(live2dUnavailable)} onClick={() => void beginAvatarImport()}>{avatarBusy ? '处理中…' : '选择文件夹'}</button><button type="button" disabled={!avatarApi?.beginImportLive2DFile || avatarBusy || Boolean(live2dUnavailable)} onClick={() => void beginAvatarFileImport()}>{avatarBusy ? '处理中…' : '选择 model3.json / zip'}</button></div></div>
      {!avatarApi && <p className={styles.repair} role="alert">头像导入接口不可用。修复建议：重启或修复安装；也可以跳过，稍后在形象管理中重试。</p>}
      {candidate && previewAvatar && <div className={styles.avatarCandidate}>
        <div className={styles.previewFrame} aria-label={`${candidate.name} Live2D 候选预览`}>
          <PreviewErrorBoundary
            key={candidate.importId}
            onError={(cause) => { void failAvatarPreview(cause); }}
          >
            <Suspense fallback={<p role="status">正在加载预览组件…</p>}>
              <AvatarStage
                avatar={previewAvatar}
                live2dRuntime={runtime}
                activity="idle.default"
                lowPower
                onCapabilitiesDetected={(capabilities: AvatarDetectedCapabilities) => {
                  detectedRef.current = { animationClips: capabilities.animationClips, expressions: capabilities.expressions };
                }}
                onStatusChange={(status) => {
                  if (status === 'ready') void confirmAvatarPreview();
                  if (status === 'error') void failAvatarPreview('Live2D 候选模型未能成功渲染。');
                }}
              />
            </Suspense>
          </PreviewErrorBoundary>
        </div>
        <div className={styles.candidateDetails}><strong>{candidate.name}</strong><span>格式：{candidate.preview.format}</span><span>表达：{candidate.detected?.expressions.length ?? 0}；动画：{candidate.detected?.animationClips.length ?? 0}</span>
          {candidate.warnings.length > 0 && <div className={styles.warningBox}><strong>扫描警告</strong><ul>{candidate.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
          <label className={styles.check}><input type="checkbox" checked={rightsConfirmed} onChange={(event) => setRightsConfirmed(event.target.checked)} /><span>我确认拥有这些模型资源的本地使用权，并自行遵守作者许可。</span></label>
          {warningRequired && <label className={styles.check}><input type="checkbox" checked={warningsAccepted} onChange={(event) => setWarningsAccepted(event.target.checked)} /><span>我已阅读并接受上述扫描警告，仍要安装。</span></label>}
          <div className={styles.actionRow}><button type="button" disabled={avatarBusy} onClick={() => void discardCandidate('已取消候选导入；Live2D 保持原状态。')}>取消候选</button><button type="button" disabled={avatarBusy || !avatarPreviewReady || !rightsConfirmed || (warningRequired && !warningsAccepted)} onClick={() => void commitAvatar()}>安装并设为当前形象</button></div>
        </div>
      </div>}
      <p className={styles.status} role="status" aria-live="polite">{avatarStatus}</p>
    </section>

    <section
      className={styles.mediaCard}
      aria-labelledby="onboarding-tts-title"
      {...filesOnlyDrop((file) => void importVoiceFromDrop(file))}
    >
      <div className={styles.mediaHeading}><div><h3 id="onboarding-tts-title">GPT-SoVITS 语音包</h3><p>把语音包文件夹直接拖到本卡片，或点击按钮选择。仅安装本地资源；已安装 {installedVoicePacks} 个。</p></div><button type="button" disabled={!voiceApi || voiceBusy} onClick={() => void beginVoiceImport()}>{voiceBusy ? '扫描中…' : '选择语音包文件夹'}</button></div>
      <p className={styles.officialLink}>项目与格式参考：<a href={GPT_SOVITS_URL} target="_blank" rel="noreferrer">GPT-SoVITS 官方 GitHub</a>。请从你有权使用的来源自行准备资源。</p>
      <p className={styles.notice}>{runtimeStatus} 语音包可选。未启动 GPT-SoVITS 时，打开朗读会回退到 Windows 浏览器语音。正常安装版不捆绑 GPT-SoVITS 运行时或权重。</p>
      {!voiceApi && <p className={styles.repair} role="alert">语音包导入接口不可用。修复建议：重启或修复安装；也可以直接跳过。</p>}
      {voiceScan && <div className={styles.scanSummary} aria-label="语音包扫描摘要">
        <div><strong>格式</strong><span>{voiceScan.format}</span></div><div><strong>精确运行时</strong><span>{voiceScan.runtimeFamily || '未知'}/{voiceScan.runtimeVersion || '未知'}</span></div><div><strong>目录包装</strong><span>{voiceScan.wrapperDirectory || '无'}</span></div><div><strong>参考音频</strong><span>{voiceScan.referenceAudio.durationSeconds?.toFixed(1) ?? '未知'} 秒，{voiceScan.referenceAudio.sampleRate ?? '未知'} Hz，{voiceScan.referenceAudio.channels ?? '未知'} 声道</span></div><div><strong>文本</strong><span>{voiceScan.transcriptCharacters ?? '未知'} 字符</span></div>
        <ul>{voiceScan.files.map((file) => <li key={`${file.role}:${file.name}`}><code>{file.role}</code>：{file.name}（{formatFileSize(file.size)}）</li>)}</ul>
        <label className={styles.check}><input type="checkbox" checked={voiceRights} onChange={(event) => setVoiceRights(event.target.checked)} /><span>我确认拥有此语音、参考音频、文本和模型的本地使用权，且仅在本机使用。</span></label>
        <label className={styles.check}><input type="checkbox" checked={voiceRuntimeConfirmed} disabled={!exactVoiceRuntime} onChange={(event) => setVoiceRuntimeConfirmed(event.target.checked)} /><span>我确认此包精确面向 <code>gpt-sovits/v2</code>；其他家族或版本不兼容。</span></label>
        <button type="button" disabled={voiceBusy || !voiceRights || !voiceRuntimeConfirmed || !exactVoiceRuntime} onClick={() => void commitVoice()}>安装本地语音包</button>
      </div>}
      <p className={styles.status} role="status" aria-live="polite">{voiceStatus}</p>
    </section>
  </>;
}
