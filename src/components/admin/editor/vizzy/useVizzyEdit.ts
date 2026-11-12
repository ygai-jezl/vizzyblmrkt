"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { isMarkdownFormat, type EditFormat } from "@/lib/content/editor/extensions";
import { VIZZY_LIMITS, excerptOf, type VizzyEvent, type VizzyRequestInput, type VizzySkipped } from "@/lib/content/editor/vizzyOps";
import { markdownFragments, planSelectionEdit, planWholeEdits } from "@/lib/content/editor/vizzyPlan";
import {
  applyEditsTr,
  setTargetTr,
  vizzyPending,
  vizzyResolved,
  vizzyTarget,
  type VizzyOutcome,
  type VizzyVia,
} from "@/lib/content/editor/vizzyPlugin";
import { markdownSerializer, selectionTarget, type VizzyTarget } from "@/lib/content/editor/vizzySelection";
import { emailFragments, emailSerializer } from "./emailAdapter";

/**
 * Vizzy inside Edit mode, in the browser: what is selected, one request at a time to
 * /api/admin/editor/vizzy, Vizzy's answer placed in the text as changes to keep or undo, and a
 * log of what the person kept and undid (for learning their preferences).
 */

export interface VizzyTurn {
  id: string;
  instruction: string;
  /** What it was about: a quote of the selection, or null for the whole piece. */
  on: string | null;
  reply: string;
  status: "working" | "done";
  error?: string;
  skipped: VizzySkipped[];
  /** How many changes were placed in the text. */
  changed: number;
}

export interface VizzyLogEntry {
  instruction: string;
  kind: "selection" | "whole";
  outcome: VizzyOutcome;
  via: VizzyVia;
  /** The words before and after, plain and short. */
  before: string;
  after: string;
}

const ERRORS: Record<number, string> = {
  403: "Vizzy editing isn't included for this brand.",
  429: "Vizzy has had a lot of requests from your brand. Try again in a minute.",
  503: "Vizzy isn't set up on this copy of YouGrow yet.",
};

const LOG_TEXT = 280;
const MAX_LOG = 40;

export function useVizzyEdit({
  editor,
  format,
  workspaceId,
  tokens,
  getText,
}: {
  editor: Editor | null;
  format: EditFormat;
  workspaceId?: string;
  tokens?: readonly string[];
  /** The whole text as it will be saved. */
  getText: () => string;
}) {
  const [turns, setTurns] = useState<VizzyTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<VizzyTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const targetRef = useRef<VizzyTarget | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const log = useRef<VizzyLogEntry[]>([]);

  const tools = useMemo(() => {
    if (!editor) return null;
    return isMarkdownFormat(format)
      ? { make: markdownFragments(editor.schema, format), ser: markdownSerializer }
      : { make: emailFragments(editor.schema), ser: emailSerializer(editor.schema) };
  }, [editor, format]);

  // What the person kept and undid, from every transaction.
  useEffect(() => {
    if (!editor) return;
    const onTransaction = () => {
      for (const r of vizzyResolved(editor.state)) {
        if (log.current.length >= MAX_LOG) break;
        log.current.push({
          instruction: r.s.instruction,
          kind: r.s.requestKind,
          outcome: r.outcome,
          via: r.via,
          before: r.s.beforePlain.slice(0, LOG_TEXT),
          after: r.s.afterPlain.slice(0, LOG_TEXT),
        });
      }
      // The asked-about text went (deleted, or replaced by Vizzy): nothing is selected now.
      if (targetRef.current && !vizzyTarget(editor.state)) {
        targetRef.current = null;
        setTarget(null);
      }
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor]);

  const update = useCallback((id: string, change: (t: VizzyTurn) => VizzyTurn) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? change(t) : t)));
  }, []);

  /** Ask about what is selected in the editor now. False when there is nothing to ask about. */
  const captureTarget = useCallback((): boolean => {
    if (!editor || !tools) return false;
    if (editor.state.selection.empty) return false;
    const t = selectionTarget(editor.state, tools.ser);
    if ("error" in t) {
      setNotice(t.error);
      return false;
    }
    setNotice(null);
    targetRef.current = t;
    setTarget(t);
    editor.view.dispatch(setTargetTr(editor.state, { from: t.from, to: t.to }));
    return true;
  }, [editor, tools]);

  const clearTarget = useCallback(() => {
    targetRef.current = null;
    setTarget(null);
    if (editor && vizzyTarget(editor.state)) editor.view.dispatch(setTargetTr(editor.state, null));
  }, [editor]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const ask = useCallback(
    async (instruction: string) => {
      const asked = instruction.trim();
      if (!asked || !editor || !tools || inFlight.current) return;
      const t = targetRef.current;
      const mapped = vizzyTarget(editor.state);
      let body: VizzyRequestInput;
      if (t) {
        if (!mapped) {
          setNotice("The text you selected has changed. Select it again.");
          clearTarget();
          return;
        }
        body = {
          format,
          mode: "selection",
          shape: t.shape,
          instruction: asked,
          selection: t.text,
          before: t.before,
          after: t.after,
          workspaceId,
          tokens: tokens ? [...tokens] : undefined,
        };
      } else {
        const text = getText();
        if (!text.trim()) {
          setNotice("There's no text to edit yet.");
          return;
        }
        if (text.length > (format === "email" ? VIZZY_LIMITS.EMAIL : VIZZY_LIMITS.MARKDOWN)) {
          setNotice("This is too long for Vizzy to edit in one go. Select a part of it instead.");
          return;
        }
        body = { format, mode: "whole", instruction: asked, text, workspaceId, tokens: tokens ? [...tokens] : undefined };
      }

      inFlight.current = true;
      setBusy(true);
      setNotice(null);
      const id = `turn_${Date.now().toString(36)}`;
      setTurns((prev) => [
        ...prev,
        { id, instruction: asked, on: t ? excerptOf(t.plain) : null, reply: "", status: "working", skipped: [], changed: 0 },
      ]);
      const controller = new AbortController();
      abortRef.current = controller;

      const onEvent = (ev: VizzyEvent) => {
        if (ev.type === "text") {
          update(id, (turn) => ({ ...turn, reply: turn.reply + ev.text }));
        } else if (ev.type === "error") {
          update(id, (turn) => ({ ...turn, error: ev.message }));
        } else if (ev.type === "selection" && t) {
          const now = vizzyTarget(editor.state);
          if (!now) {
            update(id, (turn) => ({ ...turn, error: "The text you selected has changed. Select it again and ask." }));
            return;
          }
          const planned = planSelectionEdit({
            state: editor.state,
            format,
            make: tools.make,
            ser: tools.ser,
            instruction: asked,
            tokens,
            target: { ...t, from: now.from, to: now.to },
            replacement: ev.replacement,
            warnings: ev.warnings,
          });
          if ("error" in planned) {
            update(id, (turn) => ({ ...turn, error: planned.error }));
            return;
          }
          editor.view.dispatch(applyEditsTr(editor.state, [planned.edit], { group: id, instruction: asked, requestKind: "selection" }));
          targetRef.current = null;
          setTarget(null);
          update(id, (turn) => ({ ...turn, changed: 1 }));
        } else if (ev.type === "whole") {
          const planned = planWholeEdits({
            state: editor.state,
            format,
            make: tools.make,
            ser: tools.ser,
            instruction: asked,
            tokens,
            ops: ev.ops,
            pending: vizzyPending(editor.state),
          });
          if (planned.edits.length) {
            editor.view.dispatch(applyEditsTr(editor.state, planned.edits, { group: id, instruction: asked, requestKind: "whole" }));
          }
          update(id, (turn) => ({ ...turn, changed: planned.edits.length, skipped: [...ev.skipped, ...planned.skipped] }));
        }
      };

      try {
        const res = await fetch("/api/admin/editor/vizzy", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          update(id, (turn) => ({ ...turn, error: ERRORS[res.status] ?? "Something went wrong. Try again." }));
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            try {
              onEvent(JSON.parse(line.slice(5).trim()) as VizzyEvent);
            } catch {
              // A broken event line: skip it.
            }
          }
        }
      } catch {
        if (controller.signal.aborted) update(id, (turn) => ({ ...turn, error: turn.error ?? "Stopped." }));
        else update(id, (turn) => ({ ...turn, error: "Vizzy couldn't be reached. Check your connection and try again." }));
      } finally {
        update(id, (turn) => ({ ...turn, status: "done" }));
        abortRef.current = null;
        inFlight.current = false;
        setBusy(false);
      }
    },
    [editor, tools, format, workspaceId, tokens, getText, update, clearTarget],
  );

  useEffect(() => () => abortRef.current?.abort(), []);

  return { turns, busy, target, notice, setNotice, ask, stop, captureTarget, clearTarget, log };
}
