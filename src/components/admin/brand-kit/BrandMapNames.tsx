"use client";

import { useState } from "react";
import { BRAND_MAP_LIMITS as LIMITS, BrandMapNameKind, type BrandMapName } from "@/lib/types/brandMap";
import { NAME_KIND_HEADING, newId } from "@/lib/brandMap/changes";
import { Badge, Button, Section, inputClass } from "@/components/admin/connect/ui";
import { Issues, RemoveButton, smallLabel } from "./BrandMapParts";
import { linkLabel } from "./BrandMapIdentity";
import { groupNames, issuesAt, splitList, type MapIssue } from "./brandMapForm";

/** "Names you use": spelled this way every time, and linked to their page. */

const SAME_AS: Record<string, string> = { wikidata: "Wikidata", wikipedia: "Wikipedia", site: "Official site", manual: "Link" };

export function BrandMapNames({
  names,
  onChange,
  issues,
  disabled,
  find,
}: {
  names: BrandMapName[];
  onChange: (next: BrandMapName[]) => void;
  issues: MapIssue[];
  disabled: boolean;
  /** Identifier lookup for one name (when lookups are on). */
  find?: (name: BrandMapName, index: number) => React.ReactNode;
}) {
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<BrandMapName["kind"]>("alternative");
  const update = (i: number, next: BrandMapName) => onChange(names.map((n, j) => (j === i ? next : n)));
  const add = () => {
    const name = draft.replace(/\s+/g, " ").trim();
    if (!name) return;
    onChange([...names, { id: newId("n"), name, kind, aliases: [], sameAs: [] }]);
    setDraft("");
  };

  return (
    <Section title="Names you use" description="Spelled this way every time, and linked to their page.">
      <div className="overflow-x-auto">
        <div className="min-w-[38rem] space-y-1">
          <div className="grid grid-cols-[1.1fr_1.1fr_1.4fr_1.2fr_auto] gap-3 pb-1 text-xs font-medium text-neutral-600 dark:text-neutral-400">
            <span>Name</span>
            <span>Other spellings</span>
            <span>Its page on your site</span>
            <span>Identifiers</span>
            <span className="w-7" />
          </div>
          {groupNames(names)
            .filter((g) => g.rows.length)
            .map((g) => (
              <div key={g.kind}>
                <div className="border-t border-neutral-200 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
                  {NAME_KIND_HEADING[g.kind]}
                </div>
                {g.rows.map(({ name: n, index: i }) => (
                  <div key={n.id} className="space-y-1 border-t border-neutral-100 py-1.5 dark:border-neutral-900">
                    <div className="grid grid-cols-[1.1fr_1.1fr_1.4fr_1.2fr_auto] items-center gap-3">
                      <input
                        aria-label="Name"
                        className={inputClass}
                        value={n.name}
                        maxLength={LIMITS.nameText}
                        disabled={disabled}
                        onChange={(e) => update(i, { ...n, name: e.target.value })}
                      />
                      <input
                        // Remounted when the spellings change from elsewhere (an accepted suggestion).
                        key={n.aliases.join("|")}
                        aria-label={`Other spellings of ${n.name}`}
                        className={inputClass}
                        defaultValue={n.aliases.join(", ")}
                        placeholder="None"
                        disabled={disabled}
                        onBlur={(e) => update(i, { ...n, aliases: splitList(e.target.value, LIMITS.aliases) })}
                      />
                      <input
                        aria-label={`The page on your site for ${n.name}`}
                        className={inputClass}
                        value={n.home ?? ""}
                        placeholder="No page yet"
                        disabled={disabled}
                        onChange={(e) => {
                          const home = e.target.value.trim();
                          const { home: _old, ...rest } = n;
                          void _old;
                          update(i, home ? { ...rest, home } : rest);
                        }}
                      />
                      <div className="flex flex-wrap items-center gap-1.5">
                        {n.sameAs.map((link, j) => (
                          <span key={link.url} className="inline-flex items-center">
                            <a href={link.url} target="_blank" rel="noreferrer" title={linkLabel(link.url)}>
                              <Badge tone="green">{SAME_AS[link.source] ?? "Link"}</Badge>
                            </a>
                            <RemoveButton
                              label={`Remove ${linkLabel(link.url)} from ${n.name}`}
                              disabled={disabled}
                              onClick={() => update(i, { ...n, sameAs: n.sameAs.filter((_, k) => k !== j) })}
                            />
                          </span>
                        ))}
                        {n.kind === "audience" || n.kind === "use_case" ? (
                          <span className="text-xs text-neutral-500">Not needed</span>
                        ) : (
                          find?.(n, i)
                        )}
                      </div>
                      <RemoveButton label={`Remove ${n.name}`} disabled={disabled} onClick={() => onChange(names.filter((_, j) => j !== i))} />
                    </div>
                    <Issues messages={issuesAt(issues, `names.${i}`)} />
                  </div>
                ))}
              </div>
            ))}
        </div>
      </div>
      {!disabled && names.length < LIMITS.names ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="block min-w-[12rem] flex-1 space-y-1">
            <span className={smallLabel}>Add a name</span>
            <input
              className={inputClass}
              value={draft}
              maxLength={LIMITS.nameText}
              placeholder="A product, an alternative, an audience…"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
            />
          </label>
          <label className="block space-y-1">
            <span className={smallLabel}>It is</span>
            <select
              className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
              value={kind}
              onChange={(e) => setKind(BrandMapNameKind.parse(e.target.value))}
            >
              {BrandMapNameKind.options.map((k) => (
                <option key={k} value={k}>
                  {NAME_KIND_HEADING[k]}
                </option>
              ))}
            </select>
          </label>
          <Button onClick={add} disabled={!draft.trim()}>
            Add
          </Button>
        </div>
      ) : null}
    </Section>
  );
}
