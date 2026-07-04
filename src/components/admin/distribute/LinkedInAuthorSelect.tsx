"use client";

import { useEffect, useState } from "react";

interface Author {
  urn: string | null;
  label: string;
}

/**
 * "Post as" selector for a LinkedIn post — the connected member or a Company Page the
 * member administers. Renders nothing unless there's a real choice (a Page connected),
 * so non-org tenants see no clutter. `value`/`onChange` carry the org URN (or null = You).
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

  useEffect(() => {
    let live = true;
    fetch("/api/admin/distribute/linkedin-authors")
      .then((r) => (r.ok ? r.json() : { authors: [] }))
      .then((d: { authors?: Author[] }) => {
        if (live) setAuthors(d.authors ?? []);
      })
      .catch(() => live && setAuthors([]));
    return () => {
      live = false;
    };
  }, []);

  // Only offer a choice when there's more than one identity (a Page is connected).
  if (!authors || authors.length <= 1) return null;

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
