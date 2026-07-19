"use client";

import { useEffect, useRef, useState } from "react";

interface Author {
  urn: string | null;
  label: string;
}

/**
 * "Post as" selector for a LinkedIn post — the connected member or a Company Page the
 * member administers. Rendered whenever a Company Page is connected (or there's >1
 * identity); a personal-only (or unconnected) tenant sees no single-option clutter.
 * `value`/`onChange` carry the org URN (or null = You).
 *
 * Company-Page-only default: when the tenant has NO personal connection (only Pages —
 * the CM-API setup) and nothing is chosen yet, it auto-selects the first Page. Without
 * this a new LinkedIn post falls to the personal author, which isn't connected, and
 * parks as linkedin_not_connected.
 */
export function LinkedInAuthorSelect({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  onChange: (urn: string | null) => void;
  disabled?: boolean;
}) {
  const [authors, setAuthors] = useState<Author[] | null>(null);
  // Latest value/onChange without re-triggering the one-shot fetch effect below — keeps
  // it []-dep + lint-clean while defaulting against the freshest selection.
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    let live = true;
    fetch("/api/admin/distribute/linkedin-authors")
      .then((r) => (r.ok ? r.json() : { authors: [] }))
      .then((d: { authors?: Author[] }) => {
        if (!live) return;
        const list = d.authors ?? [];
        setAuthors(list);
        // Default to the sole/first Page when there's no personal identity and nothing
        // is selected yet — else the post parks on a missing personal author.
        const hasPersonal = list.some((a) => a.urn === null);
        const firstPage = list.find((a) => a.urn !== null);
        if (valueRef.current == null && !hasPersonal && firstPage) {
          onChangeRef.current(firstPage.urn);
        }
      })
      .catch(() => live && setAuthors([]));
    return () => {
      live = false;
    };
  }, []);

  // Offer the picker whenever a Page is connected (or there's >1 identity); hide it for a
  // personal-only or unconnected tenant so there's no pointless single-option select.
  if (!authors) return null;
  const hasPage = authors.some((a) => a.urn !== null);
  if (authors.length <= 1 && !hasPage) return null;

  return (
    <label className="flex items-center gap-1 text-xs text-neutral-500">
      Post as
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={disabled}
        className="rounded border border-neutral-300 bg-transparent px-1.5 py-1 text-xs disabled:opacity-40 dark:border-neutral-700"
      >
        {authors.map((a) => (
          <option key={a.urn ?? "me"} value={a.urn ?? ""}>
            {a.label}
          </option>
        ))}
      </select>
    </label>
  );
}
