import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { closeHistory, isHistoryTransaction } from "@tiptap/pm/history";
import type { Slice } from "@tiptap/pm/model";
import { AddMarkStep, RemoveMarkStep } from "@tiptap/pm/transform";
import { LEAF } from "./vizzyAnchor";
import type { PlannedEdit } from "./vizzyPlan";

/**
 * Vizzy's changes in the editor until the person keeps or undoes them. Each request is applied
 * as one ordinary transaction (so Save, the draft copy and Cmd-Z all see it), and its ranges are
 * kept in this plugin's state, mapped through every later transaction, to highlight them with
 * Keep and Undo. The ProseMirror functions here are pure; only the bar's buttons touch the DOM,
 * and only in the browser.
 *
 * - Keep drops the highlight. Undo puts back what was there.
 * - Typing inside a change keeps it (the edit is the person's now); deleting it undoes it.
 * - Cmd-Z over a change undoes it.
 * - `resolved` lists what the last transaction kept or undid, for the learning log.
 */

export interface VizzySuggestion {
  id: string;
  /** One request's changes share a group (Keep all, Undo all). */
  group: string;
  instruction: string;
  requestKind: "selection" | "whole";
  kind: "inline" | "block" | "deletion";
  from: number;
  to: number;
  /** What was there, to put back. */
  before: Slice;
  /** The words that were there, for "Show before". */
  beforePlain: string;
  /** The words Vizzy wrote, as first written. */
  afterPlain: string;
  beforeText: string;
  afterText: string;
  warnings: string[];
  showBefore: boolean;
}

export type VizzyOutcome = "kept" | "undone";
export type VizzyVia = "button" | "edited" | "history" | "collapsed" | "save" | "view";

export interface VizzyResolved {
  s: VizzySuggestion;
  outcome: VizzyOutcome;
  via: VizzyVia;
}

export interface VizzyState {
  suggestions: VizzySuggestion[];
  /** The text a request is about, shown while the person types it. */
  target: { from: number; to: number } | null;
  /** What this transaction kept or undid. */
  resolved: VizzyResolved[];
}

interface Meta {
  add?: VizzySuggestion[];
  resolve?: { ids: string[]; outcome: VizzyOutcome; via: VizzyVia };
  target?: { from: number; to: number } | null;
  toggleBefore?: string;
  clear?: true;
}

export const vizzyKey = new PluginKey<VizzyState>("vizzySuggestions");

const EMPTY: VizzyState = { suggestions: [], target: null, resolved: [] };

/** Whether a transaction changed anything inside a range (typing in it, deleting over it,
 *  bolding part of it). Positions follow the range step by step. With `edges`, text put back at
 *  either end counts too (Cmd-Z over words Vizzy removed). */
function touches(tr: Transaction, from: number, to: number, edges = false): boolean {
  let a = from;
  let b = to;
  for (const step of tr.steps) {
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
      if (step.from < b && step.to > a) return true;
    }
    let hit = false;
    step.getMap().forEach((oldStart, oldEnd) => {
      const inside = edges ? oldStart >= a && oldStart <= b : oldStart > a && oldStart < b;
      if (oldStart === oldEnd ? inside : oldStart < b && oldEnd > a) hit = true;
    });
    if (hit) return true;
    const map = step.getMap();
    a = map.map(a, 1);
    b = Math.max(a, map.map(b, -1));
  }
  return false;
}

function stateOf(state: EditorState): VizzyState {
  return vizzyKey.getState(state) ?? EMPTY;
}

function apply(tr: Transaction, prev: VizzyState): VizzyState {
  const meta = tr.getMeta(vizzyKey) as Meta | undefined;
  if (meta?.clear) return EMPTY;
  const resolved: VizzyResolved[] = [];
  const explicit = new Set(meta?.resolve?.ids ?? []);
  let suggestions = prev.suggestions;

  if (tr.docChanged) {
    const history = isHistoryTransaction(tr);
    const next: VizzySuggestion[] = [];
    for (const s of suggestions) {
      if (explicit.has(s.id) && meta?.resolve) {
        resolved.push({ s, outcome: meta.resolve.outcome, via: meta.resolve.via });
        continue;
      }
      const from = tr.mapping.map(s.from, 1);
      const to = Math.max(from, tr.mapping.map(s.to, -1));
      if (s.kind !== "deletion" && to <= from) {
        resolved.push({ s, outcome: "undone", via: "collapsed" });
      } else if (touches(tr, s.from, s.to, history && s.kind === "deletion")) {
        resolved.push({ s, outcome: history ? "undone" : "kept", via: history ? "history" : "edited" });
      } else {
        next.push(from === s.from && to === s.to ? s : { ...s, from, to });
      }
    }
    suggestions = next;
  } else if (meta?.resolve) {
    const resolve = meta.resolve;
    suggestions = suggestions.filter((s) => {
      if (!explicit.has(s.id)) return true;
      resolved.push({ s, outcome: resolve.outcome, via: resolve.via });
      return false;
    });
  }

  if (meta?.toggleBefore) {
    suggestions = suggestions.map((s) => (s.id === meta.toggleBefore ? { ...s, showBefore: !s.showBefore } : s));
  }
  if (meta?.add) suggestions = [...suggestions, ...meta.add];

  let target = prev.target;
  if (meta && "target" in meta) target = meta.target ?? null;
  else if (target && tr.docChanged) {
    const from = tr.mapping.map(target.from, 1);
    const to = tr.mapping.map(target.to, -1);
    target = to > from ? { from, to } : null;
  }

  if (!resolved.length && suggestions === prev.suggestions && target === prev.target && !prev.resolved.length) return prev;
  return { suggestions, target, resolved };
}

// ── transactions the editor dispatches ─────────────────────────────────────────────────

let counter = 0;
const newId = () => `vz${Date.now().toString(36)}${(counter += 1).toString(36)}`;

export interface ApplyInfo {
  group: string;
  instruction: string;
  requestKind: "selection" | "whole";
  makeId?: () => string;
}

/** One request's edits as one transaction (one Cmd-Z step), each tracked as a change. Edits
 *  must not overlap. */
export function applyEditsTr(state: EditorState, edits: PlannedEdit[], info: ApplyInfo): Transaction {
  const tr = state.tr;
  const makeId = info.makeId ?? newId;
  const added: VizzySuggestion[] = [];
  for (const e of [...edits].sort((x, y) => x.from - y.from)) {
    const a = tr.mapping.map(e.from, -1);
    const b = tr.mapping.map(e.to, 1);
    const before = tr.doc.slice(a, b);
    const beforePlain = tr.doc.textBetween(a, b, "\n", LEAF);
    const n = tr.steps.length;
    tr.replaceWith(a, b, e.content);
    const since = tr.mapping.slice(n);
    const from = since.map(a, -1);
    const to = since.map(b, 1);
    const afterPlain = tr.doc.textBetween(from, to, "\n", LEAF);
    added.push({
      id: makeId(),
      group: info.group,
      instruction: info.instruction,
      requestKind: info.requestKind,
      kind: e.content.size === 0 ? "deletion" : e.kind,
      from,
      to: e.content.size === 0 ? from : to,
      before,
      beforePlain,
      afterPlain,
      beforeText: e.beforeText,
      afterText: e.afterText,
      warnings: e.warnings,
      showBefore: false,
    });
  }
  closeHistory(tr);
  return tr.setMeta(vizzyKey, { add: added, target: null } satisfies Meta);
}

/** Put back what was there for these changes (one Cmd-Z step). Null when it can't. */
export function undoSuggestionsTr(state: EditorState, ids: readonly string[]): Transaction | null {
  const list = stateOf(state)
    .suggestions.filter((s) => ids.includes(s.id))
    .sort((x, y) => y.from - x.from);
  if (!list.length) return null;
  const tr = state.tr;
  try {
    for (const s of list) tr.replace(s.from, s.to, s.before);
  } catch {
    return null;
  }
  closeHistory(tr);
  return tr.setMeta(vizzyKey, { resolve: { ids: list.map((s) => s.id), outcome: "undone", via: "button" } } satisfies Meta);
}

/** Keep these changes (or all of them): the text stays, the highlight goes. */
export function keepSuggestionsTr(state: EditorState, ids?: readonly string[], via: VizzyVia = "button"): Transaction {
  const all = stateOf(state).suggestions.map((s) => s.id);
  return state.tr
    .setMeta(vizzyKey, { resolve: { ids: ids ? [...ids] : all, outcome: "kept", via } } satisfies Meta)
    .setMeta("addToHistory", false);
}

export function setTargetTr(state: EditorState, target: { from: number; to: number } | null): Transaction {
  return state.tr.setMeta(vizzyKey, { target } satisfies Meta).setMeta("addToHistory", false);
}

export function toggleBeforeTr(state: EditorState, id: string): Transaction {
  return state.tr.setMeta(vizzyKey, { toggleBefore: id } satisfies Meta).setMeta("addToHistory", false);
}

/** Forget every change without logging it (before the whole text is replaced). */
export function clearSuggestionsTr(state: EditorState): Transaction {
  return state.tr.setMeta(vizzyKey, { clear: true } satisfies Meta).setMeta("addToHistory", false);
}

export function vizzyPending(state: EditorState): VizzySuggestion[] {
  return stateOf(state).suggestions;
}

export function vizzyTarget(state: EditorState): { from: number; to: number } | null {
  return stateOf(state).target;
}

/** What the last transaction kept or undid. */
export function vizzyResolved(state: EditorState): VizzyResolved[] {
  return stateOf(state).resolved;
}

// ── the plugin ─────────────────────────────────────────────────────────────────────────

const BUTTON = "vizzy-bar-button";

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.className = primary ? `${BUTTON} ${BUTTON}-primary` : BUTTON;
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", (e) => {
    e.preventDefault();
    onClick();
  });
  return b;
}

/** The small bar after a change: Keep, Undo, Show before. */
function bar(view: EditorView, s: VizzySuggestion): HTMLElement {
  const el = document.createElement("span");
  el.className = "vizzy-bar";
  el.contentEditable = "false";
  const label = document.createElement("span");
  label.className = "vizzy-bar-label";
  label.textContent = s.kind === "deletion" ? "Vizzy removed words" : "Vizzy's change";
  el.append(
    label,
    button("Keep", () => view.dispatch(keepSuggestionsTr(view.state, [s.id])), true),
    button("Undo", () => {
      const tr = undoSuggestionsTr(view.state, [s.id]);
      if (tr) view.dispatch(tr);
    }),
  );
  if (s.beforePlain) {
    el.append(button(s.showBefore ? "Hide before" : "Show before", () => view.dispatch(toggleBeforeTr(view.state, s.id))));
  }
  return el;
}

/** The words that were there, struck through, as plain text. */
function beforeWords(s: VizzySuggestion): HTMLElement {
  const el = document.createElement("span");
  el.className = "vizzy-before";
  el.contentEditable = "false";
  el.textContent = s.beforePlain;
  return el;
}

function decorations(state: EditorState): DecorationSet {
  const { suggestions, target } = stateOf(state);
  if (!suggestions.length && !target) return DecorationSet.empty;
  const decos: Decoration[] = [];
  for (const s of suggestions) {
    if (s.kind === "inline" && s.to > s.from) {
      decos.push(Decoration.inline(s.from, s.to, { class: "vizzy-suggestion" }));
    } else if (s.kind === "block") {
      state.doc.nodesBetween(s.from, s.to, (node, pos, parent) => {
        if (parent === state.doc) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: "vizzy-suggestion-block" }));
        return false;
      });
    }
    // A selection's one change gets its bar in the text. Edits across the whole piece are many
    // and small: they're highlighted, and kept or undone from the Vizzy tab.
    if (s.requestKind !== "selection") continue;
    if (s.showBefore && s.beforePlain) {
      decos.push(Decoration.widget(s.from, () => beforeWords(s), { side: -1, key: `vizzy-before:${s.id}` }));
    }
    decos.push(
      Decoration.widget(s.to, (view) => bar(view, s), {
        side: 1,
        key: `vizzy-bar:${s.id}:${s.showBefore ? 1 : 0}`,
        ignoreSelection: true,
        stopEvent: () => true,
      }),
    );
  }
  if (target && target.to > target.from) decos.push(Decoration.inline(target.from, target.to, { class: "vizzy-target" }));
  return DecorationSet.create(state.doc, decos);
}

export function vizzyPlugin(): Plugin<VizzyState> {
  return new Plugin<VizzyState>({
    key: vizzyKey,
    state: { init: () => EMPTY, apply },
    props: { decorations },
  });
}

/** The plugin as an editor extension, for Edit mode. */
export const VizzySuggestions = Extension.create({
  name: "vizzySuggestions",
  addProseMirrorPlugins() {
    return [vizzyPlugin()];
  },
});
