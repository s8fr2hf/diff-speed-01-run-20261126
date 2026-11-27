// Fast drop-in for makefun-diff 1.0.0 (MIT, derived from jsdiff 9.0.0's Myers
// line diff): run(input) returns make.fun's own patch of { old, new }, exactly
// as the reference does, but faster.
//
// The reference's rule, restated: cut each text after every "\n" (a "\r" is
// part of its line; a last line with no "\n" is a line too), keep the common
// prefix then the common suffix, and between them run Myers's greedy search
// which keeps, on each diagonal, the path reaching furthest into the old text
// and takes the deletion when a deletion and an insertion reach the same
// point, never moves past either text's end, prunes no edge diagonal, and
// follows every run of equal lines as far as it goes. The patch then groups
// change runs into hunks with up to 3 kept lines of context, runs at most 6
// kept lines apart sharing a hunk, and marks a line with no trailing newline
// with a "%" line. Identical texts are the header line alone.
//
// Speed comes from three changes, none of which changes the answer:
//  1. Lines are interned to small integers once per case, so every line
//     comparison in the search is an integer comparison.
//  2. The search keeps its furthest-reached x per (d, k) in one flat
//     Int32Array (row d starts at d*d, column k at k+d), instead of one
//     linked-list path object per diagonal per step. The edit script is
//     rebuilt by walking the rows back down, re-deciding each step with
//     exactly the reference's candidate rules and tie-break.
//  3. No objects are allocated inside the search loop at all.

const FORMAT = 'makefun-diff/1';
const CONTEXT = 3;
const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/** A text's lines, each with its "\n" (the last one without, when the text does not end in one). */
function tokenize(text) {
  const parts = text.split('\n');
  const lines = new Array(parts.length);
  const last = parts.length - 1;
  for (let i = 0; i < last; i++) lines[i] = parts[i] + '\n';
  if (parts[last] !== '') lines[last] = parts[last];
  else lines.length = last;
  return lines;
}

/** A line as the patch writes it: its op, the line, a newline, and "%" on a line of its own when it had none. */
function written(op, line) {
  return line.endsWith('\n') ? op + line : op + line + '\n%\n';
}

/**
 * The edit script of the middle slices A (length n) into B (length m), as
 * runs [{ kind, count }] in order, following the reference's rule exactly.
 * A and B hold interned line ids; equality of ids is equality of lines.
 */
function editRuns(A, n, B, m) {
  // Row d of the history starts at d*d and holds 2d+1 entries, column k at
  // index k+d. Every entry of a row is written when the row is computed (a
  // NONE where no path reaches it), so no entry is ever read before it is
  // written and the array needs no pre-fill. x fits in 16 bits while the
  // texts are under 65,535 lines (this competition's are 20,000-40,000),
  // which halves the history's memory traffic; longer texts fall back to
  // 32-bit entries.
  const use16 = n < 65535 && m < 65535;
  const NONE = use16 ? 65535 : -1;
  let hist = use16 ? new Uint16Array(4096 * 4096) : new Int32Array(4096 * 4096);
  let capD = 4095;
  const ensure = (d) => {
    if (d <= capD) return;
    let nc = capD;
    while (d > nc) nc = nc * 2 + 1;
    const nh = use16 ? new Uint16Array((nc + 1) * (nc + 1)) : new Int32Array((nc + 1) * (nc + 1));
    nh.set(hist);
    hist = nh;
    capD = nc;
  };
  // d = 0: the snake from (0, 0) along diagonal 0.
  let x = 0;
  let y = 0;
  while (x < n && y < m && A[x] === B[y]) { x++; y++; }
  hist[0] = x;
  if (x >= n && y >= m) return [];
  let foundD = -1;
  let foundK = 0;
  outer: for (let d = 1; d <= n + m; d++) {
    ensure(d);
    const base = d * d;
    const prev = (d - 1) * (d - 1);
    // pi walks row d-1 two entries at a time: the deletion candidate is the
    // entry at pi (diagonal k-1, present when k > -d) and the insertion
    // candidate the entry at pi+2 (diagonal k+1, present when k < d). bi
    // walks this row's entries. pi starts two below the row so that at the
    // first diagonal (k = -d) pi+2 is the row's first entry.
    let pi = prev - 2;
    let bi = base;
    for (let k = -d; k <= d; k += 2) {
      const xDel = k > -d ? hist[pi] : NONE;
      const xIns = k < d ? hist[pi + 2] : NONE;
      // The reference's candidates: a deletion is possible while an old
      // line is left on the diagonal below, an insertion while a new line
      // is left on the diagonal above.
      const canR = xDel !== NONE && xDel < n;
      const canA = xIns !== NONE && xIns - k - 1 < m;
      if (!canR && !canA) {
        hist[bi] = NONE;
      } else {
        // Furthest into the old text wins; a tie goes to the deletion. The
        // two moves reach xDel+1 and xIns, so the larger of the two is the
        // winner, and on a tie both reach the same point.
        const xd = canR ? xDel + 1 : -1;
        const xi = canA ? xIns : -1;
        x = xd >= xi ? xd : xi;
        y = x - k;
        while (x < n && y < m && A[x] === B[y]) { x++; y++; }
        hist[bi] = x;
        if (x >= n && y >= m) {
          foundD = d;
          foundK = k;
          break outer;
        }
      }
      pi += 2;
      bi += 2;
    }
  }
  if (foundD < 0) throw new Error('makefun-diff: the search ended without reaching both ends');

  // Walk the rows back down, re-deciding each step with the same rules.
  // ops holds single ops in reverse, merged into runs as they are pushed.
  const ops = [];
  const pushRev = (kind) => {
    const last = ops[ops.length - 1];
    if (last !== undefined && last.kind === kind) last.count++;
    else ops.push({ kind, count: 1 });
  };
  let d = foundD;
  let k = foundK;
  x = hist[d * d + k + d];
  while (d > 0) {
    const prev = (d - 1) * (d - 1);
    // The step into (d, k) came from diagonal k-1 (a deletion) or k+1 (an
    // insertion) of row d-1, at indices 2j-2 and 2j where j = (k+d)/2.
    const j = (k + d) >> 1;
    const xDel = j > 0 ? hist[prev + 2 * j - 2] : NONE;
    const xIns = j < d ? hist[prev + 2 * j] : NONE;
    const canR = xDel !== NONE && xDel < n;
    const canA = xIns !== NONE && xIns - k - 1 < m;
    let prevK;
    let prevX;
    let snakeStartX;
    let isDel;
    if (canR && (!canA || xDel + 1 >= xIns)) {
      isDel = true;
      prevK = k - 1;
      prevX = xDel;
      snakeStartX = xDel + 1;
    } else {
      isDel = false;
      prevK = k + 1;
      prevX = xIns;
      snakeStartX = xIns;
    }
    const keeps = x - snakeStartX;
    for (let i = 0; i < keeps; i++) pushRev(KEEP);
    pushRev(isDel ? DELETE : INSERT);
    x = prevX;
    k = prevK;
    d--;
  }
  for (let i = 0; i < x; i++) pushRev(KEEP);
  ops.reverse();
  return ops;
}

/** make.fun's own patch of input.old into input.new (the reference's rule). */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const a = tokenize(input.old);
  const b = tokenize(input.new);
  const n = a.length;
  const m = b.length;

  // Intern both texts' lines to integers (one map per case, nothing kept
  // from one case to the next).
  const ids = new Map();
  let nextId = 0;
  const A = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const s = a[i];
    let id = ids.get(s);
    if (id === undefined) {
      id = nextId++;
      ids.set(s, id);
    }
    A[i] = id;
  }
  const B = new Int32Array(m);
  for (let i = 0; i < m; i++) {
    const s = b[i];
    let id = ids.get(s);
    if (id === undefined) {
      id = nextId++;
      ids.set(s, id);
    }
    B[i] = id;
  }

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && A[prefix] === B[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && A[n - 1 - suffix] === B[m - 1 - suffix]) suffix++;

  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  const midN = n - prefix - suffix;
  const midM = m - prefix - suffix;
  if (midN > 0 || midM > 0) {
    runs.push(...editRuns(A.subarray(prefix, n - suffix), midN, B.subarray(prefix, m - suffix), midM));
  }
  if (suffix > 0) runs.push({ kind: KEEP, count: suffix });

  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', a[at]));
      for (let i = 0; i < c.dels; i++) out.push(written('-', a[c.o + i]));
      for (let i = 0; i < c.ins; i++) out.push(written('+', b[c.p + i]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', a[at]));
  }
  return out.join('');
}
