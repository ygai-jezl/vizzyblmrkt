"use client";

import { useId, useMemo, useRef, useState } from "react";

/** A subject as a search lists it. */
export interface SubjectName {
  id: string;
  name: string;
}

/** What a pick means: a subject, research picks one (undefined), or none of them (null). */
export type SubjectPick = SubjectName | null | undefined;

const SHOWN = 12;

/** "Share of voice" matches "share", "voice", "share of voice", "sov"… by every typed word. */
export function matchSubjects(names: SubjectName[], query: string, limit = SHOWN): SubjectName[] {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return names.slice(0, limit);
  return names
    .map((n) => {
      const name = n.name.toLowerCase();
      if (!words.every((w) => name.includes(w))) return null;
      // A name that starts with what was typed comes first, then the shorter.
      return { n, rank: (name.startsWith(words[0]!) ? 0 : 1) * 1000 + name.length };
    })
    .filter((x): x is { n: SubjectName; rank: number } => x !== null)
    .sort((a, b) => a.rank - b.rank || a.n.name.localeCompare(b.n.name))
    .slice(0, limit)
    .map((x) => x.n);
}

/**
 * Choose a brand map subject by searching for it (the map at any size, where a list of every
 * subject would be thousands long). Every name is read once, the first time it is used.
 */
export function MapSubjectSearch({
  value,
  onPick,
  label = "Subject",
  inputClassName = "",
  disabled = false,
}: {
  /** The subject chosen (with its name), null for none of these, undefined for research to pick. */
  value: SubjectPick;
  onPick: (pick: SubjectPick) => void;
  label?: string;
  inputClassName?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const [names, setNames] = useState<SubjectName[] | null>(null);
  const [query, setQuery] = useState("");
  const [failed, setFailed] = useState(false);
  const loading = useRef(false);

  async function load() {
    if (names || loading.current) return;
    loading.current = true;
    try {
      const res = await fetch("/api/admin/brand-kit/map/subjects/names", { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as { subjects?: Array<SubjectName & { status?: string }> } | null;
      if (!res.ok || !body?.subjects) throw new Error("names");
      setNames(body.subjects.filter((s) => s.status !== "proposed").map((s) => ({ id: s.id, name: s.name })));
    } catch {
      setFailed(true);
    } finally {
      loading.current = false;
    }
  }

  const found = useMemo(() => (names ? matchSubjects(names, query) : []), [names, query]);
  const chosen = value === undefined ? "Not chosen yet: research picks one" : value === null ? "None of these" : value.name;

  return (
    <div className="space-y-1.5">
      <label htmlFor={`${id}-q`} className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
        {label}: <span className="font-normal text-neutral-900 dark:text-neutral-100">{chosen}</span>
      </label>
      <input
        id={`${id}-q`}
        type="search"
        value={query}
        disabled={disabled}
        onFocus={() => void load()}
        onChange={(e) => {
          setQuery(e.target.value);
          void load();
        }}
        placeholder="Search your subjects"
        aria-controls={`${id}-list`}
        className={inputClassName}
      />
      {failed ? <p className="text-[11px] text-red-600 dark:text-red-400">Couldn&apos;t load your subjects. Try again.</p> : null}
      {names && query.trim() ? (
        <ul id={`${id}-list`} aria-label="Matching subjects" className="max-h-56 overflow-auto rounded-md border border-neutral-200 dark:border-neutral-800">
          {found.length ? (
            found.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onPick(s);
                    setQuery("");
                  }}
                  className="block w-full px-2 py-1.5 text-left text-xs hover:bg-neutral-50 dark:hover:bg-neutral-900"
                >
                  {s.name}
                </button>
              </li>
            ))
          ) : (
            <li className="px-2 py-1.5 text-xs text-neutral-500">No subject matches.</li>
          )}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2 text-[11px]">
        <button type="button" disabled={disabled} onClick={() => onPick(undefined)} className="rounded border border-neutral-300 px-2 py-0.5 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800">
          Let research choose
        </button>
        <button type="button" disabled={disabled} onClick={() => onPick(null)} className="rounded border border-neutral-300 px-2 py-0.5 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800">
          None of these
        </button>
      </div>
    </div>
  );
}
