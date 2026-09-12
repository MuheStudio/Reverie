export type VoicePackFileSummary = {
  role: string;
  name: string;
  size: number | null;
};

export type VoicePackScanSummary = {
  previewId: string;
  format: string;
  runtimeFamily: string;
  runtimeVersion: string;
  wrapperDirectory: string | null;
  files: VoicePackFileSummary[];
  referenceAudio: {
    durationSeconds: number | null;
    sampleRate: number | null;
    channels: number | null;
  };
  transcriptCharacters: number | null;
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parseVoicePackScan(value: unknown): VoicePackScanSummary | null {
  const source = recordValue(value);
  if (!source || typeof source.previewId !== 'string') return null;
  const referenceAudio = recordValue(source.referenceAudio);
  const transcript = recordValue(source.transcript);
  const files = Array.isArray(source.files) ? source.files.flatMap((entry) => {
    const file = recordValue(entry);
    if (!file || typeof file.role !== 'string' || typeof file.originalName !== 'string') return [];
    return [{
      role: file.role,
      name: file.originalName,
      size: finiteNumber(file.size),
    }];
  }) : [];
  return {
    previewId: source.previewId,
    format: typeof source.format === 'string' ? source.format : '未知',
    runtimeFamily: typeof source.runtimeFamily === 'string' ? source.runtimeFamily : '',
    runtimeVersion: typeof source.runtimeVersion === 'string' ? source.runtimeVersion : '',
    wrapperDirectory: typeof source.wrapperDirectory === 'string' ? source.wrapperDirectory : null,
    files,
    referenceAudio: {
      durationSeconds: finiteNumber(referenceAudio?.durationSeconds),
      sampleRate: finiteNumber(referenceAudio?.sampleRate),
      channels: finiteNumber(referenceAudio?.channels),
    },
    transcriptCharacters: finiteNumber(transcript?.characters),
  };
}

export function isExactGptSovitsV2(scan: VoicePackScanSummary | null): boolean {
  return scan?.runtimeFamily === 'gpt-sovits' && scan.runtimeVersion === 'v2';
}

export function formatFileSize(bytes: number | null): string {
  if (bytes === null || bytes < 0) return '大小未知';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function live2dRuntimeUnavailableMessage(
  runtime?: { live2d?: { available?: boolean; reason?: string } } | null,
): string | null {
  if (runtime == null) return null;
  if (runtime.live2d?.available === true) return null;
  const reason = runtime.live2d?.reason?.trim()
    || 'Live2D public runtime is disabled by the build and runtime gates';
  return `此构建未启用 Live2D 运行时：${reason}。完整模式需要带 Cubism Core 的安装包才能导入形象；核心模式可先跳过。`;
}

export function live2dPreviewFailureMessage(
  cause: string,
  mocVersion?: number | null,
): string {
  const cubismHint = Number.isInteger(mocVersion) && Number(mocVersion) >= 4
    ? ` 此模型的 moc3 内部版本为 Cubism ${mocVersion}，需要 Cubism Core ${mocVersion}+。`
    : '';
  return `${cause}${cubismHint} 修复建议：检查 model3.json 引用的纹理、动作和表达文件是否完整，并确认 Live2D 运行时许可可用后重试。`;
}
