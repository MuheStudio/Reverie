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
    expect(entry).toMatch(/mode/);
    // The wizard lives on AppShell so DreamRoom cannot hide it.
    expect(entry).toContain("from '@/components/Onboarding/OnboardingWizard'");
    expect(entry).toContain('<OnboardingWizard');
    expect(source('src/components/MvpRoom/index.tsx')).not.toContain('<OnboardingWizard');
    expect(source('src/components/MvpRoom/index.tsx')).toContain('VoicePackManagerPanel');
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
    expect(flow).toContain('searchConsent');
    expect(flow).toContain("section: 'personality'");
    expect(flow).toContain('completed.ok !== true');
    expect(flow).toContain("section: 'ui'");
    expect(flow).toContain('experience_mode === \'core\' ? \'mvp\' : \'dream\'');
  });

  it('ignores undeclared bridge events instead of tearing the connection down', () => {
    const bridge = source('src/hooks/useMvpBridge.ts');
    const handler = bridge.slice(
      bridge.indexOf('socket.onmessage = (event) => {'),
      bridge.indexOf('socket.onerror = () => {'),
    );
    expect(handler).toContain('if (!EVENT_NAMES.has(frame.type)) return;');
    expect(handler).not.toContain("throw new Error('undeclared event')");
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

  it('gates the video download feature behind the verbatim disclaimer, scroll, and fail-closed pairing', () => {
    const room = source('src/components/MvpRoom/index.tsx');
    // The user-specified liability disclaimer must appear verbatim; changing or
    // softening it would break the compliance contract behind the feature.
    expect(room).toContain('本功能仅供下载用户拥有版权或已获授权的视频，禁止用于下载受版权保护且未经授权的内容。');
    expect(room).toContain('用户需自行承担使用本工具的全部法律责任，开发者不对用户的任何行为负责。');
    expect(room).toContain('本工具按“原样”提供，开发者不承担任何直接或间接责任。');
    // The acknowledgement checkbox stays locked until the disclaimer is read to
    // the bottom, and the enable checkbox stays locked until acknowledgement —
    // the same fail-closed pairing the backend enforces independently.
    expect(room).toMatch(/checked=\{acknowledged\}\s*disabled=\{!scrolledToBottom\}/);
    expect(room).toMatch(/checked=\{enabled\}\s*disabled=\{!acknowledged\}/);
    // Saving routes through the features section with both compliance keys, so
    // the backend's fail-closed invariant receives the acknowledgement state.
    const save = room.slice(room.indexOf('const save = '), room.indexOf('return (', room.indexOf('const save = ')));
    expect(save).toContain("section: 'features'");
    expect(save).toContain('video_download_disclaimer_acknowledged: acknowledged');
    expect(save).toContain('const nextEnabled = acknowledged ? enabled : false;');
  });
});
