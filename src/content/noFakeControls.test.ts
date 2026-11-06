/**
 * Guard test: no fake controls (unit W5-2; spec §0 idea E, §7 last paragraph).
 *
 * A FAKE control is a button, row or toggle whose press does nothing real:
 * its handler ONLY shows a snackbar message ("Help center", "Coming soon").
 * Before wave 4 the app had about 15 of them (the spec §7 table). Every one
 * was built for real or removed. This test keeps it that way: it fails when
 * a fake control comes back.
 *
 * HOW THE DETECTOR WORKS (`findFakeControls` below)
 *   1. It reads every .ts and .tsx file under src/app and src/components as
 *      text (tests are not read) and parses it with the TypeScript compiler
 *      (`ts.createSourceFile`: the syntax tree only, no type check, so it is
 *      fast). Comments and strings are not code, so they never count.
 *   2. It finds every EVENT HANDLER: a JSX prop or an object property whose
 *      name is "on" + a capital letter — onPress, onLongPress, onChange,
 *      onSwitchMode, onAction … (more than the spec's onPress, so a fake
 *      behind a component's own prop or a fake toggle is caught too), except
 *      NOT_CONTROLS (see there).
 *   3. It follows the handler inside the SAME file: an inline arrow; a named
 *      handler (`const openHelp = () => …`, `function openHelp() {…}`,
 *      `useCallback(() => …, [])`); a local helper the handler calls; a
 *      factory, with its arguments (`onPress={go(() => show('Soon'))}` where
 *      `const go = (fn) => () => { onClose(); fn(); }`); a timer around the
 *      message (`setTimeout(() => show(…), 0)`); a `cond ? a : b` handler.
 *   4. A handler is FAKE when it makes at least one snackbar call and no
 *      other effect.
 *        - A snackbar call: `show(…)` (useSnackbar), `onSnack(…)`,
 *          `setSnack(…)`, or `x.show(…)` on an object named like "snack".
 *          `setSnack(null)` CLOSES a message: that is a real effect.
 *          Its arguments are looked into as well, because real work can
 *          hide in the message: `show(deleteBackup(x) ? 'Deleted' : 'Failed')`.
 *          A function written inside them (an Undo action) only runs later,
 *          so it does not make the press real.
 *        - Another effect: any other call (`actions.restore(…)`,
 *          `router.push(…)`, `setSheet('mode')`), `new …`, an assignment,
 *          `++` / `--`, `delete`.
 *        - NOT an effect:
 *            building the message text (`plural(…)`, `String(…)`,
 *            `n.toLocaleString()` … — FORMAT_CALLS, FORMAT_METHODS);
 *            pure feedback (`haptics(…)`, `console.*`, a screen-reader
 *            announcement — isFeedbackCall): a buzz and a message are
 *            still fake;
 *            closing the menu the button is in (`onClose()`, `close()`,
 *            `setSheet(null)`, `setOpen(false)` — isCloseCall): the old
 *            fakes were exactly "close the sheet, then show a message"
 *            (spec §7 #1 Reschedule, #2 Switch mode). A `close` helper
 *            written in the same file is looked into instead, so a close
 *            that also saves is real.
 *      With `cond ? a : b`, the handler is fake only when EVERY branch is
 *      fake: a button that works in one state and explains itself in the
 *      other is a real button.
 *
 * Limits (on purpose; the test stays fast and readable): a handler passed IN
 * as a prop is checked in the file that writes it (that file has the
 * `on…={…}` prop too); a function of another file is not followed (a call
 * to it counts as a real effect); and a handler that does real work in one
 * `if` branch and only shows a message in another is real (a guard message
 * such as "Pick a deck first" must stay possible).
 */
import { describe, expect, test } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

/* ============================================================ detector */

/** The snackbar functions: calling one only shows a message. */
const SNACK_CALLS = new Set(['show', 'onSnack', 'setSnack']);

/**
 * Event names that are NOT controls, so a handler that only shows a message
 * is right for them. They are not checked:
 *   - onSnack:  the snackbar channel itself (a component hands a message up
 *               to the screen that draws the snackbar);
 *   - onError:  something failed — telling the learner is the whole job;
 *   - onSaved:  a child sheet saved a list — the parent may only say so;
 *   - onDone:   a child sheet finished its work (RescheduleSheet, FacetSheet);
 *   - onClosed: a sheet's close animation ended.
 * A new name here needs the same kind of reason: it REPORTS something that
 * already happened. A COMMAND (onPress, onRestore, onSwitchMode …) never
 * belongs here.
 */
const NOT_CONTROLS = new Set(['onSnack', 'onError', 'onSaved', 'onDone', 'onClosed']);

/** Calls that only build the message text: they are not an effect. */
const FORMAT_CALLS = new Set(['plural', 'String', 'Number', 'Boolean']);
const FORMAT_METHODS = new Set([
  'toLocaleString',
  'toFixed',
  'toString',
  'trim',
  'join',
  'toUpperCase',
  'toLowerCase',
  'padStart',
  'padEnd',
]);

/** Calls that only close the menu or sheet the control is in: not a real effect. */
const CLOSE_CALLS = new Set(['close', 'onClose', 'closeSheet', 'closeMenu', 'dismiss', 'onDismiss', 'hide']);
/** `setSheet(null)`, `setOpen(false)`, `setMenuOpen(false)`: a state setter of something that is shown. */
const SHOWN_SETTER = /^set\w*(Open|Sheet|Menu|Visible|Shown|Modal)$/;

/** Calls that run a function later: the function is looked into, as if it ran now. */
const DEFERRED_CALLS = new Set([
  'setTimeout',
  'setImmediate',
  'requestAnimationFrame',
  'queueMicrotask',
  'runAfterInteractions',
]);

/** One fake control: where it is and the start of its code. */
interface FakeControl {
  line: number;
  event: string;
  code: string;
}

type FunctionNode = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration;

/**
 * The arguments a factory or helper was called with, by parameter name. With
 * `const go = (fn) => () => { onClose(); fn(); }` and `go(() => show('x'))`,
 * the inner `fn()` is `() => show('x')`.
 */
type Env = ReadonlyMap<string, ts.Expression>;
const NO_ENV: Env = new Map();

/** What a name refers to in its file. */
type Binding =
  | { kind: 'function'; fn: FunctionNode } // function openHelp() {…}
  | { kind: 'value'; init: ts.Expression } // const openHelp = <init>
  | { kind: 'other' }; // a parameter (a prop), a destructured value, an import …

/** How many snackbar calls and how many other effects a piece of code makes. */
interface Tally {
  snacks: number;
  effects: number;
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

function isFunctionNode(node: ts.Node): node is FunctionNode {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** `null` or `undefined`: "no handler" / "no value". */
function isNothing(node: ts.Expression): boolean {
  const e = unwrap(node);
  return e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined');
}

/** `false`, `null` or `undefined`: the "hide it" value of a state setter. */
function isOffValue(node: ts.Expression): boolean {
  return isNothing(node) || unwrap(node).kind === ts.SyntaxKind.FalseKeyword;
}

/** Does a binding pattern (`{ a, b: c }`, `[x, setX]`) or a name declare `name`? */
function bindsName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some((el) => !ts.isOmittedExpression(el) && bindsName(el.name, name));
}

/** Does an import declaration bring in `name`? */
function importsName(decl: ts.ImportDeclaration, name: string): boolean {
  const clause = decl.importClause;
  if (!clause) return false;
  if (clause.name?.text === name) return true;
  const bindings = clause.namedBindings;
  if (!bindings) return false;
  if (ts.isNamespaceImport(bindings)) return bindings.name.text === name;
  return bindings.elements.some((el) => el.name.text === name);
}

/**
 * What `name` refers to at `from`: the nearest declaration in an enclosing
 * block, function or the file (the JavaScript scope rules, simplified).
 * null = not declared in this file (a global such as `setTimeout`).
 */
function resolve(name: string, from: ts.Node): Binding | null {
  for (let n: ts.Node | undefined = from.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n) && n.parameters.some((p) => bindsName(p.name, name))) return { kind: 'other' };
    const statements =
      ts.isSourceFile(n) || ts.isBlock(n) || ts.isModuleBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)
        ? n.statements
        : undefined;
    if (!statements) continue;
    for (const s of statements) {
      if (ts.isFunctionDeclaration(s) && s.name?.text === name) return { kind: 'function', fn: s };
      if (ts.isImportDeclaration(s) && importsName(s, name)) return { kind: 'other' };
      if (!ts.isVariableStatement(s)) continue;
      for (const d of s.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name) {
          return d.initializer ? { kind: 'value', init: d.initializer } : { kind: 'other' };
        }
        if (!ts.isIdentifier(d.name) && bindsName(d.name, name)) return { kind: 'other' };
      }
    }
  }
  return null;
}

/** The name a call calls: `f(…)` → 'f', `a.b.f(…)` → 'f'. */
function calleeName(call: ts.CallExpression): string | null {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/**
 * The function an expression stands for, when it is written in this file:
 * an arrow, `function () {}`, `useCallback(fn, deps)`, a name bound to one,
 * or a factory parameter bound in `env`.
 */
function functionOf(node: ts.Expression, env: Env, depth = 0): FunctionNode | null {
  if (depth > 8) return null;
  const e = unwrap(node);
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return e;
  if (ts.isCallExpression(e) && calleeName(e) === 'useCallback' && e.arguments[0]) {
    return functionOf(e.arguments[0], env, depth + 1);
  }
  if (ts.isIdentifier(e)) {
    const arg = env.get(e.text);
    if (arg) return functionOf(arg, NO_ENV, depth + 1);
    const b = resolve(e.text, e);
    if (b?.kind === 'function') return b.fn;
    if (b?.kind === 'value') return functionOf(b.init, NO_ENV, depth + 1);
  }
  return null;
}

/**
 * `env` plus the parameters of `fn` bound to the call's arguments (simple
 * names only). An argument that is itself a bound parameter is looked up first.
 */
function bindArgs(fn: FunctionNode, args: readonly ts.Expression[], env: Env): Env {
  const next = new Map(env);
  fn.parameters.forEach((p, i) => {
    const arg = args[i];
    if (!ts.isIdentifier(p.name) || !arg) return;
    const a = unwrap(arg);
    next.set(p.name.text, ts.isIdentifier(a) && env.has(a.text) ? env.get(a.text)! : arg);
  });
  return next;
}

/** A call that shows a snackbar message (not one that closes it). */
function isSnackCall(call: ts.CallExpression, env: Env): boolean {
  const callee = unwrap(call.expression);
  let snack = false;
  if (ts.isIdentifier(callee) && SNACK_CALLS.has(callee.text)) {
    // A LOCAL function that happens to be called "show" is not the snackbar:
    // the caller looks into it like any other helper.
    snack = functionOf(callee, env) === null;
  } else if (ts.isPropertyAccessExpression(callee)) {
    const name = callee.name.text;
    snack = name === 'onSnack' || name === 'setSnack' || (name === 'show' && /snack/i.test(callee.expression.getText()));
  }
  if (!snack) return false;
  // `setSnack(null)` hides the message: a real effect (a close button).
  const first = call.arguments[0];
  return !(first !== undefined && isNothing(first));
}

/** A call that is only feedback: a haptic buzz, a log line, a screen-reader announcement. */
function isFeedbackCall(call: ts.CallExpression): boolean {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return /^haptic/i.test(callee.text);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const owner = callee.expression.getText();
  return (
    owner === 'console' ||
    /^haptics?$/i.test(owner) ||
    (owner === 'AccessibilityInfo' && callee.name.text === 'announceForAccessibility')
  );
}

/** A call that only formats text or numbers (the message). */
function isFormatCall(call: ts.CallExpression): boolean {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return FORMAT_CALLS.has(callee.text);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  return FORMAT_METHODS.has(callee.name.text) || callee.expression.getText() === 'Math';
}

/** A call that only closes the sheet or menu the control is in. */
function isCloseCall(call: ts.CallExpression): boolean {
  const name = calleeName(call);
  if (name === null) return false;
  if (CLOSE_CALLS.has(name)) return true;
  const first = call.arguments[0];
  return SHOWN_SETTER.test(name) && first !== undefined && isOffValue(first);
}

/** The function a timer runs: `setTimeout(fn, 0)`, `InteractionManager.runAfterInteractions(fn)`. */
function deferredFunction(call: ts.CallExpression, env: Env): FunctionNode | null {
  const name = calleeName(call);
  if (name === null || !DEFERRED_CALLS.has(name) || !call.arguments[0]) return null;
  return functionOf(call.arguments[0], env);
}

/**
 * Count the snackbar calls and the other effects of a function body.
 * `stack`: the functions being looked into (a function that calls itself, or
 * a circle of helpers, counts as an effect, so it is never called fake).
 */
function tallyFunction(fn: FunctionNode, env: Env, stack: Set<ts.Node>): Tally {
  if (stack.has(fn) || !fn.body) return { snacks: 0, effects: 1 };
  stack.add(fn);
  const t: Tally = { snacks: 0, effects: 0 };
  const add = (inner: Tally) => {
    t.snacks += inner.snacks;
    t.effects += inner.effects;
  };
  const visit = (n: ts.Node): void => {
    // A function that is only DEFINED here does nothing until it is called.
    if (isFunctionNode(n)) return;
    if (ts.isCallExpression(n)) {
      if (isSnackCall(n, env)) {
        t.snacks += 1;
        n.arguments.forEach(visit); // real work can hide in the message
        return;
      }
      if (isFeedbackCall(n) || isFormatCall(n)) {
        n.arguments.forEach(visit);
        return;
      }
      const later = deferredFunction(n, env);
      if (later) {
        add(tallyFunction(later, NO_ENV, stack));
        return;
      }
      // A helper written in this file is looked into, even when it is called
      // "close": `const close = () => { save(); setOpen(false); }` saves.
      const local = functionOf(n.expression, env);
      if (local) {
        add(tallyFunction(local, bindArgs(local, n.arguments, env), stack));
        n.arguments.forEach(visit);
        return;
      }
      if (isCloseCall(n)) {
        n.arguments.forEach(visit);
        return;
      }
      t.effects += 1;
      return;
    }
    if (ts.isNewExpression(n) || ts.isTaggedTemplateExpression(n) || ts.isDeleteExpression(n)) {
      t.effects += 1;
      return;
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      t.effects += 1;
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      t.effects += 1;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(fn.body);
  stack.delete(fn);
  return t;
}

/** A function is fake when it shows a message and does nothing else. */
function isFakeFunction(fn: FunctionNode, env: Env): boolean {
  const t = tallyFunction(fn, env, new Set());
  return t.snacks > 0 && t.effects === 0;
}

/** The expressions a function returns (its arrow body, or every `return x;` of its own body). */
function returnedExpressions(fn: FunctionNode): ts.Expression[] {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const out: ts.Expression[] = [];
  const collect = (n: ts.Node): void => {
    if (isFunctionNode(n)) return;
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
    ts.forEachChild(n, collect);
  };
  ts.forEachChild(fn.body, collect);
  return out;
}

/**
 * Is this handler expression fake? It follows names, `useCallback`,
 * factories (`soon('Help')`, `go(() => …)`), `cond ? a : b` and `cond && a`.
 */
function isFakeHandler(node: ts.Expression, env: Env, depth = 0): boolean {
  if (depth > 8) return false;
  const e = unwrap(node);
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return isFakeFunction(e, env);
  if (ts.isIdentifier(e)) {
    const fn = functionOf(e, env);
    if (fn) return isFakeFunction(fn, env);
    // `onPress={show}`: the snackbar itself is the handler.
    return SNACK_CALLS.has(e.text);
  }
  if (ts.isConditionalExpression(e)) {
    const branches = [e.whenTrue, e.whenFalse].filter((b) => !isNothing(b));
    return branches.length > 0 && branches.every((b) => isFakeHandler(b, env, depth + 1));
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return isFakeHandler(e.right, env, depth + 1);
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      const sides = [e.left, e.right].filter((b) => !isNothing(b));
      return sides.length > 0 && sides.every((b) => isFakeHandler(b, env, depth + 1));
    }
    return false;
  }
  if (ts.isCallExpression(e)) {
    if (calleeName(e) === 'useCallback' && e.arguments[0]) return isFakeHandler(e.arguments[0], env, depth + 1);
    // A factory written in this file: the handler is the function it returns.
    const factory = functionOf(e.expression, env);
    if (!factory) return false;
    const inner = bindArgs(factory, e.arguments, env);
    const returned = returnedExpressions(factory);
    return returned.length > 0 && returned.every((r) => isFakeHandler(r, inner, depth + 1));
  }
  return false;
}

/** An event prop name the guard checks: "on" + a capital letter, and a control. */
function isCheckedEvent(name: string): boolean {
  return /^on[A-Z]/.test(name) && !NOT_CONTROLS.has(name);
}

/** The text of a property name (`onPress`, `'onPress'`), or null for a computed one. */
function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

/**
 * Every fake control in one file, and how many handlers were checked.
 *
 *   findFakeControls('a.tsx', "<Btn onPress={() => show('Help center')}>Help</Btn>")
 *     → { fakes: [{ line: 1, event: 'onPress', code: "() => show('Help center')" }], checked: 1 }
 */
function findFakeControls(fileName: string, text: string): { fakes: FakeControl[]; checked: number } {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const fakes: FakeControl[] = [];
  let checked = 0;
  const report = (event: string, at: ts.Node, fake: boolean) => {
    checked += 1;
    if (!fake) return;
    const line = sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1;
    const code = at.getText(sf).replace(/\s+/g, ' ');
    fakes.push({ line, event, code: code.length > 90 ? `${code.slice(0, 87)}...` : code });
  };
  const visit = (n: ts.Node): void => {
    if (ts.isJsxAttribute(n) && ts.isIdentifier(n.name) && isCheckedEvent(n.name.text)) {
      const value = n.initializer && ts.isJsxExpression(n.initializer) ? n.initializer.expression : undefined;
      if (value) report(n.name.text, value, isFakeHandler(value, NO_ENV));
    } else if (ts.isPropertyAssignment(n)) {
      const name = propertyName(n.name);
      if (name !== null && isCheckedEvent(name)) report(name, n.initializer, isFakeHandler(n.initializer, NO_ENV));
    } else if (ts.isShorthandPropertyAssignment(n) && isCheckedEvent(n.name.text)) {
      report(n.name.text, n.name, isFakeHandler(n.name, NO_ENV));
    } else if (ts.isMethodDeclaration(n) && ts.isObjectLiteralExpression(n.parent)) {
      const name = propertyName(n.name);
      if (name !== null && isCheckedEvent(name)) report(name, n, isFakeFunction(n, NO_ENV));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { fakes, checked };
}

/* ======================================================= detector tests */

/** The fake controls of a small .tsx snippet, as "line event". */
function fakesIn(code: string): string[] {
  return findFakeControls('snippet.tsx', code).fakes.map((f) => `${f.line} ${f.event}`);
}

describe('the detector catches a fake control', () => {
  test('an inline arrow that only shows a message (expression or block body)', () => {
    expect(fakesIn(`<Btn onPress={() => show('Help center')}>Help</Btn>`)).toEqual(['1 onPress']);
    expect(fakesIn(`<Btn onPress={() => { show('Coming soon'); }}>Restore</Btn>`)).toEqual(['1 onPress']);
    expect(fakesIn(`<Row onLongPress={function () { return show('Soon'); }} />`)).toEqual(['1 onLongPress']);
  });

  test('every snackbar name: onSnack (a prop, optional call), setSnack, snackbar.show', () => {
    const code = [
      `function A({ onSnack }) { return <Btn onPress={() => onSnack?.('Not ready')} />; }`,
      `const [snack, setSnack] = useState(null);`,
      `<Btn onPress={() => setSnack({ text: 'Soon' })} />`,
      `<Btn onPress={() => snackbar.show('Soon')} />`,
    ].join('\n');
    expect(fakesIn(code)).toEqual(['1 onPress', '3 onPress', '4 onPress']);
  });

  test('a named handler: a const arrow, a function declaration, a useCallback', () => {
    const code = [
      `const { show } = useSnackbar();`,
      `const openHelp = () => show('Help center');`,
      `function restore() { show('Restore is coming'); }`,
      `const exportCsv = useCallback(() => { show('Soon'); }, [show]);`,
      `<><Btn onPress={openHelp} /><Btn onPress={restore} /><Btn onPress={exportCsv} /></>`,
    ].join('\n');
    expect(fakesIn(code)).toEqual(['5 onPress', '5 onPress', '5 onPress']);
  });

  test('a fake behind a local helper, a factory or a timer', () => {
    const code = [
      `const notReady = (what) => show(what + ' is not ready');`,
      `const soon = (what) => () => show(what + ' soon');`,
      `<Btn onPress={() => notReady('Help')} />`,
      `<Btn onPress={soon('Export')} />`,
      `<Btn onPress={() => setTimeout(() => show('Later'), 0)} />`,
      `<Btn onPress={() => InteractionManager.runAfterInteractions(() => show('Later'))} />`,
      `const soonText = (what) => what + ' is coming soon';`,
      `<Btn onPress={() => show(soonText('Help'))} />`,
    ].join('\n');
    expect(fakesIn(code)).toEqual(['3 onPress', '4 onPress', '5 onPress', '6 onPress', '8 onPress']);
  });

  test('the old fakes of spec §7: close the sheet, then only show a message', () => {
    const code = [
      // #1 / #2 CardActionsSheet (before wave 4)
      `function Actions({ onClose, onSnack }) {`,
      `  return <ListRow title="Reschedule" onPress={() => { onClose(); onSnack('Reschedule — pick the next review date'); }} />;`,
      `}`,
      // #16 AddDeckSheet "New collection": a factory that closes and then runs its argument
      `const go = (fn) => () => { onClose(); fn(); };`,
      `<ListRow title="New collection" onPress={go(() => show('Collection editor — saved smart filters'))} />`,
      `<Btn onPress={() => { setSheet(null); setMenuOpen(false); show('Soon'); }} />`,
    ].join('\n');
    expect(fakesIn(code)).toEqual(['2 onPress', '5 onPress', '6 onPress']);
  });

  test('a message chosen by a condition, built with plural(), or with a haptic buzz', () => {
    const code = [
      `<Btn onPress={() => (busy ? show('Wait') : show('Soon'))} />`,
      `<Btn onPress={() => { if (busy) { show('Wait'); return; } show('Soon'); }} />`,
      `<Btn onPress={() => { const text = plural(n, 'card') + ' soon'; show(text); }} />`,
      `<Btn onPress={() => { haptics('tick', on); show(n.toLocaleString('en-US')); }} />`,
      `<Btn onPress={() => { console.log('tap'); AccessibilityInfo.announceForAccessibility('Soon'); show('Soon'); }} />`,
    ].join('\n');
    expect(fakesIn(code)).toEqual(['1 onPress', '2 onPress', '3 onPress', '4 onPress', '5 onPress']);
  });

  test('a fake toggle, a fake component prop, a fake Undo action and a fake row in a list', () => {
    const code = [
      `<Toggle on={x} onChange={() => show('Reminders are coming')} />`,
      `<CardActionsSheet onSwitchMode={() => show('Typing mode is coming')} />`,
      `<Btn onPress={() => { remove(id); show('Removed', { label: 'Undo', onAction: () => show('Undone') }); }} />`,
      `const rows = [{ label: 'Restore', onPress: () => show('Soon') }, { label: 'Help', onPress() { show('Soon'); } }];`,
    ].join('\n');
    expect(fakesIn(code)).toEqual(['1 onChange', '2 onSwitchMode', '3 onAction', '4 onPress', '4 onPress']);
  });

  test('the snackbar itself as the handler, and a handler that is fake in every branch', () => {
    expect(fakesIn(`<Btn onPress={show} />`)).toEqual(['1 onPress']);
    expect(fakesIn(`<Btn onPress={a ? () => show('A') : () => show('B')} />`)).toEqual(['1 onPress']);
    expect(fakesIn(`<Btn onPress={on && (() => show('A'))} />`)).toEqual(['1 onPress']);
  });
});

describe('the detector allows a real control', () => {
  test('a handler that does something real and then reports it', () => {
    const code = [
      `<Btn onPress={() => show(deleteBackup(entry) ? 'Deleted' : 'Failed')} />`,
      `<Btn onPress={() => { actions.restore(file); show('Restored'); }} />`,
      `<Btn onPress={() => router.push('/help')} />`,
      `<Btn onPress={async () => { await share(file); show('Shared'); }} />`,
      `<Btn onPress={() => { count += 1; show('Again'); }} />`,
      `<Toggle onChange={(on) => { actions.setSettings({ hints: on }); show('Saved'); }} />`,
    ].join('\n');
    expect(fakesIn(code)).toEqual([]);
  });

  test('a named or factory handler that does real work', () => {
    const code = [
      `const start = () => { router.push('/session'); show('Go'); };`,
      `function pause() { actions.updateDeck(id, { active: false }); show('Deck paused'); }`,
      `const open = (what) => () => setSheet(what);`,
      `const go = (fn) => () => { onClose(); fn(); };`,
      `<><Btn onPress={start} /><Btn onPress={pause} /><Btn onPress={open('help')} /><Btn onPress={go(() => router.push('/import'))} /></>`,
    ].join('\n');
    expect(fakesIn(code)).toEqual([]);
  });

  test('closing a message or opening another sheet is real; a local "show" or "close" is looked into', () => {
    const code = [
      `const [snack, setSnack] = useState(null);`,
      `<Btn onPress={() => setSnack(null)} />`,
      `<Btn onPress={() => { setSheet('mode'); show('Pick a mode'); }} />`,
      `function Panel() { const show = () => setOpen(true); return <Btn onPress={() => show()} />; }`,
      `<Btn onPress={() => sheetRef.current?.show()} />`,
      `function Editor() { const close = () => { actions.saveNote(draft); setOpen(false); }; return <Btn onPress={() => { close(); show('Saved'); }} />; }`,
    ].join('\n');
    expect(fakesIn(code)).toEqual([]);
  });

  test('a button that works in one state and explains itself in the other', () => {
    expect(fakesIn(`<Btn onPress={ready ? start : () => show('Nothing to study')} />`)).toEqual([]);
    expect(fakesIn(`<Btn onPress={ready ? () => router.push('/s') : undefined} />`)).toEqual([]);
    expect(fakesIn(`<Btn onPress={() => { if (!deck) return show('Pick a deck first'); start(deck); }} />`)).toEqual([]);
  });

  test('events that are not controls, comments and strings do not count', () => {
    const code = [
      `<SaveListSheet onSaved={(list) => show('Saved ' + list.name)} />`,
      `<RescheduleSheet onDone={() => show('Rescheduled')} />`,
      `<Image onError={() => show('The image could not load')} />`,
      `<CardActionsSheet onSnack={(text) => setSnack({ text })} />`,
      `// <Btn onPress={() => show('Help center')} />`,
      `const doc = "onPress={() => show('x')}";`,
    ].join('\n');
    expect(fakesIn(code)).toEqual([]);
  });

  test('a handler that comes from a prop or an import is not guessed at', () => {
    const code = [
      `import { openHelp } from './help';`,
      `function Row({ onOpen }) { return <Btn onPress={onOpen} />; }`,
      `<Btn onPress={openHelp} />`,
    ].join('\n');
    expect(fakesIn(code)).toEqual([]);
  });

  test('it counts the handlers it checked', () => {
    const { checked } = findFakeControls('a.tsx', `<A onPress={f} onLongPress={g} onSaved={h} style={s} />`);
    expect(checked).toBe(2); // onSaved is not a control, style is not an event
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

describe('guard: no control in the app only shows a snackbar (spec §7)', () => {
  const SRC = path.resolve(__dirname, '..');

  test('no fake control under src/app and src/components', () => {
    const files = [...sourceFiles(path.join(SRC, 'app')), ...sourceFiles(path.join(SRC, 'components'))];
    // The walk really read the tree (a wrong path would pass with 0 files).
    expect(files.filter((f) => f.endsWith('.tsx')).length).toBeGreaterThan(80);

    const found: string[] = [];
    let checked = 0;
    for (const file of files) {
      const result = findFakeControls(file, fs.readFileSync(file, 'utf8'));
      checked += result.checked;
      for (const f of result.fakes) found.push(`${path.relative(SRC, file)}:${f.line} ${f.event}={${f.code}}`);
    }
    // The detector really looked at the handlers (hundreds of onPress props).
    expect(checked).toBeGreaterThan(400);
    // A hit here is a control whose press only shows a message. Build it for
    // real or remove it (spec §7); do not add its event to NOT_CONTROLS.
    expect(found).toEqual([]);
  });
});
