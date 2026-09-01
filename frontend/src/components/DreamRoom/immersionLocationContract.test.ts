import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('foreground immersion location contract', () => {
  it('requests geolocation only from the explicit nearby button handler', () => {
    const source = readFileSync(new URL('ArchivePanels.tsx', import.meta.url), 'utf8');
    const handlerStart = source.indexOf('const requestNearby = async () => {');
    const handlerEnd = source.indexOf('\n  const requestCloseup', handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);

    expect(handler).toContain('await requestWindowsBrowserLocation()');
    expect(source).toContain('onClick={requestNearby}');
    expect(handler).toContain('window.electronAPI?.places');
    expect(handler.indexOf('await api.resolve(placesProvider)')).toBeLessThan(
      handler.indexOf('await requestWindowsBrowserLocation()'),
    );
    expect(handler).toContain('consent: true');
    expect(source).toContain('将本次 WGS84 坐标发送给高德地图（Amap）');
    expect(source).toContain('已保存明文不可读取');
    expect(source).not.toContain('localStorage.setItem');
  });

  it('keeps Google Places results ephemeral and outside every memory or companion path', () => {
    const source = readFileSync(new URL('ArchivePanels.tsx', import.meta.url), 'utf8');
    const googleStart = source.indexOf('{!!googleItems.length && (');
    const googleEnd = source.indexOf('\n      <div className={styles.formGrid}>', googleStart);
    const googleBlock = source.slice(googleStart, googleEnd);

    expect(googleBlock).toContain('className={styles.googlePlacesResults}');
    expect(googleBlock).toContain('translate="no">Google Maps</div>');
    expect(googleBlock).toContain('结果仅在当前界面临时显示');
    expect(googleBlock).not.toContain('confirmAmapPreference');
    expect(googleBlock).not.toContain('MEMORY_');
    expect(googleBlock).not.toContain('ws.');
    expect(googleBlock).not.toContain('<button');
  });

  it('clears stale provider results and consumes per-request consent', () => {
    const source = readFileSync(new URL('ArchivePanels.tsx', import.meta.url), 'utf8');
    const requestStart = source.indexOf('const requestNearby = async () => {');
    const requestEnd = source.indexOf('\n  const selectPlacesProvider', requestStart);
    const request = source.slice(requestStart, requestEnd);
    expect(request).toContain('setAmapItems([])');
    expect(request).toContain('setGoogleItems([])');
    expect(request).toContain('setAmapConsent(false)');
    expect(request).toContain('setGoogleConsent(false)');
    const selector = source.slice(requestEnd, source.indexOf('\n  const saveAmapKey', requestEnd));
    expect(selector).toContain('setAmapItems([])');
    expect(selector).toContain('setGoogleItems([])');
  });

  it('keeps system-location memory consent and data independent from provider search', () => {
    const source = readFileSync(new URL('ArchivePanels.tsx', import.meta.url), 'utf8');
    const handlerStart = source.indexOf('const rememberSystemLocationScale = async () => {');
    const handlerEnd = source.indexOf('\n  const revokeSystemLocationMemory', handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);

    expect(handler).toContain('systemLocationMemoryConsent');
    expect(handler).toContain('coarseSystemLocationMemoryPayload(position)');
    expect(handler).toContain('WSMsgType.MEMORY_STORE');
    expect(handler).not.toMatch(/amap|google|items|nearby|place|provider/i);
    expect(source).toContain('附近地点授权不会代替此同意');
    expect(source).toContain('撤销同意并删除定位摘要');
  });

  it('persists only an explicitly confirmed display preference', () => {
    const source = readFileSync(new URL('ArchivePanels.tsx', import.meta.url), 'utf8');
    const handlerStart = source.indexOf('const confirmAmapPreference = async (');
    const handlerEnd = source.indexOf('\n  const requestCloseup', handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);

    expect(handler).toContain('window.confirm');
    expect(handler).toContain('user_confirmed: true');
    expect(handler).toContain("preference === 'place' ? { display_label: value } : { broad_category: value }");
    expect(handler).not.toContain('latitude');
    expect(handler).not.toContain('longitude');
    expect(handler).not.toContain('short_address');
    expect(handler).not.toContain('distance_band');
    expect(source).toContain('喜欢这家（确认后仅记住店名）');
    expect(source).toContain('记住这类（确认后仅记住类别）');
    expect(source).not.toContain('poi_observation_persistence_allowed');
  });
});
