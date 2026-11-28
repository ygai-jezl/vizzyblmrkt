"use client";

import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";

/**
 * The open row's guard on Work's list (WORK_QUICK_EDIT_ENABLED), for what sits outside the list:
 * the filters and Add task wait for the row's saves and ask about unsaved edits before they go,
 * and Add task's Open it opens the new task in place. With no provider (the switch off, or any
 * other page) there is no guard, and they work as they always have.
 */
export interface QuickGuard {
  /** Run `then` once the open row's saves are in and nothing unsaved is left (or there is no open row). */
  leave(then: () => void): void;
  /** Open this task in place on the list. */
  open(ref: number): void;
}

interface Bindable extends QuickGuard {
  bind(impl: QuickGuard | null): void;
}

const QuickGuardContext = createContext<Bindable | null>(null);

export function QuickGuardProvider({ children }: { children: ReactNode }) {
  const impl = useRef<QuickGuard | null>(null);
  const value = useMemo<Bindable>(
    () => ({
      leave: (then) => (impl.current ? impl.current.leave(then) : then()),
      open: (ref) => impl.current?.open(ref),
      bind: (next) => {
        impl.current = next;
      },
    }),
    [],
  );
  return <QuickGuardContext.Provider value={value}>{children}</QuickGuardContext.Provider>;
}

/** The guard, or null where there is no open row to wait for. */
export function useQuickGuard(): QuickGuard | null {
  return useContext(QuickGuardContext);
}

/** For the list itself: hand the provider its guard. */
export function useBindQuickGuard(): ((impl: QuickGuard | null) => void) | null {
  const ctx = useContext(QuickGuardContext);
  return ctx ? ctx.bind : null;
}
