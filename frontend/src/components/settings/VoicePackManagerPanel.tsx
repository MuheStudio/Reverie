import { useCallback, useEffect, useState } from 'react';

type VoicePackRecord = {
  id: string;
  format?: string;
  createdAt?: string;
  active?: boolean;
  wrapperDirectory?: string | null;
  files?: Array<{ originalName?: string; role?: string }>;
};

function recordId(value: Record<string, unknown>): string {
  return typeof value.id === 'string' ? value.id : '';
}

function asRecords(value: unknown): VoicePackRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const id = recordId(record);
    if (!id) return [];
    return [{
      id,
      format: typeof record.format === 'string' ? record.format : undefined,
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : undefined,
      active: record.active === true,
      wrapperDirectory: typeof record.wrapperDirectory === 'string' ? record.wrapperDirectory : null,
      files: Array.isArray(record.files)
        ? record.files.flatMap((file) => {
          if (!file || typeof file !== 'object' || Array.isArray(file)) return [];
          const entry = file as Record<string, unknown>;
          return [{
            originalName: typeof entry.originalName === 'string' ? entry.originalName : undefined,
            role: typeof entry.role === 'string' ? entry.role : undefined,
          }];
        })
        : [],
    }];
  });
}

export default function VoicePackManagerPanel() {
  const api = window.electronAPI?.voicePack;
  const [records, setRecords] = useState<VoicePackRecord[]>([]);
  const [status, setStatus] = useState('正在读取已安装的语音包…');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!api?.list) {
      setStatus('语音包接口不可用。');
      setRecords([]);
      return;
    }
    try {
      const value = await api.list();
      setRecords(asRecords(value.records));
      if (!value.available) setStatus('语音包模块不可用。');
      else if (value.corrupt?.length) {
        setStatus(`已安装 ${value.records.length} 个语音包；另有 ${value.corrupt.length} 个损坏记录可删除后重导。`);
      } else if (!value.records.length) {
        setStatus('还没有语音包。可在新手引导或这里导入 GPT-SoVITS v2 四件套文件夹。');
      } else {
        setStatus(`已安装 ${value.records.length} 个语音包。请在本机启动 GPT-SoVITS 官方 api_v2.py（默认 127.0.0.1:9880），打开朗读后会用当前语音包开口。`);
      }
    } catch (reason) {
      setStatus(reason instanceof Error ? reason.message : '无法读取语音包。');
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (action: () => Promise<void>, pending: string) => {
    if (busy) return;
    setBusy(true);
    setStatus(pending);
    try {
      await action();
      await refresh();
    } catch (reason) {
      setStatus(reason instanceof Error ? reason.message : '操作失败。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="语音包">
      <p>{status}</p>
      <div>
        <button
          type="button"
          disabled={busy || !api?.beginImport}
          onClick={() => void run(async () => {
            const preview = await api?.beginImport();
            if (!preview) {
              setStatus('未选择文件夹。');
              return;
            }
            const previewId = typeof preview.previewId === 'string' ? preview.previewId : '';
            if (!previewId) throw new Error('扫描结果无效');
            const record = await api?.commitImport(previewId, {
              rightsAttested: true,
              runtimeFamily: 'gpt-sovits',
              runtimeVersion: 'v2',
            });
            const id = typeof record?.id === 'string' ? record.id : '';
            if (id) await api?.setActive(id);
            setStatus('语音包已安装并设为当前语音。请启动本机 GPT-SoVITS（127.0.0.1:9880）后打开朗读。');
          }, '正在扫描并安装语音包…')}
        >
          导入 GPT-SoVITS v2 文件夹
        </button>
        <button type="button" disabled={busy} onClick={() => void refresh()}>刷新</button>
      </div>
      <ul>
        {records.map((record) => {
          const label = record.files?.find((file) => file.role === 'gptCheckpoint')?.originalName
            || record.wrapperDirectory
            || record.id.slice(0, 8);
          return (
            <li key={record.id}>
              <strong>{label}</strong>
              {record.active ? '（当前）' : ''}
              <button
                type="button"
                disabled={busy || record.active}
                onClick={() => void run(async () => {
                  await api?.setActive(record.id);
                }, '正在设为当前语音…')}
              >
                设为当前
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(async () => {
                  await api?.remove(record.id);
                }, '正在删除语音包…')}
              >
                删除
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
