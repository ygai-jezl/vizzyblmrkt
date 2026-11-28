"use client";

import { createContext, useContext, useEffect, useRef } from "react";

/**
 * The editors open inside the open row on Work's list (WORK_QUICK_EDIT_ENABLED): what each is
 * called, whether it holds input not saved yet, how to close it and, for a text box, how to save
 * what it holds. The row reads them when Esc is pressed or the person leaves the row, so it can
 * ask before anything typed is thrown away. On the task page there is no row: the hooks here do
 * nothing, and the sections draw exactly as before.
 */
export interface RowEditor {
  label: string;
  dirty: boolean;
  close: () => void;
  /** A text box saves what it holds instead of asking. */
  commit?: () => void;
}

export interface RowEditors {
  set(id: string, editor: RowEditor | null): void;
}

export const RowEditorsContext = createContext<RowEditors | null>(null);

/** Inside the open row on the list, rather than on the task page. */
export function useInRow(): boolean {
  return useContext(RowEditorsContext) !== null;
}

/**
 * A focus mark for the open row, so a click on a cell can move focus to its field: the key inside
 * the row, and nothing on the task page, so its markup stays as it was.
 */
export function useFocusMark(): (key: string) => string | undefined {
  const inRow = useInRow();
  return (key) => (inRow ? key : undefined);
}

/**
 * Tell the open row about an editor while it is open (null once it closes). The row always reads
 * the newest label, input and close through the handle, and keeps editors in the order they
 * opened, so Esc closes the innermost first.
 */
export function useRowEditor(id: string, editor: RowEditor | null): void {
  const row = useContext(RowEditorsContext);
  const latest = useRef(editor);
  latest.current = editor;
  const open = editor !== null;
  useEffect(() => {
    if (!row || !open) return;
    const handle: RowEditor = {
      get label() {
        return latest.current?.label ?? "";
      },
      get dirty() {
        return latest.current?.dirty ?? false;
      },
      close: () => latest.current?.close(),
      get commit() {
        const c = latest.current?.commit;
        return c ? () => c() : undefined;
      },
    };
    row.set(id, handle);
    return () => row.set(id, null);
  }, [row, id, open]);
}
