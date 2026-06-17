"use client";

import { useCallback, useEffect, type RefObject } from "react";

/**
 * Auto-grows a textarea between min/max heights as its value changes, enabling
 * an inner scrollbar only once it hits max. Ported from the sibling portal's
 * useAutoResizeTextarea (no external deps).
 */
interface UseAutoResizeTextareaOptions {
  /** Minimum height in pixels (single line). */
  minHeight?: number;
  /** Maximum height in pixels before the textarea scrolls internally. */
  maxHeight?: number;
  /** Current textarea value — drives the resize effect. */
  value: string;
}

interface UseAutoResizeTextareaReturn {
  resetHeight: () => void;
  adjustHeight: () => void;
}

export function useAutoResizeTextarea(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  options: UseAutoResizeTextareaOptions,
): UseAutoResizeTextareaReturn {
  const { minHeight = 24, maxHeight = 200, value } = options;

  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const scrollHeight = textarea.scrollHeight;
    const newHeight = Math.min(Math.max(scrollHeight, minHeight), maxHeight);
    textarea.style.height = `${newHeight}px`;
    textarea.style.overflowY = scrollHeight > maxHeight ? "auto" : "hidden";
  }, [textareaRef, minHeight, maxHeight]);

  const resetHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = `${minHeight}px`;
    textarea.style.overflowY = "hidden";
  }, [textareaRef, minHeight]);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  useEffect(() => {
    const handleResize = () => adjustHeight();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [adjustHeight]);

  return { resetHeight, adjustHeight };
}
