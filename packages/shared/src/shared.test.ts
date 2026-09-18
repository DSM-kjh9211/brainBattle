import { describe, expect, it } from 'vitest';
import {
  ClockSyncEstimator,
  canTransitionQuestion,
  canTransitionSession,
  computeSample,
  findCommandForKey,
  isBrowserReserved,
  matchShortcut,
  PRESET_SETTINGS,
  resolveSessionSettings,
  resolveShortcuts,
  searchSlashCommands,
  settingsWarnings,
} from './index.js';

describe('session state machine', () => {
  it('allows only the defined transitions', () => {
    expect(canTransitionSession('CREATED', 'LOBBY')).toBe(true);
    expect(canTransitionSession('LOBBY', 'ACTIVE')).toBe(true);
    expect(canTransitionSession('ACTIVE', 'PAUSED')).toBe(true);
    expect(canTransitionSession('PAUSED', 'ACTIVE')).toBe(true);
    expect(canTransitionSession('CREATED', 'ACTIVE')).toBe(false);
    expect(canTransitionSession('FINISHED', 'ACTIVE')).toBe(false);
    expect(canTransitionSession('PAUSED', 'PAUSED')).toBe(false);
  });
  it('question phases', () => {
    expect(canTransitionQuestion('PENDING', 'PREPARE')).toBe(true);
    expect(canTransitionQuestion('ACTIVE', 'LOCKED')).toBe(true);
    expect(canTransitionQuestion('LOCKED', 'ACTIVE')).toBe(false);
    expect(canTransitionQuestion('RESULT', 'PENDING')).toBe(false);
  });
});

describe('client clock sync estimator', () => {
  it('computes NTP-style offset/rtt and prefers the lowest-RTT sample', () => {
    const est = new ClockSyncEstimator();
    // server = mono + 1000; request took 50ms up, 50ms down, server held 10ms
    est.addResponse({ seq: 1, clientMono: 0, serverReceivedAt: 1050, serverSentAt: 1060 }, 110);
    expect(est.offset).toBeCloseTo(1000);
    // asymmetric slow sample (rtt 400) must not win
    est.addResponse({ seq: 2, clientMono: 1000, serverReceivedAt: 2350, serverSentAt: 2350 }, 1400);
    expect(est.best()!.seq).toBe(1);
    expect(est.serverNow(5000)).toBeCloseTo(6000);
    expect(computeSample({ seq: 3, clientMono: 0, serverReceivedAt: 1000, serverSentAt: 1000 }, 0).rtt).toBe(0);
  });
});

describe('presets & settings', () => {
  it('presets carry the documented defaults', () => {
    expect(PRESET_SETTINGS.LIVE_QUIZ).toMatchObject({ deliveryMode: 'DIGITAL', progressMode: 'SYNCHRONIZED', scoringMode: 'ACCURACY_SPEED' });
    expect(PRESET_SETTINGS.PAPER_BATTLE).toMatchObject({ deliveryMode: 'PAPER', progressMode: 'FREE', scoringMode: 'POINT_BASED' });
    expect(PRESET_SETTINGS.EXAM.scoreboard.visibility).toBe('PRIVATE');
    expect(PRESET_SETTINGS.EXAM.editPolicy).toBe('UNTIL_SESSION_END');
  });
  it('teacher overrides are merged and validated', () => {
    const s = resolveSessionSettings('EXAM', { scoreboard: { visibility: 'TOP_5' }, join: { maxParticipants: 30 } });
    expect(s.scoreboard).toEqual({ visibility: 'TOP_5', visible: false });
    expect(s.join.maxParticipants).toBe(30);
    expect(s.join.allowGuests).toBe(true);
    expect(() => resolveSessionSettings('EXAM', { join: { maxParticipants: 0 } })).toThrow();
  });
  it('warns about edit + live feedback', () => {
    const w = settingsWarnings(resolveSessionSettings('PAPER_BATTLE', { editPolicy: 'ALLOW' }));
    expect(w.map((x) => x.code)).toContain('EDIT_WITH_LIVE_FEEDBACK');
    expect(settingsWarnings(resolveSessionSettings('PAPER_BATTLE', { editPolicy: 'NO_EDIT' })).map((x) => x.code)).not.toContain('EDIT_WITH_LIVE_FEEDBACK');
  });
});

describe('math shortcuts', () => {
  const ev = (code: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) => ({
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  });
  it('matches by physical key code (IME independent)', () => {
    expect(matchShortcut(ev('Slash', { ctrlKey: true }), 'Ctrl+/')).toBe(true);
    expect(matchShortcut(ev('KeyR', { ctrlKey: true }), 'Ctrl+R')).toBe(true);
    expect(matchShortcut(ev('KeyR', { ctrlKey: true, shiftKey: true }), 'Ctrl+R')).toBe(false);
    expect(matchShortcut(ev('Numpad2', { altKey: true }), 'Alt+2')).toBe(true);
  });
  it('remaps browser-reserved bindings on the web only', () => {
    expect(isBrowserReserved('Ctrl+2', 'win')).toBe(true);
    const web = resolveShortcuts('web', 'win');
    const desktop = resolveShortcuts('desktop', 'win');
    expect(web.square).toBe('Alt+2');
    expect(desktop.square).toBe('Ctrl+2');
    expect(web.frac).toBe('Ctrl+/');
    expect(web.sqrt).toBe('Ctrl+R');
    expect(findCommandForKey(ev('Digit2', { altKey: true }), web)?.id).toBe('square');
    expect(resolveShortcuts('web', 'win', { pi: 'Ctrl+Shift+P' }).pi).toBe('Ctrl+Shift+P');
  });
  it('slash commands', () => {
    expect(searchSlashCommands('frac')[0]!.id).toBe('frac');
    expect(searchSlashCommands('s').map((c) => c.id)).toEqual(expect.arrayContaining(['sqrt', 'sigma', 'sin']));
    expect(searchSlashCommands('zzz')).toEqual([]);
  });
});
