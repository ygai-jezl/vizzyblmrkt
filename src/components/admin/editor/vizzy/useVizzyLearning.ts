"use client";

import { useCallback, useEffect, useState } from "react";
import type { EditMemory } from "@/lib/agents/memoryBank";
import type { VizzyLogEntry } from "./useVizzyEdit";

/**
 * What Vizzy remembers about how the person edits, in Edit mode: loaded when Edit mode opens,
 * forgotten on request, and this visit's kept and undone changes sent when it closes. Hidden
 * entirely when learning isn't on for this copy or brand (the route says so).
 */

const SEEN_KEY = "yg-vizzy-memories-seen";
const NOTICE_KEY = "yg-vizzy-learning-notice";

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A private window: the notes show again next time, nothing else changes.
  }
}

export interface VizzyLearning {
  /** Learning is on for this copy and brand. */
  available: boolean;
  /** The person lets Vizzy learn from and use their edits. */
  learn: boolean;
  memories: EditMemory[];
  /** Memories made since the person last looked. */
  fresh: EditMemory[];
  /** The first time: say what learning is. */
  firstTime: boolean;
  canAddToBrandVoice: boolean;
  message: string | null;
  setLearn: (learn: boolean) => Promise<void>;
  forget: (id: string) => Promise<void>;
  forgetAll: () => Promise<void>;
  addToBrandVoice: (id: string) => Promise<void>;
  /** Done with the "new" note and the first-time note. */
  seen: () => void;
  /** Send what the person kept and undid in this visit. */
  send: (log: readonly VizzyLogEntry[]) => void;
}

const MESSAGES: Record<string, string> = {
  brand_voice_full: "Your brand voice already has 12 rules. Edit them in Brand kit first.",
  brand_voice_unavailable: "The brand voice couldn't be changed. Edit it in Brand kit.",
  memory_unavailable: "Vizzy's memory couldn't be reached. Try again in a moment.",
};

export function useVizzyLearning(enabled: boolean): VizzyLearning {
  const [available, setAvailable] = useState(false);
  const [learn, setLearnState] = useState(true);
  const [memories, setMemories] = useState<EditMemory[]>([]);
  const [canAddToBrandVoice, setCanAdd] = useState(false);
  const [lastSeen, setLastSeen] = useState<string | null>(null);
  const [firstTime, setFirstTime] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setLastSeen(readLocal(SEEN_KEY));
    setFirstTime(!readLocal(NOTICE_KEY));
    void (async () => {
      try {
        const res = await fetch("/api/admin/editor/vizzy/memories", { credentials: "same-origin" });
        if (!res.ok || !live) return;
        const data = (await res.json()) as { learn: boolean; memories: EditMemory[]; canAddToBrandVoice: boolean };
        setAvailable(true);
        setLearnState(data.learn);
        setMemories(data.memories ?? []);
        setCanAdd(Boolean(data.canAddToBrandVoice));
      } catch {
        // No learning this visit; editing works as before.
      }
    })();
    return () => {
      live = false;
    };
  }, [enabled]);

  const fail = useCallback(async (res: Response) => {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setMessage(MESSAGES[body.error ?? ""] ?? "That didn't work. Try again.");
  }, []);

  const setLearn = useCallback(
    async (next: boolean) => {
      setMessage(null);
      const res = await fetch("/api/admin/editor/vizzy/settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ learn: next }),
      }).catch(() => null);
      if (res?.ok) setLearnState(next);
      else if (res) await fail(res);
      else setMessage(MESSAGES.memory_unavailable!);
    },
    [fail],
  );

  const forget = useCallback(
    async (id: string) => {
      setMessage(null);
      const res = await fetch(`/api/admin/editor/vizzy/memories/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "same-origin",
      }).catch(() => null);
      if (res?.ok || res?.status === 404) setMemories((prev) => prev.filter((m) => m.id !== id));
      else if (res) await fail(res);
      else setMessage(MESSAGES.memory_unavailable!);
    },
    [fail],
  );

  const forgetAll = useCallback(async () => {
    setMessage(null);
    const res = await fetch("/api/admin/editor/vizzy/memories", { method: "DELETE", credentials: "same-origin" }).catch(() => null);
    if (res?.ok) {
      setMemories([]);
      setMessage("Vizzy has forgotten how you like your edits.");
    } else if (res) await fail(res);
    else setMessage(MESSAGES.memory_unavailable!);
  }, [fail]);

  const addToBrandVoice = useCallback(
    async (id: string) => {
      setMessage(null);
      const res = await fetch(`/api/admin/editor/vizzy/memories/${encodeURIComponent(id)}/brand-voice`, {
        method: "POST",
        credentials: "same-origin",
      }).catch(() => null);
      if (res?.ok) {
        const body = (await res.json().catch(() => ({}))) as { added?: boolean };
        setMessage(body.added ? "Added to your brand voice for the whole team." : "Your brand voice already has that rule.");
      } else if (res) await fail(res);
      else setMessage(MESSAGES.memory_unavailable!);
    },
    [fail],
  );

  const seen = useCallback(() => {
    const newest = memories.reduce<string>((max, m) => ((m.createdAt ?? "") > max ? (m.createdAt ?? "") : max), lastSeen ?? "");
    if (newest) writeLocal(SEEN_KEY, newest);
    writeLocal(NOTICE_KEY, "1");
    setLastSeen(newest || lastSeen);
    setFirstTime(false);
  }, [memories, lastSeen]);

  const send = useCallback(
    (log: readonly VizzyLogEntry[]) => {
      if (!available || !learn || !log.length) return;
      const entries = log.slice(0, 20).map((e) => ({
        instruction: e.instruction.slice(0, 1000),
        kind: e.kind,
        outcome: e.outcome,
        before: e.before,
        after: e.after,
      }));
      // keepalive: Edit mode is closing, and the request should outlive it.
      void fetch("/api/admin/editor/vizzy/learn", {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      }).catch(() => {});
    },
    [available, learn],
  );

  // Nothing is "new" the first time: everything is.
  const fresh = lastSeen ? memories.filter((m) => (m.createdAt ?? "") > lastSeen) : [];

  return { available, learn, memories, fresh, firstTime, canAddToBrandVoice, message, setLearn, forget, forgetAll, addToBrandVoice, seen, send };
}
