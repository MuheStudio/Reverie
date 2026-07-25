/**
 * Unified Logger
 *
 * - debug 开启时：console 输出 + POST /api/log（写入 logs/debug-*.log）
 * - debug 关闭时：仅 logger.error 始终输出
 *
 * 开启：localStorage.setItem('webuiapps-debug', 'true') 或 window.__logger__.enable()
 * 关闭：localStorage.setItem('webuiapps-debug', 'false') 或 window.__logger__.disable()
 */

const STORAGE_KEY = 'webuiapps-debug';
const LOG_ENDPOINT = '/api/log';

function isDebugEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Fire-and-forget POST，不阻塞调用方 */
function postLog(level: 'info' | 'warn' | 'error', tag: string, args: unknown[]): void {
  try {
    // 用 Promise.resolve() 包裹，防止 fetch 在测试环境 mock 耗尽后返回 undefined 时 .catch 报错
    Promise.resolve(
      fetch(LOG_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level, tag, args, ts: Date.now() }),
      }),
    ).catch(() => {
      // 静默忽略：生产构建或 dev server 未启动时均可安全失败
    });
  } catch {
    // 静默忽略
  }
}

export const logger = {
  enable(): void {
    localStorage.setItem(STORAGE_KEY, 'true');
    console.info('[Logger] debug enabled — logs → logs/debug-*.log');
  },

  disable(): void {
    localStorage.setItem(STORAGE_KEY, 'false');
    console.info('[Logger] debug disabled');
  },

  info(tag: string, ...args: unknown[]): void {
    if (!isDebugEnabled()) return;
    console.info(`[${tag}]`, ...args);
    postLog('info', tag, args);
  },

  warn(tag: string, ...args: unknown[]): void {
    if (!isDebugEnabled()) return;
    console.warn(`[${tag}]`, ...args);
    postLog('warn', tag, args);
  },

  /** error 始终输出，不受 debug 开关控制 */
  error(tag: string, ...args: unknown[]): void {
    console.error(`[${tag}]`, ...args);
    postLog('error', tag, args);
  },
};

declare global {
  interface Window {
    __logger__: typeof logger;
  }
}
window.__logger__ = logger;
