import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const frontendRoot = path.resolve(process.cwd());

function source(relative: string): string {
  return fs.readFileSync(path.join(frontendRoot, relative), 'utf8');
}

describe('MVP renderer boundary', () => {
  it('mounts MvpRoom by default with lazy DreamRoom switching only', () => {
    const entry = source('src/index.tsx');
    expect(entry).toContain("from '@/components/MvpRoom'");
    expect(entry).not.toMatch(/react-router|ReverieMain/);
    // DreamRoom is reachable only through the switchable her-room view.
    expect(entry).toMatch(/DreamRoom/);
    expect(entry).toMatch(/settings\.ui\.mode/);
  });

  it('acknowledges profile persistence before marking onboarding complete', () => {
    const bridge = source('src/hooks/useMvpBridge.ts');
    const start = bridge.indexOf('const completeOnboarding');
    const end = bridge.indexOf('  return {', start);
    const flow = bridge.slice(start, end);
    expect(flow.indexOf("'user:profile:update'")).toBeGreaterThan(-1);
    expect(flow.indexOf("'settings:update'")).toBeGreaterThan(
      flow.indexOf("'user:profile:update'"),
    );
    expect(flow).toContain('savedProfile.error');
    expect(flow).toContain('completed.ok !== true');
  });

  it('does not persist facts or credentials in browser storage', () => {
    const room = source('src/components/MvpRoom/index.tsx');
    const bridge = source('src/hooks/useMvpBridge.ts');
    expect(room + bridge).not.toMatch(/localStorage\.setItem|sessionStorage\.setItem/);
  });
});
