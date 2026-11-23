// mend applies an edit that an AI model wrote to a tree of text files, in four
// formats (SPEC.md): unified diffs (often with wrong line numbers), SEARCH/REPLACE
// blocks, the V4A patch format, and text-editor tool calls as JSON. Every file
// is changed or nothing is: one edit failing leaves the tree untouched, and
// the edits after it still run so every failure is reported. Node 22, the
// standard library alone; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Moves that succeeded, for the `R old -> new` output lines (SPEC.md section 2). */
const moves: { old: string; nw: string }[] = [];

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Files, lines and matching (SPEC.md sections 3 and 5)
// ---------------------------------------------------------------------------

interface FileState {
  lines: string[];
  br: string;
  end: boolean;
}

/** Split a file's text into its lines, its line break and whether it ends with one. */
function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', end: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let end = false;
  if (text.endsWith(br)) {
    parts.pop();
    end = true;
  }
  return { lines: parts, br, end };
}

function serializeFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.end ? s.br : '');
}

/** A file an edit creates: LF breaks, ending with one unless the format says otherwise. */
function createdText(lines: string[], end: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (end ? '\n' : '');
}

const rtrimWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimWS(a) === rtrimWS(b);
  return trimWS(a) === trimWS(b);
}

/** Every 0-based position where O occurs in lines at one tier; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs at least once. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hunk and chunk bodies (SPEC.md sections 6 and 8)
// ---------------------------------------------------------------------------

interface BodyEntry {
  text: string;
  ctx: boolean;
}

interface ParsedBody {
  /** Old lines: context and `-` lines, in body order. */
  o: BodyEntry[];
  /** New lines: context and `+` lines, in body order; a context line's oIndex is its place in o. */
  n: { text: string; ctx: boolean; oIndex: number }[];
  /** `+` lines, in body order, with whether a `\` line follows each. */
  plus: { text: string; backslash: boolean }[];
  /** Whether a `\` line follows the body's last context or `+` line. */
  backslashAfterLastCtxPlus: boolean;
}

function parseBody(body: string[]): ParsedBody {
  interface Item {
    kind: 'ctx' | 'old' | 'new';
    text: string;
    backslash: boolean;
  }
  const items: Item[] = [];
  for (const l of body) {
    if (l.startsWith('\\')) {
      if (items.length > 0) items[items.length - 1]!.backslash = true;
      continue;
    }
    if (l === '') items.push({ kind: 'ctx', text: '', backslash: false });
    else if (l[0] === ' ') items.push({ kind: 'ctx', text: l.slice(1), backslash: false });
    else if (l[0] === '-') items.push({ kind: 'old', text: l.slice(1), backslash: false });
    else items.push({ kind: 'new', text: l.slice(1), backslash: false });
  }
  const o: BodyEntry[] = [];
  for (const it of items) {
    if (it.kind === 'ctx' || it.kind === 'old') o.push({ text: it.text, ctx: it.kind === 'ctx' });
  }
  const oCtxIndex: number[] = [];
  for (let i = 0; i < o.length; i++) if (o[i]!.ctx) oCtxIndex.push(i);
  const n: { text: string; ctx: boolean; oIndex: number }[] = [];
  const plus: { text: string; backslash: boolean }[] = [];
  let k = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      n.push({ text: it.text, ctx: true, oIndex: oCtxIndex[k]! });
      k++;
    } else if (it.kind === 'new') {
      n.push({ text: it.text, ctx: false, oIndex: -1 });
      plus.push({ text: it.text, backslash: it.backslash });
    }
  }
  let backslashAfterLastCtxPlus = false;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === 'ctx' || it.kind === 'new') {
      backslashAfterLastCtxPlus = it.backslash;
      break;
    }
  }
  return { o, n, plus, backslashAfterLastCtxPlus };
}

/**
 * The new lines as written: a context line is the file's own matched line, never
 * the patch's; at tier 2 every other line is re-indented from O's first line to
 * the file's first matched line. oFirst is O's first line.
 */
function mapN(
  n: { text: string; ctx: boolean; oIndex: number }[],
  fileLines: string[],
  pos: number,
  oFirst: string,
  tier: number,
): string[] {
  const out: string[] = [];
  for (const e of n) {
    if (e.ctx) {
      out.push(fileLines[pos + e.oIndex]!);
      continue;
    }
    if (tier === 2) {
      const f = leadWS(fileLines[pos]!);
      const p = leadWS(oFirst);
      const t = e.text;
      if (t !== '' && !/^[ \t]*$/.test(t) && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(e.text);
    }
  }
  return out;
}

interface Hunk {
  a: number;
  body: string[];
}

/** Apply a section's hunks in order to a file's state, or throw a Fail. */
function applyHunks(state: FileState, hunks: Hunk[], strict: boolean, failPath: string): void {
  let d = 0;
  for (const h of hunks) {
    const { o, n, backslashAfterLastCtxPlus } = parseBody(h.body);
    const oTexts = o.map((e) => e.text);
    if (oTexts.length === 0) {
      const idx = Math.min(h.a + d, state.lines.length);
      const atEnd = idx === state.lines.length;
      const mapped = n.map((e) => e.text);
      state.lines.splice(idx, 0, ...mapped);
      if (atEnd) state.end = !backslashAfterLastCtxPlus;
      d += mapped.length;
    } else {
      const found = findTier(state.lines, oTexts, strict);
      if (found === null) throw new Fail('no-match', failPath);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const oldLen = state.lines.length;
      const mapped = mapN(n, state.lines, best, oTexts[0]!, found.tier);
      state.lines.splice(best, oTexts.length, ...mapped);
      if (best + oTexts.length === oldLen) state.end = !backslashAfterLastCtxPlus;
      d += mapped.length - oTexts.length;
    }
  }
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path after `--- `/`+++ `: up to the first tab, spaces removed, a/ or b/ removed. */
function parseDiffPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

/** An edit that creates a file from a unified diff's hunks (fails if it exists). */
function makeCreate(p: string, hunks: Hunk[]): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.now.set(p, createdFromHunks(hunks));
  };
}

/** An edit that deletes a file (fails if it is missing). */
function makeDelete(p: string): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  interface Sec {
    pairOld?: string | null;
    pairNew?: string | null;
    renFrom?: string;
    renTo?: string;
    diffOld?: string;
    diffNew?: string;
    newFile: boolean;
    delFile: boolean;
    hunks: Hunk[];
  }
  const sections: Sec[] = [];
  let cur: Sec | null = null;
  let header = false;
  const startSection = (): Sec => {
    const s: Sec = { newFile: false, delFile: false, hunks: [] };
    sections.push(s);
    cur = s;
    header = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          body.push(b);
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a, body });
      header = false;
      continue;
    }
    if (cur !== null && header) {
      if (l.startsWith('--- ')) {
        if (i + 1 >= lines.length || !lines[i + 1]!.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.pairOld = parseDiffPath(l);
        cur.pairNew = parseDiffPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renFrom = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renTo = l.slice(10).trim();
        i++;
        continue;
      }
      if (l === 'new file mode' || l.startsWith('new file mode ')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        cur.delFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s = startSection();
      s.pairOld = parseDiffPath(l);
      s.pairNew = parseDiffPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    i++;
  }

  const edits: Edit[] = [];
  for (const s of sections) {
    const oldP = s.pairOld !== undefined ? s.pairOld : s.renFrom !== undefined ? s.renFrom : s.diffOld;
    const newP = s.pairNew !== undefined ? s.pairNew : s.renTo !== undefined ? s.renTo : s.diffNew;
    const hunks = s.hunks;
    const isC = oldP === null || s.newFile;
    const isD = newP === null || s.delFile;
    if (isC && isD) {
      if (typeof newP === 'string') {
        edits.push(makeCreate(newP, hunks));
      } else if (typeof oldP === 'string') {
        edits.push(makeDelete(oldP));
      } else {
        edits.push(() => {
          throw new Fail('unsafe', '');
        });
      }
    } else if (isC) {
      edits.push(makeCreate(newP as string, hunks));
    } else if (isD) {
      edits.push(makeDelete(oldP as string));
    } else if (oldP !== newP) {
      const op = oldP as string;
      const np = newP as string;
      edits.push((tree) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (!safe(np)) throw new Fail('unsafe', np);
        const curText = tree.get(op);
        if (curText === null) throw new Fail('missing', op);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const state = parseFile(curText);
        applyHunks(state, hunks, strict, op);
        tree.now.set(np, serializeFile(state));
        tree.now.set(op, null);
        moves.push({ old: op, nw: np });
      });
    } else {
      const p = oldP as string;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const curText = tree.get(p);
        if (curText === null) throw new Fail('missing', p);
        const state = parseFile(curText);
        applyHunks(state, hunks, strict, p);
        tree.now.set(p, serializeFile(state));
      });
    }
  }
  return edits;
}

/** A created file is the `+` lines of all its hunks, in order. */
function createdFromHunks(hunks: Hunk[]): string {
  const plus: string[] = [];
  let end = true;
  let any = false;
  for (const h of hunks) {
    const parsed = parseBody(h.body);
    for (const pl of parsed.plus) {
      plus.push(pl.text);
      any = true;
      end = !pl.backslash;
    }
  }
  return createdText(plus, any ? end : true);
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i;
      let path: string | null = null;
      for (let j = i - 1; j > prevEnd; j--) {
        const t = lines[j]!.trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath !== null) path = prevPath;
        else throw new Exit2(`error: parse ${searchLine + 1}`);
      }
      let eq = -1;
      for (let k = i + 1; k < lines.length; k++) {
        if (lines[k]!.trimEnd() === '=======') {
          eq = k;
          break;
        }
      }
      if (eq === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
      let end = -1;
      for (let k = eq + 1; k < lines.length; k++) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          end = k;
          break;
        }
      }
      if (end === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
      const oldLines = lines.slice(i + 1, eq);
      const newLines = lines.slice(eq + 1, end);
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (oldLines.length === 0) {
          if (tree.get(p) !== null) throw new Fail('exists', p);
          tree.now.set(p, createdText(newLines, true));
          return;
        }
        const curText = tree.get(p);
        if (curText === null) throw new Fail('missing', p);
        const state = parseFile(curText);
        const found = findTier(state.lines, oldLines, strict);
        if (found === null) throw new Fail('no-match', p);
        if (found.occ.length > 1) throw new Fail('ambiguous', p);
        const pos = found.occ[0]!;
        const nEntries = newLines.map((t) => ({ text: t, ctx: false, oIndex: -1 }));
        const mapped = mapN(nEntries, state.lines, pos, oldLines[0]!, found.tier);
        state.lines.splice(pos, oldLines.length, ...mapped);
        tree.now.set(p, serializeFile(state));
      });
      prevPath = p;
      prevEnd = end;
      i = end + 1;
    } else {
      i++;
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      const kind = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'del' : 'upd';
      const path = l.slice(kind === 'add' ? 14 : 17).trim();
      const startLine = i;
      i++;
      const raw: number[] = [];
      while (i < last) {
        const m = lines[i]!;
        if (m.startsWith('*** Add File: ') || m.startsWith('*** Delete File: ') || m.startsWith('*** Update File: ')) break;
        raw.push(i);
        i++;
      }
      while (raw.length > 0 && blank(lines[raw[raw.length - 1]!]!)) raw.pop();
      if (kind === 'add') {
        const fileLines: string[] = [];
        for (const idx of raw) {
          const m = lines[idx]!;
          if (m === '') fileLines.push('');
          else if (m[0] === '+') fileLines.push(m.slice(1));
          else throw new Exit2(`error: parse ${idx + 1}`);
        }
        const p = path;
        edits.push((tree) => {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (tree.get(p) !== null) throw new Fail('exists', p);
          tree.now.set(p, createdText(fileLines, true));
        });
      } else if (kind === 'del') {
        for (const idx of raw) {
          if (!blank(lines[idx]!)) throw new Exit2(`error: parse ${idx + 1}`);
        }
        const p = path;
        edits.push((tree) => {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (tree.get(p) === null) throw new Fail('missing', p);
          tree.now.set(p, null);
        });
      } else {
        edits.push(parseV4AUpdate(path, raw, lines, startLine, strict));
      }
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function parseV4AUpdate(path: string, raw: number[], lines: string[], startLine: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (idx < raw.length && lines[raw[idx]!]!.startsWith('*** Move to: ')) {
    moveTo = lines[raw[idx]!]!.slice(12).trim();
    idx++;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  const openChunk = (anchor: string | null): VChunk => {
    const c: VChunk = { anchor, eof: false, body: [] };
    chunks.push(c);
    return c;
  };
  while (idx < raw.length) {
    const li = raw[idx]!;
    const m = lines[li]!;
    if (m.startsWith('@@')) {
      const anchor = m.slice(2).trim();
      cur = openChunk(anchor === '' ? null : anchor);
      idx++;
      continue;
    }
    if (m === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${li + 1}`);
      cur.eof = true;
      cur = null;
      idx++;
      continue;
    }
    if (m === '' || m[0] === ' ' || m[0] === '-' || m[0] === '+') {
      if (cur === null) {
        if (chunks.length === 0) cur = openChunk(null);
        else throw new Exit2(`error: parse ${li + 1}`);
      }
      cur.body.push(m);
      idx++;
      continue;
    }
    throw new Exit2(`error: parse ${li + 1}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine + 1}`);
  const p = path;
  const mt = moveTo;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
    const curText = tree.get(p);
    if (curText === null) throw new Fail('missing', p);
    if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
    const state = parseFile(curText);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundIdx = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let k = cursor; k < state.lines.length; k++) {
            if (lineEq(state.lines[k]!, ch.anchor, t)) {
              foundIdx = k;
              break;
            }
          }
          if (foundIdx >= 0) break;
        }
        if (foundIdx < 0) throw new Fail('no-match', p);
        cursor = foundIdx + 1;
      }
      const { o, n } = parseBody(ch.body);
      const oTexts = o.map((e) => e.text);
      if (oTexts.length === 0) {
        const ins = ch.eof ? state.lines.length : cursor;
        const mapped = n.map((e) => e.text);
        state.lines.splice(ins, 0, ...mapped);
        cursor = ins + mapped.length;
      } else {
        let found: { tier: number; pos: number } | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          const occ = occurrences(state.lines, oTexts, t).filter(
            (pos) => pos >= cursor && (!ch.eof || pos + oTexts.length === state.lines.length),
          );
          if (occ.length > 0) {
            found = { tier: t, pos: occ[0]! };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', p);
        const mapped = mapN(n, state.lines, found.pos, oTexts[0]!, found.tier);
        state.lines.splice(found.pos, oTexts.length, ...mapped);
        cursor = found.pos + mapped.length;
      }
    }
    const out = serializeFile(state);
    if (mt !== null) {
      tree.now.set(mt, out);
      tree.now.set(p, null);
      moves.push({ old: p, nw: mt });
    } else {
      tree.now.set(p, out);
    }
  };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// The run (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  moves.length = 0;
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const m of moves) {
    if (movedOld.has(m.old) || movedNew.has(m.nw)) continue;
    const wasOld = tree.original(m.old);
    const nowOld = tree.now.has(m.old) ? tree.now.get(m.old)! : tree.original(m.old);
    const wasNew = tree.original(m.nw);
    const nowNew = tree.now.has(m.nw) ? tree.now.get(m.nw)! : tree.original(m.nw);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
      movedOld.add(m.old);
      movedNew.add(m.nw);
    }
  }
  for (const p of tree.now.keys()) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const changed = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...changed, `ok: ${changed.length} ${changed.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
