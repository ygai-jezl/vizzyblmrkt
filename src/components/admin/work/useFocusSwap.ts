"use client";

import { useEffect, useRef } from "react";

/** Where focus goes when a button's own form opens or closes: into the form, back to what opened it, or nowhere. */
export function focusTarget(wasOpen: boolean, open: boolean): "form" | "opener" | null {
  if (open && !wasOpen) return "form";
  if (!open && wasOpen) return "opener";
  return null;
}

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";

function firstFocusable(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null;
  return el.matches(FOCUSABLE) ? el : el.querySelector<HTMLElement>(FOCUSABLE);
}

/**
 * A button that opens a form in its place (Dismiss's reasons, Approve the plan, Record a decision,
 * Change the pick) takes keyboard focus into the form when it opens, and back to the button when
 * it closes, so a keyboard or screen reader user never lands on the page's top. Put `form` on the
 * form's wrapper and `opener` on the wrapper of the button that opens it.
 */
export function useFocusSwap(open: boolean) {
  const form = useRef<HTMLElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const was = useRef(open);
  useEffect(() => {
    const target = focusTarget(was.current, open);
    was.current = open;
    if (target === "form") firstFocusable(form.current)?.focus();
    if (target === "opener") firstFocusable(opener.current)?.focus();
  }, [open]);
  return {
    form: (el: HTMLElement | null) => {
      form.current = el;
    },
    opener: (el: HTMLElement | null) => {
      opener.current = el;
    },
  };
}
