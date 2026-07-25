import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally before importing logger
const fetchMock = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal('fetch', fetchMock);

const STORAGE_KEY = 'webuiapps-debug';

describe('logger', () => {
  beforeEach(() => {
    fetchMock.mockClear();
    localStorage.clear();
    vi.resetModules();
  });

  // ============ debug 关闭时（默认）============

  describe('debug 关闭时（默认）', () => {
    it('logger.info 不调用 fetch，不打印 console', async () => {
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const { logger } = await import('../logger');

      logger.info('TestTag', 'hello');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('logger.warn 不调用 fetch，不打印 console', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { logger } = await import('../logger');

      logger.warn('TestTag', 'warning');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('logger.error 始终调用 console.error 和 fetch，不受开关影响', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { logger } = await import('../logger');

      logger.error('TestTag', 'something broke');

      expect(consoleSpy).toHaveBeenCalledWith('[TestTag]', 'something broke');
      expect(fetchMock).toHaveBeenCalledOnce();
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.level).toBe('error');
      expect(body.tag).toBe('TestTag');
      consoleSpy.mockRestore();
    });
  });

  // ============ debug 开启时 ============

  describe('debug 开启时', () => {
    beforeEach(() => {
      localStorage.setItem(STORAGE_KEY, 'true');
    });

    it('logger.info 打印 console.info 并 POST /api/log', async () => {
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const { logger } = await import('../logger');

      logger.info('ChatPanel', 'test message', { key: 'value' });

      expect(consoleSpy).toHaveBeenCalledWith('[ChatPanel]', 'test message', { key: 'value' });
      expect(fetchMock).toHaveBeenCalledOnce();

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/log');
      expect(options.method).toBe('POST');

      const body = JSON.parse(options.body);
      expect(body.level).toBe('info');
      expect(body.tag).toBe('ChatPanel');
      expect(body.args).toEqual(['test message', { key: 'value' }]);
      expect(typeof body.ts).toBe('number');

      consoleSpy.mockRestore();
    });

    it('logger.warn 打印 console.warn 并 POST', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { logger } = await import('../logger');

      logger.warn('MockVibe', 'blocked');

      expect(consoleSpy).toHaveBeenCalledWith('[MockVibe]', 'blocked');
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.level).toBe('warn');
      expect(body.tag).toBe('MockVibe');
      consoleSpy.mockRestore();
    });

    it('logger.error 也打印 console.error 并 POST', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { logger } = await import('../logger');

      logger.error('LLM', 'api error');

      expect(consoleSpy).toHaveBeenCalledWith('[LLM]', 'api error');
      expect(fetchMock).toHaveBeenCalledOnce();
      consoleSpy.mockRestore();
    });

    it('fetch 失败时不抛出异常', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network error'));
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const { logger } = await import('../logger');

      expect(() => logger.info('Tag', 'msg')).not.toThrow();
      consoleSpy.mockRestore();
    });

    it('POST body 包含正确的 level/tag/args/ts 字段', async () => {
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const { logger } = await import('../logger');
      const before = Date.now();

      logger.info('ToolLog', 'count=', 3);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.level).toBe('info');
      expect(body.tag).toBe('ToolLog');
      expect(body.args).toEqual(['count=', 3]);
      expect(body.ts).toBeGreaterThanOrEqual(before);
      consoleSpy.mockRestore();
    });
  });

  // ============ enable / disable ============

  describe('enable / disable', () => {
    it('enable() 将 localStorage 设为 true', async () => {
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const { logger } = await import('../logger');

      logger.enable();

      expect(localStorage.getItem(STORAGE_KEY)).toBe('true');
      consoleSpy.mockRestore();
    });

    it('disable() 将 localStorage 设为 false', async () => {
      localStorage.setItem(STORAGE_KEY, 'true');
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const { logger } = await import('../logger');

      logger.disable();

      expect(localStorage.getItem(STORAGE_KEY)).toBe('false');
      consoleSpy.mockRestore();
    });

    it('enable() 后 logger.info 开始 POST', async () => {
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const { logger } = await import('../logger');

      logger.enable();
      fetchMock.mockClear();

      logger.info('Tag', 'after enable');

      expect(fetchMock).toHaveBeenCalledOnce();
      consoleSpy.mockRestore();
    });

    it('disable() 后 logger.info 停止 POST', async () => {
      localStorage.setItem(STORAGE_KEY, 'true');
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const { logger } = await import('../logger');

      logger.disable();
      fetchMock.mockClear();

      logger.info('Tag', 'after disable');

      expect(fetchMock).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  // ============ window.__logger__ ============

  describe('window.__logger__', () => {
    it('挂载到 window.__logger__', async () => {
      const { logger } = await import('../logger');
      expect((window as unknown as { __logger__: unknown }).__logger__).toBe(logger);
    });
  });
});
