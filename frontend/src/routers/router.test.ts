import { describe, expect, it } from 'vitest';
import rootRouter from './index';

describe('root router', () => {
  it('ships only DreamRoom routes and excludes legacy/debug product surfaces', () => {
    const paths = rootRouter.map((route) => route.path);

    expect(paths).toContain('/');
    expect(paths).toContain('/reverie');
    expect(paths).toContain('*');
    expect(paths).not.toContain('/desktop');
    expect(paths).not.toContain('/reverie-main');
    expect(paths).not.toContain('/twitter');
    expect(paths).not.toContain('/cyberNews');
  });
});
