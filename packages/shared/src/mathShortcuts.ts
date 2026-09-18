/**
 * Math editor commands, keyboard shortcuts and slash commands.
 *
 * Commands insert LaTeX templates into the WYSIWYG editor; students never type LaTeX.
 * Placeholders follow MathLive conventions: #@ = current selection/previous atom, #? = empty slot,
 * #0 = selection or empty slot.
 *
 * Shortcut conflicts: browsers reserve some combinations that a web page cannot intercept
 * (Ctrl/Cmd+1..9 switch tabs in Chrome/Edge/Firefox, Ctrl+W/T/N). Ctrl+R (reload) and Ctrl+P
 * (print) CAN be intercepted while the editor has focus. Therefore the default profile keeps the
 * requested bindings where possible and remaps only the reserved ones on the web
 * (Ctrl+2 → Alt+2). The desktop app (Electron) owns its key handling and keeps Ctrl+2.
 * Every binding can be overridden by the user (persisted client-side).
 */
export interface MathCommand {
  id: string;
  label: string;
  /** LaTeX template inserted into the editor */
  latex: string;
  /** slash-command aliases, typed as /alias */
  slash: string[];
  toolbar?: boolean;
  description: string;
}

export const MATH_COMMANDS: MathCommand[] = [
  { id: 'frac', label: 'a/b', latex: '\\frac{#@}{#?}', slash: ['frac', 'f'], toolbar: true, description: '분수' },
  { id: 'sqrt', label: '√', latex: '\\sqrt{#0}', slash: ['sqrt', 'root'], toolbar: true, description: '제곱근' },
  { id: 'nroot', label: 'ⁿ√', latex: '\\sqrt[#?]{#0}', slash: ['nroot'], description: 'n제곱근' },
  { id: 'square', label: 'x²', latex: '#@^{2}', slash: ['sq', 'square'], toolbar: true, description: '제곱' },
  { id: 'pow', label: 'xⁿ', latex: '#@^{#?}', slash: ['pow', 'sup'], toolbar: true, description: '거듭제곱' },
  { id: 'sub', label: 'xₙ', latex: '#@_{#?}', slash: ['sub'], description: '아래첨자' },
  { id: 'pm', label: '±', latex: '\\pm', slash: ['pm'], toolbar: true, description: '플러스마이너스' },
  { id: 'pi', label: 'π', latex: '\\pi', slash: ['pi'], toolbar: true, description: '파이' },
  { id: 'theta', label: 'θ', latex: '\\theta', slash: ['theta'], toolbar: true, description: '세타' },
  { id: 'sigma', label: 'Σ', latex: '\\sum_{#?}^{#?}', slash: ['sigma', 'sum'], toolbar: true, description: '합' },
  { id: 'int', label: '∫', latex: '\\int_{#?}^{#?}', slash: ['int'], toolbar: true, description: '적분' },
  { id: 'times', label: '×', latex: '\\times', slash: ['times'], description: '곱하기' },
  { id: 'div', label: '÷', latex: '\\div', slash: ['div'], description: '나누기' },
  { id: 'le', label: '≤', latex: '\\le', slash: ['le'], description: '작거나 같다' },
  { id: 'ge', label: '≥', latex: '\\ge', slash: ['ge'], description: '크거나 같다' },
  { id: 'ne', label: '≠', latex: '\\ne', slash: ['ne', 'neq'], description: '같지 않다' },
  { id: 'inf', label: '∞', latex: '\\infty', slash: ['inf', 'infty'], description: '무한대' },
  { id: 'abs', label: '|x|', latex: '\\left|#0\\right|', slash: ['abs'], description: '절댓값' },
  { id: 'log', label: 'log', latex: '\\log_{#?}\\left(#0\\right)', slash: ['log'], description: '로그' },
  { id: 'sin', label: 'sin', latex: '\\sin', slash: ['sin'], description: '사인' },
  { id: 'cos', label: 'cos', latex: '\\cos', slash: ['cos'], description: '코사인' },
  { id: 'tan', label: 'tan', latex: '\\tan', slash: ['tan'], description: '탄젠트' },
  { id: 'alpha', label: 'α', latex: '\\alpha', slash: ['alpha'], description: '알파' },
  { id: 'beta', label: 'β', latex: '\\beta', slash: ['beta'], description: '베타' },
  { id: 'deg', label: '°', latex: '^{\\circ}', slash: ['deg'], description: '도' },
];

export type ShortcutPlatform = 'web' | 'desktop';
export type ShortcutOS = 'mac' | 'win' | 'linux';

/** Shortcut syntax: modifiers joined with '+', final token is a key ("Ctrl+/", "Alt+2", "Ctrl+R"). */
export type ShortcutMap = Record<string, string>;

export const DEFAULT_SHORTCUTS: ShortcutMap = {
  frac: 'Ctrl+/',
  sqrt: 'Ctrl+R',
  square: 'Ctrl+2',
  pi: 'Ctrl+P',
  pow: 'Ctrl+6',
  pm: 'Ctrl+Shift+=',
  theta: 'Ctrl+Shift+T',
  sigma: 'Ctrl+Shift+S',
  int: 'Ctrl+Shift+I',
};

/** Bindings a web page cannot intercept, per OS. */
const BROWSER_RESERVED: Record<ShortcutOS, RegExp[]> = {
  win: [/^Ctrl\+[1-9]$/, /^Ctrl\+[WTN]$/, /^Ctrl\+Shift\+[TNW]$/],
  linux: [/^Ctrl\+[1-9]$/, /^Ctrl\+[WTN]$/, /^Ctrl\+Shift\+[TNW]$/, /^Alt\+[1-9]$/],
  mac: [/^Meta\+[1-9]$/, /^Meta\+[WTNQ]$/],
};

export function isBrowserReserved(binding: string, os: ShortcutOS): boolean {
  return BROWSER_RESERVED[os].some((re) => re.test(binding));
}

/**
 * Resolve the effective shortcut map. Reserved bindings on the web are remapped
 * (Ctrl+n → Alt+n on Windows/mac, Ctrl+Alt+n on Linux where Alt+n switches tabs).
 */
export function resolveShortcuts(
  platform: ShortcutPlatform,
  os: ShortcutOS,
  overrides: ShortcutMap = {},
): ShortcutMap {
  const out: ShortcutMap = { ...DEFAULT_SHORTCUTS, ...overrides };
  if (platform === 'web') {
    for (const [cmd, binding] of Object.entries(out)) {
      if (isBrowserReserved(binding, os)) {
        const key = binding.split('+').pop()!;
        out[cmd] = os === 'linux' ? `Ctrl+Alt+${key}` : `Alt+${key}`;
      }
    }
  }
  return out;
}

export interface KeyLike {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  /** KeyboardEvent.code (layout independent, robust against IME e.g. Korean input) */
  code: string;
  /** KeyboardEvent.key — fallback when `code` is empty (virtual keyboards, remote desktop, automation) */
  key?: string;
}

function codeFromKey(key: string | undefined): string {
  if (!key) return '';
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return KEY_TO_CODE[key] ?? SHIFTED_KEY_TO_CODE[key] ?? '';
}

/** US-layout shifted characters (Shift+= reports key "+") */
const SHIFTED_KEY_TO_CODE: Record<string, string> = { '+': 'Equal', '?': 'Slash', _: 'Minus', ':': 'Semicolon', '"': 'Quote' };

const KEY_TO_CODE: Record<string, string> = {
  '/': 'Slash',
  '=': 'Equal',
  '-': 'Minus',
  '.': 'Period',
  ',': 'Comma',
  ';': 'Semicolon',
  "'": 'Quote',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  Space: 'Space',
  Enter: 'Enter',
};

export function parseShortcut(binding: string): KeyLike {
  const parts = binding.split('+').map((p) => p.trim());
  // "Ctrl+Shift+=" splits fine; "Ctrl++" is not supported (use "=")
  const key = parts.pop() ?? '';
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  let code: string;
  if (/^[A-Za-z]$/.test(key)) code = `Key${key.toUpperCase()}`;
  else if (/^[0-9]$/.test(key)) code = `Digit${key}`;
  else code = KEY_TO_CODE[key] ?? key;
  return {
    ctrlKey: mods.has('ctrl') || mods.has('control'),
    altKey: mods.has('alt') || mods.has('option'),
    shiftKey: mods.has('shift'),
    metaKey: mods.has('meta') || mods.has('cmd'),
    code,
  };
}

export function matchShortcut(e: KeyLike, binding: string): boolean {
  const s = parseShortcut(binding);
  const code = e.code || codeFromKey(e.key);
  const codeMatches = code === s.code || (s.code.startsWith('Digit') && code === `Numpad${s.code.slice(5)}`);
  return (
    codeMatches &&
    e.ctrlKey === s.ctrlKey &&
    e.altKey === s.altKey &&
    e.shiftKey === s.shiftKey &&
    e.metaKey === s.metaKey
  );
}

export function findCommandForKey(e: KeyLike, shortcuts: ShortcutMap): MathCommand | undefined {
  for (const [cmdId, binding] of Object.entries(shortcuts)) {
    if (matchShortcut(e, binding)) return MATH_COMMANDS.find((c) => c.id === cmdId);
  }
  return undefined;
}

/** Slash-command lookup: returns commands whose alias starts with the typed prefix. */
export function searchSlashCommands(prefix: string): MathCommand[] {
  const p = prefix.toLowerCase();
  const exact: MathCommand[] = [];
  const partial: MathCommand[] = [];
  for (const c of MATH_COMMANDS) {
    if (c.slash.some((s) => s === p)) exact.push(c);
    else if (c.slash.some((s) => s.startsWith(p))) partial.push(c);
  }
  return [...exact, ...partial];
}
