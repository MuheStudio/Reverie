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

  it('accepts proactive chat without changing the active request lifecycle', () => {
    const bridge = source('src/hooks/useMvpBridge.ts');
    expect(bridge).toContain("'proactive:message'");
    const proactiveCase = bridge.slice(
      bridge.indexOf("case 'proactive:message':"),
      bridge.indexOf("case 'emotion:update':"),
    );
    expect(proactiveCase).toContain("source: 'proactive'");
    expect(proactiveCase).not.toContain('setActiveRequestId');
    expect(proactiveCase).not.toContain('setIsTyping');
  });

  it('keeps the character canvas inside the viewport when settings panels are tall', () => {
    const styles = source('src/components/MvpRoom/MvpRoom.module.scss');
    // A stretchable column/panel lets the tall settings and memory content
    // grow the shell row, which pushes the centered Live2D canvas below the
    // clipped viewport — the character reads as "vanished". Both blocks must
    // pin a hard viewport height instead of a min-height floor.
    const column = styles.slice(
      styles.indexOf('.characterColumn'),
      styles.indexOf('.identityNotice'),
    );
    expect(column).toMatch(/height:\s*100vh/);
    expect(column).not.toMatch(/min-height:\s*100vh/);
    const panel = styles.slice(
      styles.indexOf('.panel {'),
      styles.indexOf('.panelHeader'),
    );
    expect(panel).toMatch(/height:\s*calc\(100vh - 32px\)/);
    expect(panel).not.toMatch(/min-height:\s*calc\(100vh - 32px\)/);
  });

  it('keeps the Live2D model resident across window minimize/restore', () => {
    const adapter = source('src/components/AvatarView/Live2DAdapter.tsx');
    const hideBranch = adapter.slice(
      adapter.indexOf('async setActive(active: boolean)'),
      adapter.indexOf("if (!this.suspended) return;"),
    );
    // Chromium throttles rAF to zero for hidden pages, so the render loop
    // already pauses itself. Stopping the ticker or destroying the model on
    // hide made the character vanish permanently whenever Windows' occlusion
    // tracker left visibilityState stuck on "hidden" after a minimize/restore
    // — the resume event never arrived and nothing restarted the loop.
    // Hiding must therefore touch nothing but the suspended flag.
    expect(hideBranch).not.toContain('destroyModel()');
    expect(hideBranch).not.toContain('modelToken += 1');
    expect(hideBranch).not.toContain('ticker?.stop?.()');
    expect(hideBranch).toContain('this.suspended = true;');
  });

  it('never recreates the Live2D renderer from visibility-dependent config', () => {
    const bundled = source('src/components/MvpRoom/BundledCharacter.tsx');
    // A document.hidden-dependent maxFps flips the useLive2D init-effect deps
    // on every re-render while minimized, destroying the whole renderer; the
    // per-renderer "already loaded" refs then block the model from ever
    // reloading — the character reads as "vanished" until a room switch.
    const configSlice = bundled.slice(
      bundled.indexOf('<Live2DCanvas'),
      bundled.indexOf('modelUrl={record?.entryUrl}'),
    );
    expect(configSlice).not.toContain('document.hidden');
    expect(configSlice).toMatch(/maxFps:\s*30/);

    const adapter = source('src/components/AvatarView/Live2DAdapter.tsx');
    // The load gate refs must reset when the renderer is recreated (epoch),
    // so a fresh renderer always (re)loads its model.
    expect(adapter).toMatch(/setModelReadyUrl\(''\);\s*\}, \[epoch\]\)/);
  });
});
