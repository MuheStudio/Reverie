import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(name: string): string {
  return readFileSync(new URL(name, import.meta.url), 'utf8');
}

describe('DreamRoom experience contracts', () => {
  it('guards Enter submission during IME composition', () => {
    const chat = source('ChatPanel.tsx');
    expect(chat).toContain('!event.nativeEvent.isComposing');
  });

  it('does not announce token-by-token delivery through a live region', () => {
    const chat = source('ChatPanel.tsx');
    expect(chat).toContain('aria-hidden="true"');
    expect(chat).toContain('stableAnnouncement');
    expect(chat).not.toMatch(/className=\{styles\.messages\}[^>]*aria-live/);
  });

  it('uses exactly one renderer loop and disposes GPU resources', () => {
    const avatar = source('AvatarStage.tsx');
    expect(avatar.match(/new WebGLRenderer/g)).toHaveLength(1);
    expect(avatar).toContain('VRMUtils.deepDispose');
    expect(avatar).toContain('renderer.renderLists.dispose()');
    expect(avatar).toContain('renderer.forceContextLoss()');
    expect(avatar).toContain('Math.min(window.devicePixelRatio || 1, 1.5)');
  });

  it('keeps decorative ink static while weather remains non-interactive and motion-safe', () => {
    const scene = source('RoomScene.module.scss');
    expect(scene).toContain('pointer-events: none');
    expect(scene).not.toMatch(/\.atmosphere > img[^{]*\{[^}]*animation:/s);
    expect(scene).toContain("[data-companion-weather='rain']");
    expect(scene).toContain("[data-companion-weather='wind']");
    expect(scene).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important/);
  });

  it('shows only one focusable primary entry per core action', () => {
    const dock = source('CompanionDock.tsx');
    for (const id of ['primary-chat-action', 'primary-diary-action', 'primary-phone-action']) {
      expect(dock.match(new RegExp(id, 'g'))).toHaveLength(1);
    }
    expect(source('RoomScene.tsx')).not.toContain('<button');
  });

  it('keeps the companion timer and audio mounted when switching dock tabs', () => {
    const dock = source('CompanionDock.tsx');
    expect(dock).toContain("hidden={tab !== 'focus'}");
    expect(dock).not.toContain("{tab === 'focus' && (");
  });

  it('keeps all extra AI switches default-off', () => {
    const panels = source('ArchivePanels.tsx');
    expect(panels).toMatch(/diary_enabled:\s*false/);
    expect(panels).toMatch(/proactive_chat_enabled:\s*false/);
    expect(panels).toMatch(/web_surfing_enabled:\s*false/);
    expect(panels).toMatch(/timeline_visuals_enabled:\s*false/);
    expect(panels).toMatch(/group_social_api_replies_enabled:\s*false/);
    expect(panels).toMatch(/autonomous_memory_llm_enabled:\s*false/);
  });
});
