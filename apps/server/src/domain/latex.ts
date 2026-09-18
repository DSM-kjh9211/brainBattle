/**
 * LaTeX normalization layer.
 *
 * raw LaTeX ──tokenize──▶ tokens ──parse──▶ AST ──print──▶ canonical string ("x=1/2")
 *                                               └─evaluate─▶ number (when variable-free)
 *
 * This is deliberately NOT a CAS. It removes notational noise (spacing, \left/\right, \dfrac vs
 * \frac, implicit multiplication, redundant braces/parentheses, unicode vs command symbols) and
 * optionally applies order-insensitivity for + and ×. Full symbolic equivalence (e.g. (x+1)^2 vs
 * x^2+2x+1) is a post-MVP feature that can be plugged in behind `areLatexEquivalent`.
 */

export type Node =
  | { k: 'num'; v: string }
  | { k: 'var'; name: string }
  | { k: 'const'; name: 'pi' | 'inf' }
  | { k: 'add'; terms: { op: '+' | '-' | '±'; n: Node }[] }
  | { k: 'mul'; factors: { op: '*' | '/'; n: Node }[] }
  | { k: 'neg'; n: Node }
  | { k: 'pow'; base: Node; exp: Node }
  | { k: 'sub'; base: Node; idx: Node }
  | { k: 'sqrt'; n: Node; index: Node | null }
  | { k: 'func'; name: string; arg: Node; base?: Node }
  | { k: 'abs'; n: Node }
  | { k: 'fact'; n: Node }
  | { k: 'rel'; ops: string[]; parts: Node[] }
  | { k: 'group'; open: '(' | '['; close: ')' | ']'; items: Node[] }
  | { k: 'list'; items: Node[] }
  | { k: 'text'; v: string };

type Tok =
  | { t: 'num'; v: string }
  | { t: 'id'; v: string }
  | { t: 'cmd'; v: string }
  | { t: 'op'; v: string }
  | { t: 'text'; v: string };

const SKIP_CMDS = new Set([',', ';', ':', '!', ' ', 'quad', 'qquad', 'displaystyle', 'textstyle', 'limits', 'nolimits']);
const GREEK = new Set([
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta', 'iota', 'kappa',
  'lambda', 'mu', 'nu', 'xi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega',
  'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Sigma', 'Phi', 'Psi', 'Omega',
]);
const FUNCS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'log', 'ln', 'exp', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'lim', 'max', 'min']);
const CMD_OPS: Record<string, string> = {
  cdot: '*', times: '*', ast: '*', div: '/', pm: '±', mp: '∓',
  le: '<=', leq: '<=', leqslant: '<=', ge: '>=', geq: '>=', geqslant: '>=', ne: '!=', neq: '!=',
  lt: '<', gt: '>', approx: '≈', to: '->', rightarrow: '->',
};
const UNICODE_OPS: Record<string, string> = {
  '−': '-', '–': '-', '×': '*', '·': '*', '⋅': '*', '÷': '/', '±': '±', '≤': '<=', '≥': '>=', '≠': '!=', '≈': '≈', '∙': '*',
};
const UNICODE_SUP: Record<string, string> = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };

export class LatexParseError extends Error {}

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const s = src; // no NFKC here: it would turn ² into a plain 2 and lose the exponent
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c) || c === '~') { i++; continue; }
    if (c === '\\') {
      const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i));
      if (!m) throw new LatexParseError('dangling backslash');
      const name = m[1]!;
      i += m[0].length;
      if (SKIP_CMDS.has(name)) continue;
      if (name === '{' || name === '}') { out.push({ t: 'op', v: name === '{' ? '{' : '}' }); continue; }
      if (name === 'left' || name === 'right' || name === 'big' || name === 'Big' || name === 'bigl' || name === 'bigr' || name === 'Bigl' || name === 'Bigr') {
        // the following delimiter is kept as a plain token; "\left." produces nothing
        while (i < s.length && /\s/.test(s[i]!)) i++;
        if (s[i] === '.') { i++; continue; }
        if (s.startsWith('\\{', i) || s.startsWith('\\}', i)) { out.push({ t: 'op', v: s[i + 1] === '{' ? '(' : ')' }); i += 2; continue; }
        if (s.startsWith('\\vert', i) || s.startsWith('\\lvert', i) || s.startsWith('\\rvert', i)) {
          i += s.startsWith('\\vert', i) ? 5 : 6; out.push({ t: 'op', v: '|' }); continue;
        }
        if (s.startsWith('\\langle', i)) { i += 7; out.push({ t: 'op', v: '(' }); continue; }
        if (s.startsWith('\\rangle', i)) { i += 7; out.push({ t: 'op', v: ')' }); continue; }
        continue;
      }
      if (name === 'text' || name === 'mathrm' || name === 'textrm' || name === 'operatorname' || name === 'mathit' || name === 'mathbf') {
        const g = readBraceGroup(s, i);
        i = g.end;
        const inner = g.content.trim();
        if (name === 'operatorname') out.push({ t: 'cmd', v: inner });
        else if (name === 'text' || name === 'textrm') out.push({ t: 'text', v: inner });
        else out.push(...tokenize(inner));
        continue;
      }
      if (name === 'vert' || name === 'lvert' || name === 'rvert' || name === 'mid') { out.push({ t: 'op', v: '|' }); continue; }
      if (name === 'lbrace') { out.push({ t: 'op', v: '(' }); continue; }
      if (name === 'rbrace') { out.push({ t: 'op', v: ')' }); continue; }
      if (name === 'circ' || name === 'degree') { out.push({ t: 'id', v: '°' }); continue; }
      if (CMD_OPS[name]) { out.push({ t: 'op', v: CMD_OPS[name]! }); continue; }
      if (name === 'dfrac' || name === 'tfrac' || name === 'cfrac') { out.push({ t: 'cmd', v: 'frac' }); continue; }
      out.push({ t: 'cmd', v: name });
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+(\.\d*)?|\.\d+)/.exec(s.slice(i));
      if (!m) throw new LatexParseError(`bad number at ${i}`);
      out.push({ t: 'num', v: m[0] });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z]/.test(c)) { out.push({ t: 'id', v: c }); i++; continue; }
    if (UNICODE_SUP[c]) {
      let digits = '';
      while (i < s.length && UNICODE_SUP[s[i]!]) digits += UNICODE_SUP[s[i++]!];
      out.push({ t: 'op', v: '^' }, { t: 'num', v: digits });
      continue;
    }
    if (c === 'π') { out.push({ t: 'cmd', v: 'pi' }); i++; continue; }
    if (c === '∞') { out.push({ t: 'cmd', v: 'infty' }); i++; continue; }
    if (c === '√') { out.push({ t: 'cmd', v: 'sqrt' }); i++; continue; }
    if (c === '°') { out.push({ t: 'id', v: '°' }); i++; continue; }
    if (UNICODE_OPS[c]) { out.push({ t: 'op', v: UNICODE_OPS[c]! }); i++; continue; }
    if (c === '<' || c === '>' || c === '!') {
      if (s[i + 1] === '=') { out.push({ t: 'op', v: c === '!' ? '!=' : c + '=' }); i += 2; continue; }
      out.push({ t: 'op', v: c }); i++; continue;
    }
    if ('+-*/=^_(){}[]|,'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    if (/\p{L}/u.test(c)) { out.push({ t: 'id', v: c }); i++; continue; } // other letters (e.g. greek unicode)
    if (c === "'") { out.push({ t: 'id', v: "'" }); i++; continue; }
    throw new LatexParseError(`unexpected character ${c}`);
  }
  return out;
}

function readBraceGroup(s: string, i: number): { content: string; end: number } {
  while (i < s.length && /\s/.test(s[i]!)) i++;
  if (s[i] !== '{') return { content: s[i] ?? '', end: i + 1 };
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '{') depth++;
    else if (s[j] === '}') {
      depth--;
      if (depth === 0) return { content: s.slice(i + 1, j), end: j + 1 };
    }
  }
  throw new LatexParseError('unbalanced braces');
}

const REL_OPS = new Set(['=', '<', '>', '<=', '>=', '!=', '≈', '->']);

class Parser {
  private p = 0;
  constructor(private readonly toks: Tok[]) {}

  parse(): Node {
    if (this.toks.length === 0) throw new LatexParseError('empty');
    const n = this.list(null);
    if (this.p < this.toks.length) throw new LatexParseError(`unexpected token ${JSON.stringify(this.toks[this.p])}`);
    return n;
  }

  private peek(): Tok | undefined { return this.toks[this.p]; }
  private isOp(v: string): boolean { const t = this.peek(); return !!t && t.t === 'op' && t.v === v; }
  private eat(v: string): void {
    if (!this.isOp(v)) throw new LatexParseError(`expected ${v}`);
    this.p++;
  }

  private list(close: string | null): Node {
    const items = [this.relation(close)];
    while (this.isOp(',')) { this.p++; items.push(this.relation(close)); }
    return items.length === 1 ? items[0]! : { k: 'list', items };
  }

  private relation(close: string | null): Node {
    const parts = [this.sum(close)];
    const ops: string[] = [];
    for (;;) {
      const t = this.peek();
      if (t && t.t === 'op' && REL_OPS.has(t.v)) { this.p++; ops.push(t.v); parts.push(this.sum(close)); } else break;
    }
    return ops.length === 0 ? parts[0]! : { k: 'rel', ops, parts };
  }

  private sum(close: string | null): Node {
    const terms: { op: '+' | '-' | '±'; n: Node }[] = [];
    let op: '+' | '-' | '±' = '+';
    if (this.isOp('+') || this.isOp('-') || this.isOp('±')) { op = (this.peek() as { v: '+' | '-' | '±' }).v; this.p++; }
    terms.push({ op, n: this.term(close) });
    while (this.isOp('+') || this.isOp('-') || this.isOp('±')) {
      const o = (this.peek() as { v: '+' | '-' | '±' }).v;
      this.p++;
      terms.push({ op: o, n: this.term(close) });
    }
    if (terms.length === 1 && terms[0]!.op === '+') return terms[0]!.n;
    if (terms.length === 1 && terms[0]!.op === '-') return { k: 'neg', n: terms[0]!.n };
    return { k: 'add', terms };
  }

  private startsFactor(close: string | null): boolean {
    const t = this.peek();
    if (!t) return false;
    if (t.t === 'num' || t.t === 'id' || t.t === 'cmd' || t.t === 'text') return true;
    if (t.t === 'op') {
      if (t.v === '(' || t.v === '[' || t.v === '{') return true;
      if (t.v === '|') return close !== '|';
    }
    return false;
  }

  private term(close: string | null): Node {
    const factors: { op: '*' | '/'; n: Node }[] = [{ op: '*', n: this.postfix(close) }];
    for (;;) {
      if (this.isOp('*') || this.isOp('/')) {
        const o = (this.peek() as { v: '*' | '/' }).v;
        this.p++;
        factors.push({ op: o, n: this.postfix(close) });
      } else if (this.startsFactor(close)) {
        factors.push({ op: '*', n: this.postfix(close) }); // implicit multiplication
      } else break;
    }
    return factors.length === 1 ? factors[0]!.n : { k: 'mul', factors };
  }

  private postfix(close: string | null): Node {
    let n = this.primary(close);
    for (;;) {
      if (this.isOp('^')) { this.p++; n = { k: 'pow', base: n, exp: this.script() }; }
      else if (this.isOp('_')) { this.p++; n = { k: 'sub', base: n, idx: this.script() }; }
      else if (this.isOp('!')) { this.p++; n = { k: 'fact', n }; }
      else if (this.peek()?.t === 'id' && (this.peek() as { v: string }).v === "'") { this.p++; n = { k: 'func', name: "prime", arg: n }; }
      else break;
    }
    return n;
  }

  /** argument of ^ or _ : a brace group or a single token */
  private script(): Node {
    if (this.isOp('{')) { this.p++; const n = this.list('}'); this.eat('}'); return n; }
    const t = this.peek();
    if (!t) throw new LatexParseError('missing script');
    if (t.t === 'num') {
      this.p++;
      return t.v.length > 1 && /^\d+$/.test(t.v) ? this.splitDigits(t.v) : { k: 'num', v: normalizeNumber(t.v) };
    }
    if (t.t === 'id') { this.p++; return { k: 'var', name: t.v }; }
    return this.primary(null);
  }

  /** x^23 in LaTeX means x^{2}3 — only the first digit is the exponent */
  private splitDigits(v: string): Node {
    // push back remaining digits as a new number token
    this.toks.splice(this.p, 0, { t: 'num', v: v.slice(1) });
    return { k: 'num', v: v[0]! };
  }

  private arg(): Node {
    if (this.isOp('{')) { this.p++; const n = this.list('}'); this.eat('}'); return n; }
    const t = this.peek();
    if (t?.t === 'num' && t.v.length > 1) { this.p++; return this.splitDigits(t.v); }
    return this.postfix(null);
  }

  private primary(close: string | null): Node {
    const t = this.peek();
    if (!t) throw new LatexParseError('unexpected end');
    this.p++;
    switch (t.t) {
      case 'num': return { k: 'num', v: normalizeNumber(t.v) };
      case 'id': return { k: 'var', name: t.v };
      case 'text': return { k: 'text', v: t.v };
      case 'cmd': return this.command(t.v);
      case 'op': {
        if (t.v === '(' || t.v === '[') {
          const closeCh = t.v === '(' ? ')' : ']';
          const inner = this.list(closeCh);
          // allow mismatched interval brackets like [0, 1)
          if (this.isOp(')') || this.isOp(']')) {
            const c = (this.peek() as { v: ')' | ']' }).v; this.p++;
            const items = inner.k === 'list' ? inner.items : [inner];
            return { k: 'group', open: t.v, close: c, items };
          }
          throw new LatexParseError('unclosed bracket');
        }
        if (t.v === '{') { const n = this.list('}'); this.eat('}'); return n; }
        if (t.v === '|') { const n = this.list('|'); this.eat('|'); return { k: 'abs', n }; }
        if (t.v === '-') return { k: 'neg', n: this.postfix(close) };
        throw new LatexParseError(`unexpected ${t.v}`);
      }
    }
  }

  private command(name: string): Node {
    if (name === 'frac') {
      const num = this.arg();
      const den = this.arg();
      return { k: 'mul', factors: [{ op: '*', n: num }, { op: '/', n: den }] };
    }
    if (name === 'sqrt') {
      let index: Node | null = null;
      if (this.isOp('[')) { this.p++; index = this.list(']'); this.eat(']'); }
      return { k: 'sqrt', n: this.arg(), index };
    }
    if (name === 'pi') return { k: 'const', name: 'pi' };
    if (name === 'infty' || name === 'infin') return { k: 'const', name: 'inf' };
    if (GREEK.has(name)) return { k: 'var', name };
    if (FUNCS.has(name) || /^[a-z]{2,}$/.test(name)) {
      let base: Node | undefined;
      let power: Node | undefined;
      // \log_{2}, \sin^{2}
      for (let i = 0; i < 2; i++) {
        if (this.isOp('_')) { this.p++; base = this.script(); }
        else if (this.isOp('^')) { this.p++; power = this.script(); }
      }
      const arg = this.postfix(null);
      let n: Node = { k: 'func', name, arg, ...(base ? { base } : {}) };
      if (power) n = { k: 'pow', base: n, exp: power };
      return n;
    }
    if (name === 'sum' || name === 'int' || name === 'prod') {
      let lo: Node | undefined, hi: Node | undefined;
      for (let i = 0; i < 2; i++) {
        if (this.isOp('_')) { this.p++; lo = this.script(); }
        else if (this.isOp('^')) { this.p++; hi = this.script(); }
      }
      const body = this.term(null);
      const items: Node[] = [lo ?? { k: 'text', v: '' }, hi ?? { k: 'text', v: '' }, body];
      return { k: 'func', name, arg: { k: 'list', items } };
    }
    return { k: 'var', name };
  }
}

export function normalizeNumber(v: string): string {
  let s = v;
  if (s.startsWith('.')) s = '0' + s;
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  s = s.replace(/^0+(?=\d)/, '');
  return s === '' ? '0' : s;
}

export function parseLatex(src: string): Node {
  return new Parser(tokenize(src)).parse();
}

/* ---------------------------------------------------------------- printing */

export interface PrintOptions {
  /** sort operands of commutative operators */
  commutative?: boolean;
}

const PREC: Record<string, number> = { list: 0, rel: 1, add: 2, neg: 3, mul: 4, pow: 6, atom: 9 };

function prec(n: Node): number {
  switch (n.k) {
    case 'list': return PREC.list!;
    case 'rel': return PREC.rel!;
    case 'add': return PREC.add!;
    case 'neg': return PREC.neg!;
    case 'mul': return PREC.mul!;
    case 'pow': return PREC.pow!;
    case 'num': return n.v.startsWith('-') ? PREC.neg! : PREC.atom!;
    default: return PREC.atom!;
  }
}

export function printNode(n: Node, o: PrintOptions = {}): string {
  const wrap = (c: Node, minPrec: number) => {
    const s = printNode(c, o);
    return prec(c) < minPrec ? `(${s})` : s;
  };
  switch (n.k) {
    case 'num': return n.v;
    case 'var': return n.name;
    case 'const': return n.name === 'pi' ? 'pi' : 'inf';
    case 'text': return n.v;
    case 'neg': return `-${wrap(n.n, PREC.mul!)}`;
    case 'add': {
      const flat = flattenAdd(n);
      let parts = flat.map((t, i) => {
        const body = wrap(t.n, PREC.add! + 1);
        if (i === 0 && t.op === '+') return { key: body, s: body };
        return { key: body, s: `${t.op}${body}` };
      });
      if (o.commutative && flat.every((t) => t.op !== '±')) {
        parts = flat
          .map((t) => {
            const body = wrap(t.n, PREC.add! + 1);
            return { key: `${body}${t.op}`, s: `${t.op}${body}` };
          })
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        const joined = parts.map((p) => p.s).join('');
        return joined.startsWith('+') ? joined.slice(1) : joined;
      }
      return parts.map((p) => p.s).join('');
    }
    case 'mul': {
      const flat = flattenMul(n);
      const nums = flat.filter((f) => f.op === '*').map((f) => wrap(f.n, PREC.mul! + 1));
      const dens = flat.filter((f) => f.op === '/').map((f) => wrap(f.n, PREC.mul! + 1));
      if (o.commutative) { nums.sort(); dens.sort(); }
      const numS = nums.length ? nums.join('*') : '1';
      if (!dens.length) return numS;
      const numPart = nums.length > 1 ? `(${numS})` : numS;
      const denPart = dens.length > 1 ? `(${dens.join('*')})` : dens[0];
      return `${numPart}/${denPart}`;
    }
    case 'pow': return `${wrap(n.base, PREC.pow! + 1)}^${wrap(n.exp, PREC.atom!)}`;
    case 'sub': return `${wrap(n.base, PREC.atom!)}_${wrap(n.idx, PREC.atom!)}`;
    case 'sqrt': return n.index ? `root(${printNode(n.index, o)},${printNode(n.n, o)})` : `sqrt(${printNode(n.n, o)})`;
    case 'func': return `${n.name}${n.base ? `_${wrap(n.base, PREC.atom!)}` : ''}(${printNode(n.arg, o)})`;
    case 'abs': return `|${printNode(n.n, o)}|`;
    case 'fact': return `${wrap(n.n, PREC.atom!)}!`;
    case 'rel': return n.parts.map((p, i) => (i === 0 ? '' : n.ops[i - 1]) + printNode(p, o)).join('');
    case 'group': return `${n.open}${n.items.map((x) => printNode(x, o)).join(',')}${n.close}`;
    case 'list': {
      const items = n.items.map((x) => printNode(x, o));
      if (o.commutative) items.sort();
      return items.join(',');
    }
  }
}

function flattenAdd(n: Node): { op: '+' | '-' | '±'; n: Node }[] {
  if (n.k !== 'add') return [{ op: '+', n }];
  const out: { op: '+' | '-' | '±'; n: Node }[] = [];
  for (const t of n.terms) {
    if (t.n.k === 'add' && t.op === '+') out.push(...flattenAdd(t.n));
    else if (t.n.k === 'neg' && t.op !== '±') out.push({ op: t.op === '+' ? '-' : '+', n: t.n.n });
    else out.push(t);
  }
  return out;
}

function flattenMul(n: Node): { op: '*' | '/'; n: Node }[] {
  if (n.k !== 'mul') return [{ op: '*', n }];
  const out: { op: '*' | '/'; n: Node }[] = [];
  for (const f of n.factors) {
    if (f.n.k === 'mul') {
      for (const g of flattenMul(f.n)) {
        out.push({ op: f.op === '*' ? g.op : g.op === '*' ? '/' : '*', n: g.n });
      }
    } else out.push(f);
  }
  return out;
}

/* ---------------------------------------------------------------- evaluation */

/** Evaluates variable-free expressions; returns null when not purely numeric. */
export function evaluate(n: Node): number | null {
  switch (n.k) {
    case 'num': return Number(n.v);
    case 'const': return n.name === 'pi' ? Math.PI : Infinity;
    case 'neg': { const v = evaluate(n.n); return v === null ? null : -v; }
    case 'add': {
      let acc = 0;
      for (const t of n.terms) {
        if (t.op === '±') return null;
        const v = evaluate(t.n);
        if (v === null) return null;
        acc += t.op === '-' ? -v : v;
      }
      return acc;
    }
    case 'mul': {
      let acc = 1;
      for (const f of n.factors) {
        const v = evaluate(f.n);
        if (v === null) return null;
        acc = f.op === '*' ? acc * v : acc / v;
      }
      return acc;
    }
    case 'pow': {
      const b = evaluate(n.base), e = evaluate(n.exp);
      return b === null || e === null ? null : Math.pow(b, e);
    }
    case 'sqrt': {
      const v = evaluate(n.n);
      if (v === null) return null;
      if (!n.index) return Math.sqrt(v);
      const k = evaluate(n.index);
      return k === null ? null : Math.pow(v, 1 / k);
    }
    case 'abs': { const v = evaluate(n.n); return v === null ? null : Math.abs(v); }
    case 'group': return n.items.length === 1 && n.open === '(' ? evaluate(n.items[0]!) : null;
    case 'func': {
      const v = evaluate(n.arg);
      if (v === null) return null;
      const f: Record<string, (x: number) => number> = {
        sin: Math.sin, cos: Math.cos, tan: Math.tan, ln: Math.log, exp: Math.exp, sqrt: Math.sqrt,
        arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
      };
      if (n.name === 'log') {
        const b = n.base ? evaluate(n.base) : 10;
        return b === null ? null : Math.log(v) / Math.log(b);
      }
      return f[n.name] ? f[n.name]!(v) : null;
    }
    default: return null;
  }
}

/* ---------------------------------------------------------------- public API */

export interface NormalizedLatex {
  /** canonical text form, e.g. "x=1/2"; falls back to a whitespace-stripped string on parse errors */
  canonical: string;
  /** order-insensitive canonical form */
  commutative: string;
  value: number | null;
  ast: Node | null;
}

export function fallbackNormalize(raw: string): string {
  return raw
    .replace(/\\left|\\right/g, '')
    .replace(/\\[,;:! ]/g, '')
    .replace(/\\dfrac|\\tfrac/g, '\\frac')
    .replace(/\s+/g, '');
}

export function normalizeLatex(raw: string): NormalizedLatex {
  try {
    const ast = parseLatex(raw);
    return {
      canonical: printNode(ast),
      commutative: printNode(ast, { commutative: true }),
      value: evaluate(ast),
      ast,
    };
  } catch {
    const f = fallbackNormalize(raw);
    return { canonical: f, commutative: f, value: null, ast: null };
  }
}

export interface LatexEquivalenceOptions {
  numericEquivalence?: boolean;
  commutative?: boolean;
  ignoreVariableAssignment?: boolean;
  tolerance?: number;
}

/** Strips "x =" from "x = expr" (single variable on the left of a single '='). */
function unassign(n: NormalizedLatex): NormalizedLatex {
  const ast = n.ast;
  if (ast && ast.k === 'rel' && ast.ops.length === 1 && ast.ops[0] === '=' && ast.parts[0]!.k === 'var') {
    const rhs = ast.parts[1]!;
    return { canonical: printNode(rhs), commutative: printNode(rhs, { commutative: true }), value: evaluate(rhs), ast: rhs };
  }
  return n;
}

export function areLatexEquivalent(a: string, b: string, o: LatexEquivalenceOptions = {}): boolean {
  let na = normalizeLatex(a);
  let nb = normalizeLatex(b);
  if (o.ignoreVariableAssignment) { na = unassign(na); nb = unassign(nb); }
  if (na.canonical === nb.canonical) return true;
  if (o.commutative && na.commutative === nb.commutative) return true;
  if (o.numericEquivalence && na.value !== null && nb.value !== null && Number.isFinite(na.value) && Number.isFinite(nb.value)) {
    const tol = o.tolerance ?? 1e-9 * Math.max(1, Math.abs(nb.value));
    return Math.abs(na.value - nb.value) <= tol;
  }
  return false;
}
