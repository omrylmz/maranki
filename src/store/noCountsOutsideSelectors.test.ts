/**
 * Guard test: no counts outside the selectors (unit W5-2; spec §4.5 grep
 * guard, §4.6, §3.12 "Launch count === queue length" and "One scope for all
 * counts").
 *
 * The promise: every number on a Study button is `readyFor(scope).total`, and
 * the session that button opens is `buildSessionQueue` for the same scope.
 * Both live in src/domain/scope.ts, the ONE place that turns a scope into
 * cards, counts and queues; screens read them through the hooks in
 * src/store/selectors.ts (useReady, useDeckStatsMap, useSessionLength,
 * useScopePool …). A screen that counts by itself can show "Study 34" and
 * open 30 cards — the bug this program removed.
 *
 * WHAT THE GUARD CHECKS (`findCountViolations` below), in every .ts / .tsx
 * file under src/app and src/components (tests are not read):
 *   1. 'scheduler': no use of the scheduler's inside parts (src/domain/
 *      schedule.ts): SCHEDULER_NAMES. Only scope.ts calls them, so a screen
 *      cannot build its own queue or its own count.
 *   2. 'counter': no use of the scope.ts counters (COUNTER_NAMES: readyFor,
 *      buildSessionQueue, deckStatsMap). A screen reads them through
 *      selectors.ts. Pure helpers that must call one (the session's own
 *      queue, a memoized reader) are in COUNTER_ALLOW, each with its reason.
 *   3. 'cards-filter': no `.filter(…)` / `.reduce(…)` over the state's card
 *      list (`state.cards.filter(…)`), also through a local name for it:
 *      `const cards = state.cards`, `const { cards } = state`,
 *      `const cards = useStoreSelector((s) => s.cards)`. A count over a
 *      SCOPE goes through scopePool / readyFor; a lookup of one note's cards
 *      goes through scope.ts `cardLookupOf(cards).cardIdsByNote`.
 *
 * The file is parsed with the TypeScript compiler (`ts.createSourceFile`: the
 * syntax tree only, no type check), so comments and strings never count.
 * The two deleted counters of the old queue facade are guarded everywhere
 * under src/ by the W5-3 grep guard in src/domain/scope.test.ts.
 *
 * Limits (on purpose; the test stays fast): a `for … of` loop that counts is
 * not detected, and a helper that gets the state's cards as a PARAMETER
 * (`function f({ cards })`) is not followed — the caller passes them.
 */
import { describe, expect, test } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

/* ============================================================ detector */

/** The scheduler's inside parts (schedule.ts). Only scope.ts may use them. */
const SCHEDULER_NAMES = [
  'selectScheduled',
  'selectScheduledWithDue',
  'planQueue',
  'readyCounts',
  'allocateNew',
  'selectAhead',
  'selectPractice',
] as const;

/** The scope.ts counters. Screens read them through the selectors.ts hooks. */
const COUNTER_NAMES = ['readyFor', 'dueAndReadyFor', 'buildSessionQueue', 'deckStatsMap'] as const;

/**
 * Pure helpers (no React) that may call a scope.ts counter directly, by file
 * (relative to src/) → the counters it may call. Each one computes EXACTLY
 * the number or queue of the session its button opens, with the same call
 * the session makes — so the count is still the queue length.
 */
const COUNTER_ALLOW: Readonly<Record<string, readonly string[]>> = {
  // startSession: the session's own queue (the useState initializer's helper,
  // spec §4.5 "the session's useState initializer calls this"), articleQueue,
  // and keepGoingCounts: each Complete row's number is the length of the
  // queue that row opens (retry missed, study ahead, practice your hardest).
  'components/study/sessionLogic.ts': ['buildSessionQueue'],
  // listRowStats: a Today list row's "Study {n}" = readyFor({ list }).total
  // and its "{n} due" from the same scheduler run (dueAndReadyFor), read
  // through a memoOnInputs reader; upFirstCard: the first card of the queue
  // the hero's "Study {n}" opens.
  'components/today/todayLogic.ts': ['dueAndReadyFor', 'buildSessionQueue'],
  // articlePracticeCount: "Practice articles · {n}" — the same practice
  // queue the session builds for the Articles mode.
  'components/deck/deckPageLogic.ts': ['buildSessionQueue'],
};

/** The array methods that turn the card list into a count (or a filtered list). */
const FILTER_METHODS = new Set(['filter', 'reduce', 'reduceRight']);

type Rule = 'scheduler' | 'counter' | 'cards-filter';

/** One violation: where it is, which rule, and the start of the code. */
interface Violation {
  line: number;
  rule: Rule;
  code: string;
}

/** Remove the wrappers that do not change the value: `( … )`, `x as T`, `x!`, `x satisfies T`. */
function unwrap(node: ts.Expression): ts.Expression {
  let e = node;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isTypeAssertionExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/** The name a call calls: `f(…)` → 'f', `a.b.f(…)` → 'f'. */
function calleeName(call: ts.CallExpression): string | null {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/** What a local name refers to (only what this guard needs). */
type Binding =
  | { kind: 'value'; init: ts.Expression } // const cards = <init>
  | { kind: 'function'; fn: ts.FunctionDeclaration } // function cardsOf(s) {…}
  | { kind: 'cardsKey' } // const { cards } = …  /  const { cards: all } = …
  | { kind: 'other' }; // a parameter, an import, another destructured value …

/** Does a binding pattern declare `name`, and is it the `cards` key of an object pattern? */
function findInPattern(binding: ts.BindingName, name: string): 'cards' | 'other' | null {
  if (ts.isIdentifier(binding)) return binding.text === name ? 'other' : null;
  for (const el of binding.elements) {
    if (ts.isOmittedExpression(el)) continue;
    if (ts.isIdentifier(el.name) && el.name.text === name) {
      const key = el.propertyName ?? el.name;
      const isCardsKey = ts.isObjectBindingPattern(binding) && ts.isIdentifier(key) && key.text === 'cards';
      return isCardsKey ? 'cards' : 'other';
    }
    const inner = ts.isIdentifier(el.name) ? null : findInPattern(el.name, name);
    if (inner) return 'other'; // a nested pattern: not the state's own `cards` key
  }
  return null;
}

/**
 * What `name` refers to at `from`: the nearest declaration in an enclosing
 * block, function or the file. null = not declared in this file.
 */
function resolve(name: string, from: ts.Node): Binding | null {
  for (let n: ts.Node | undefined = from.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n) && n.parameters.some((p) => findInPattern(p.name, name) !== null)) {
      return { kind: 'other' };
    }
    const statements =
      ts.isSourceFile(n) || ts.isBlock(n) || ts.isModuleBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)
        ? n.statements
        : undefined;
    if (!statements) continue;
    for (const s of statements) {
      if (ts.isFunctionDeclaration(s) && s.name?.text === name) return { kind: 'function', fn: s };
      if (!ts.isVariableStatement(s)) continue;
      for (const d of s.declarationList.declarations) {
        const found = findInPattern(d.name, name);
        if (found === null) continue;
        if (ts.isIdentifier(d.name)) return d.initializer ? { kind: 'value', init: d.initializer } : { kind: 'other' };
        return found === 'cards' ? { kind: 'cardsKey' } : { kind: 'other' };
      }
    }
  }
  return null;
}

/** The expressions a function returns (its arrow body, or every `return x;` of its own body). */
function returnedExpressions(fn: ts.SignatureDeclaration): ts.Expression[] {
  const body = (fn as ts.FunctionLikeDeclaration).body;
  if (!body) return [];
  if (!ts.isBlock(body)) return [body];
  const out: ts.Expression[] = [];
  const collect = (n: ts.Node): void => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
    ts.forEachChild(n, collect);
  };
  ts.forEachChild(body, collect);
  return out;
}

/** Is this a function (written here, or named here) that returns the state's cards, like `(s) => s.cards`? */
function returnsStateCards(node: ts.Expression, depth: number): boolean {
  const e = unwrap(node);
  let fn: ts.SignatureDeclaration | null = null;
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) fn = e;
  else if (ts.isIdentifier(e)) {
    const b = resolve(e.text, e);
    if (b?.kind === 'function') fn = b.fn;
    else if (b?.kind === 'value') return returnsStateCards(b.init, depth + 1);
  }
  if (!fn) return false;
  const returned = returnedExpressions(fn);
  return returned.length > 0 && returned.some((r) => isStateCards(r, depth + 1));
}

/**
 * Is this expression the state's card list?
 *   state.cards · s.cards · engine.store.getState().cards · (state.cards ?? [])
 *   a local name for one: const cards = state.cards / const { cards } = state
 *   a selector hook that returns it: useStoreSelector((s) => s.cards), useStateV3(cardsOf)
 */
function isStateCards(node: ts.Expression, depth = 0): boolean {
  if (depth > 8) return false;
  const e = unwrap(node);
  if (ts.isPropertyAccessExpression(e)) return e.name.text === 'cards';
  if (ts.isElementAccessExpression(e)) {
    return ts.isStringLiteral(e.argumentExpression) && e.argumentExpression.text === 'cards';
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    const fallback = op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken;
    return fallback && isStateCards(e.left, depth + 1);
  }
  if (ts.isCallExpression(e)) {
    // useStoreSelector((s) => s.cards), useStateV3(cardsOf), useMemo(() => state.cards, …)
    return e.arguments.some((arg) => returnsStateCards(arg, depth + 1));
  }
  if (ts.isIdentifier(e)) {
    const b = resolve(e.text, e);
    if (b?.kind === 'cardsKey') return true;
    if (b?.kind === 'value') return isStateCards(b.init, depth + 1);
  }
  return false;
}

/** Is a name used as a VALUE (handed on to be called later), not called, declared or imported? */
function isValueUse(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isCallExpression(p)) return p.arguments.includes(id);
  if (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) return p.initializer === id;
  if (ts.isShorthandPropertyAssignment(p)) return true;
  if (ts.isArrayLiteralExpression(p) || ts.isJsxExpression(p)) return true;
  if (ts.isReturnStatement(p) || ts.isArrowFunction(p)) return true;
  return false;
}

const SCHEDULER = new Set<string>(SCHEDULER_NAMES);
const COUNTERS = new Set<string>(COUNTER_NAMES);

/**
 * Every violation in one file. `allowed` = the counters this file may call
 * (from COUNTER_ALLOW).
 *
 *   findCountViolations('a.tsx', 'const n = state.cards.filter((c) => c.flagged).length;')
 *     → [{ line: 1, rule: 'cards-filter', code: 'state.cards.filter((c) => c.flagged)' }]
 */
function findCountViolations(fileName: string, text: string, allowed: readonly string[] = []): Violation[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const out: Violation[] = [];
  const report = (rule: Rule, at: ts.Node) => {
    const line = sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1;
    const code = at.getText(sf).replace(/\s+/g, ' ');
    out.push({ line, rule, code: code.length > 90 ? `${code.slice(0, 87)}...` : code });
  };
  /** The rule a scheduler or counter name breaks here, or null. */
  const ruleFor = (name: string): Rule | null => {
    if (SCHEDULER.has(name)) return 'scheduler';
    if (COUNTERS.has(name) && !allowed.includes(name)) return 'counter';
    return null;
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      const rule = name === null ? null : ruleFor(name);
      if (rule) report(rule, n);
      const callee = unwrap(n.expression);
      if (
        name !== null &&
        FILTER_METHODS.has(name) &&
        ts.isPropertyAccessExpression(callee) &&
        isStateCards(callee.expression)
      ) {
        report('cards-filter', n);
      }
    } else if (ts.isIdentifier(n) && isValueUse(n)) {
      // `memoOnInputs(inputs, readyFor)`: handing a counter on is calling it later.
      const rule = ruleFor(n.text);
      if (rule) report(rule, n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/* ======================================================= detector tests */

/** The violations of a small snippet, as "line rule". */
function hits(code: string, allowed: readonly string[] = []): string[] {
  return findCountViolations('snippet.tsx', code, allowed).map((v) => `${v.line} ${v.rule}`);
}

describe('the detector finds a count outside the selectors', () => {
  test("the scheduler's inside parts, called or handed on", () => {
    const code = [
      `import { planQueue, readyCounts, selectScheduled } from '../../domain/schedule';`,
      `const sel = selectScheduled(pool, ctx);`,
      `const n = readyCounts(sel).total;`,
      `const queue = schedule.planQueue(sel);`,
      `const ahead = selectAhead(pool, ctx).length + selectPractice(pool, sort, ctx).length;`,
      `const pick = useMemo(() => pools.map(planQueue), [pools]);`,
    ].join('\n');
    expect(hits(code)).toEqual([
      '2 scheduler',
      '3 scheduler',
      '4 scheduler',
      '5 scheduler',
      '5 scheduler',
      '6 scheduler',
    ]);
  });

  test('a scope.ts counter in a file that is not allowed to call it', () => {
    const code = [
      `const n = readyFor(state, { decks: [id] }, ctx).total;`,
      `const len = buildSessionQueue({ kind: 'ahead', q }, state, ctx).length;`,
      `const rows = deckStatsMap(state, ctx);`,
      `const read = memoOnInputs(inputs, readyFor);`,
    ].join('\n');
    expect(hits(code)).toEqual(['1 counter', '2 counter', '3 counter', '4 counter']);
    // An allowed file may call only ITS counters.
    expect(hits(code, ['buildSessionQueue'])).toEqual(['1 counter', '3 counter', '4 counter']);
  });

  test('a filter or a reduce over the state cards, written out', () => {
    const code = [
      `const due = state.cards.filter((c) => isDueNow(c, now)).length;`,
      `const flagged = s.cards.reduce((n, c) => n + (c.flagged ? 1 : 0), 0);`,
      `const known = (state.cards ?? []).filter((c) => c.knownAt != null).length;`,
      `const fresh = engine.store.getState().cards?.filter((c) => c.reps === 0).length;`,
    ].join('\n');
    expect(hits(code)).toEqual(['1 cards-filter', '2 cards-filter', '3 cards-filter', '4 cards-filter']);
  });

  test('a filter over a local name for the state cards', () => {
    const code = [
      `const cards = state.cards;`,
      `const { notes, cards: all } = data;`,
      `const live = useStoreSelector((s) => s.cards);`,
      `const cardsOf = (s) => s.cards;`,
      `const mine = useStateV3(cardsOf);`,
      `function Screen() { const { cards } = useData(); return cards.filter((c) => c.fav).length; }`,
      `const a = cards.filter((c) => c.fav).length + all.filter(f).length;`,
      `const b = live.reduce((n) => n + 1, 0) + mine.filter(f).length;`,
    ].join('\n');
    expect(hits(code)).toEqual(['6 cards-filter', '7 cards-filter', '7 cards-filter', '8 cards-filter', '8 cards-filter']);
  });
});

describe('the detector allows the right way to count', () => {
  test('the selectors.ts hooks and the scope pool', () => {
    const code = [
      `const ready = useReady({ decks: [id] });`,
      `const length = useSessionLength({ kind: 'ahead', q });`,
      `const pool = scopePool(state, q, ctx, 'browse');`,
      `const notStarted = pool.filter((c) => life(c) === 'notStarted').length;`,
      `const total = state.cards.length;`,
      `const decks = state.decks.filter((d) => d.active);`,
    ].join('\n');
    expect(hits(code)).toEqual([]);
  });

  test('an allowed pure helper calls its counters', () => {
    const code = `export const upFirst = (s, now) => buildSessionQueue({ kind: 'scheduled', q: {} }, s, ctxOf(s, now))[0];`;
    expect(hits(code, ['buildSessionQueue'])).toEqual([]);
  });

  test('cards that are not the state cards: a prop, a parameter, a pool', () => {
    const code = [
      `function Rows({ cards }) { return cards.filter((c) => c.fav).length; }`,
      `function count(cards: Card[]) { return cards.filter((c) => c.fav).length; }`,
      `const rows = useScopePool(q).filter((c) => c.flagged);`,
      `const n = leaf.cards + 1;`,
    ].join('\n');
    expect(hits(code)).toEqual([]);
  });

  test('comments, strings, types and a property with the same name do not count', () => {
    const code = [
      `// planQueue(selectScheduled(scopePool(q, 'study')))`,
      `const doc = 'readyFor(scope).total and state.cards.filter(…)';`,
      `let counts: ReadyCounts;`,
      `const value = summary.readyCounts;`,
      `const obj = { readyFor: 3 };`,
    ].join('\n');
    expect(hits(code)).toEqual([]);
  });
});

/* ============================================================ the guard */

/** Every .ts / .tsx file (not a test) under `dir`. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('guard: src/app and src/components count only through selectors.ts (spec §4.5)', () => {
  const SRC = path.resolve(__dirname, '..');
  const files = [...sourceFiles(path.join(SRC, 'app')), ...sourceFiles(path.join(SRC, 'components'))];
  /** "components/today/todayLogic.ts" (always with "/", also on Windows). */
  const rel = (file: string) => path.relative(SRC, file).split(path.sep).join('/');

  test('no scheduler part, counter or card-list filter outside the allowed helpers', () => {
    // The walk really read the tree (a wrong path would pass with 0 files).
    expect(files.length).toBeGreaterThan(100);
    const found: string[] = [];
    for (const file of files) {
      const allowed = COUNTER_ALLOW[rel(file)] ?? [];
      for (const v of findCountViolations(file, fs.readFileSync(file, 'utf8'), allowed)) {
        found.push(`${rel(file)}:${v.line} ${v.rule}: ${v.code}`);
      }
    }
    // A hit here counts cards outside the one scope. Read the number through
    // a selectors.ts hook (useReady, useSessionLength, useScopePool …) or a
    // scope.ts function. Add a pure helper to COUNTER_ALLOW only with a
    // reason; never to make a screen's own count pass.
    expect(found).toEqual([]);
  });

  test('every allowed helper exists and still calls each counter it is allowed (no stale entries)', () => {
    for (const [file, names] of Object.entries(COUNTER_ALLOW)) {
      const full = path.join(SRC, file);
      expect(fs.existsSync(full)).toBe(true);
      const used = new Set(findCountViolations(full, fs.readFileSync(full, 'utf8')).map((v) => v.code));
      for (const name of names) {
        expect([...used].some((code) => code.startsWith(`${name}(`) || code === name)).toBe(true);
      }
    }
  });
});
