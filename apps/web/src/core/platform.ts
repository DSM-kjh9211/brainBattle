import { resolveShortcuts, type ShortcutMap, type ShortcutOS } from '@brainbattle/shared';

/** API exposed by the Electron preload script (apps/desktop/src/preload.cjs). */
export interface DesktopBridge {
  isDesktop: true;
  platform: string;
  openPresentation(url: string): Promise<{ displayId: number | null; external: boolean }>;
  closePresentation(): Promise<void>;
  listDisplays(): Promise<{ id: number; label: string; primary: boolean; bounds: { width: number; height: number } }[]>;
  toggleFullscreen(): Promise<boolean>;
}

declare global {
  interface Window {
    brainbattleDesktop?: DesktopBridge;
  }
}

export const desktop: DesktopBridge | null = typeof window !== 'undefined' ? (window.brainbattleDesktop ?? null) : null;

export function detectOS(): ShortcutOS {
  const p = (navigator.platform || navigator.userAgent).toLowerCase();
  if (p.includes('mac')) return 'mac';
  if (p.includes('linux') || p.includes('android')) return 'linux';
  return 'win';
}

const SHORTCUT_KEY = 'bb.mathShortcuts';

export function loadShortcutOverrides(): ShortcutMap {
  try {
    return JSON.parse(localStorage.getItem(SHORTCUT_KEY) ?? '{}') as ShortcutMap;
  } catch {
    return {};
  }
}

export function saveShortcutOverrides(m: ShortcutMap): void {
  try {
    localStorage.setItem(SHORTCUT_KEY, JSON.stringify(m));
  } catch {
    /* ignore */
  }
}

/** Effective math shortcuts for this device (web vs desktop, OS, user overrides). */
export function effectiveShortcuts(): ShortcutMap {
  return resolveShortcuts(desktop ? 'desktop' : 'web', detectOS(), loadShortcutOverrides());
}

/** Opens the projector/scoreboard view: a second window on the external display (desktop) or a new tab. */
export async function openPresentation(url: string): Promise<void> {
  if (desktop) {
    await desktop.openPresentation(url);
    return;
  }
  window.open(url, 'brainbattle-presentation', 'popup,width=1280,height=720');
}
