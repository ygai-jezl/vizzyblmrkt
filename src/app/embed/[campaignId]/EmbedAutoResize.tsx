"use client";

import { useEffect, useRef } from "react";

/**
 * Client wrapper for the embed iframe. Two jobs, both via postMessage to the
 * parent (the host site), which the /embed.js loader listens for:
 *  1. Keep the iframe sized to its content (ResizeObserver on the inner box).
 *  2. Bridge the `vizzybl:signup` DOM event (emitted by SignupForm) to the host.
 *
 * Outbound messages use "*" because the host origin is arbitrary and unknown;
 * the payloads (content height, public signup counts) are non-sensitive, and
 * the loader validates INBOUND messages by our origin.
 */
export function EmbedAutoResize({
  children,
  background,
}: {
  children: React.ReactNode;
  background?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let raf = 0;
    let lastH = 0;
    const post = () => {
      raf = 0;
      const h = Math.ceil(el.getBoundingClientRect().height);
      // Hysteresis: ignore sub-pixel noise so a fractional reflow can't trigger
      // a stream of ±1px resize messages (parent layout thrash / flicker).
      if (h > 0 && Math.abs(h - lastH) > 1) {
        lastH = h;
        window.parent?.postMessage({ type: "vizzybl:resize", height: h }, "*");
      }
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(post);
    };

    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    window.addEventListener("load", schedule);
    schedule();

    const onSignup = (e: Event) => {
      const detail = (e as CustomEvent).detail ?? {};
      window.parent?.postMessage({ type: "vizzybl:signup", detail }, "*");
    };
    window.addEventListener("vizzybl:signup", onSignup as EventListener);

    return () => {
      ro.disconnect();
      window.removeEventListener("load", schedule);
      window.removeEventListener("vizzybl:signup", onSignup as EventListener);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={ref} style={background ? { background } : undefined}>
      {children}
    </div>
  );
}
