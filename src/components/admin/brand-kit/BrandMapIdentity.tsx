"use client";

import { BRAND_MAP_LIMITS as LIMITS, type BrandMapIdentity as Identity, type BrandMapLink } from "@/lib/types/brandMap";
import { Badge, Section, inputClass } from "@/components/admin/connect/ui";
import { AddLine, Issues, RemoveButton, smallLabel } from "./BrandMapParts";
import { issuesAt, type MapIssue } from "./brandMapForm";

/** "What you are": said the same way in every article. */

const SOURCE: Record<BrandMapLink["source"], string> = {
  site: "On your home page",
  wikidata: "Wikidata",
  wikipedia: "Wikipedia",
  manual: "Added by hand",
};

export function linkLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

export function BrandMapIdentity({
  value,
  onChange,
  issues,
  disabled,
  findCategory,
  findBrand,
}: {
  value: Identity;
  onChange: (next: Identity) => void;
  issues: MapIssue[];
  disabled: boolean;
  /** Identifier lookup for the category. */
  findCategory?: React.ReactNode;
  /** Identifier lookup for the brand itself (its Wikidata item and Wikipedia page go with its profiles). */
  findBrand?: React.ReactNode;
}) {
  const set = <K extends keyof Identity>(key: K, v: Identity[K]) => onChange({ ...value, [key]: v });
  const at = (path: string) => issuesAt(issues, `identity.${path}`);

  return (
    <Section title="What you are" description="Said the same way in every article.">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="block space-y-1">
            <span className={smallLabel}>Name</span>
            <input className={inputClass} value={value.name} maxLength={LIMITS.name} disabled={disabled} onChange={(e) => set("name", e.target.value)} />
          </label>
          <Issues messages={at("name")} />
        </div>
        <div className="space-y-1">
          <label className="block space-y-1">
            <span className={smallLabel}>Category</span>
            <input
              className={inputClass}
              value={value.category}
              maxLength={LIMITS.category}
              placeholder="As buyers say it"
              disabled={disabled}
              onChange={(e) => set("category", e.target.value)}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
            {value.categorySameAs.length ? (
              value.categorySameAs.map((link, i) => (
                <span key={link.url} className="inline-flex items-center gap-1">
                  <Badge tone="green">{SOURCE[link.source]}</Badge>
                  <a href={link.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                    {linkLabel(link.url)}
                  </a>
                  <RemoveButton
                    label={`Remove ${linkLabel(link.url)}`}
                    disabled={disabled}
                    onClick={() => set("categorySameAs", value.categorySameAs.filter((_, j) => j !== i))}
                  />
                </span>
              ))
            ) : (
              <span>No identifier yet</span>
            )}
            {findCategory}
          </div>
          <Issues messages={at("categorySameAs")} />
        </div>
      </div>

      <div className="space-y-1">
        <label className="block space-y-1">
          <span className={`${smallLabel} flex justify-between`}>
            <span>In one sentence</span>
            <span className="font-normal text-neutral-500">
              {value.statement.length} of {LIMITS.statement}
            </span>
          </span>
          <textarea
            className={`${inputClass} resize-y`}
            rows={2}
            value={value.statement}
            maxLength={LIMITS.statement}
            placeholder="What it is, and who it is for."
            disabled={disabled}
            onChange={(e) => set("statement", e.target.value.replace(/\s*\n\s*/g, " "))}
          />
        </label>
        <Issues messages={at("statement")} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <span className={smallLabel}>It is not</span>
          <ul className="space-y-1.5">
            {value.isNot.map((line, i) => (
              <li key={`${i}:${line}`} className="flex items-center justify-between gap-2 rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm dark:border-neutral-800">
                <span className="min-w-0">{line}</span>
                <RemoveButton label={`Remove: ${line}`} disabled={disabled} onClick={() => set("isNot", value.isNot.filter((_, j) => j !== i))} />
              </li>
            ))}
          </ul>
          {!disabled && value.isNot.length < LIMITS.isNot ? (
            <AddLine label="Something you are not" placeholder="A general SEO suite" maxLength={LIMITS.isNotText} onAdd={(t) => set("isNot", [...value.isNot, t])} />
          ) : null}
          <Issues messages={at("isNot")} />
        </div>

        <div className="space-y-1.5">
          <span className={smallLabel}>Names to avoid</span>
          <ul className="space-y-1.5">
            {value.avoid.map((a, i) => (
              <li key={`${i}:${a.term}`} className="flex items-center gap-2 rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm dark:border-neutral-800">
                <span className="text-neutral-500 line-through">{a.term}</span>
                <span className="text-xs text-neutral-500">say</span>
                <input
                  aria-label={`Say instead of ${a.term}`}
                  className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none"
                  value={a.useInstead}
                  maxLength={LIMITS.avoidTerm}
                  placeholder="(just don't use it)"
                  disabled={disabled}
                  onChange={(e) => set("avoid", value.avoid.map((x, j) => (j === i ? { ...x, useInstead: e.target.value } : x)))}
                />
                <RemoveButton label={`Remove: ${a.term}`} disabled={disabled} onClick={() => set("avoid", value.avoid.filter((_, j) => j !== i))} />
              </li>
            ))}
          </ul>
          {!disabled && value.avoid.length < LIMITS.avoid ? (
            <AddLine
              label="A name you don't use"
              placeholder="GEO tool"
              maxLength={LIMITS.avoidTerm}
              onAdd={(t) => set("avoid", [...value.avoid, { term: t, useInstead: value.category }])}
            />
          ) : null}
          <Issues messages={at("avoid")} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="block space-y-1">
            <span className={smallLabel}>Site</span>
            <input
              className={inputClass}
              value={value.site}
              placeholder="https://"
              disabled={disabled}
              onChange={(e) => set("site", e.target.value.trim())}
            />
          </label>
          <Issues messages={at("site")} />
        </div>
        <div className="space-y-1.5">
          <span className={smallLabel}>Profile links</span>
          <ul className="space-y-1.5">
            {value.profiles.map((link, i) => (
              <li key={link.url} className="flex flex-wrap items-center gap-2 text-sm">
                <a href={link.url} target="_blank" rel="noreferrer" className="font-mono text-xs underline underline-offset-2">
                  {linkLabel(link.url)}
                </a>
                <Badge tone={link.confirmedAt ? "green" : "neutral"}>{link.confirmedAt ? "Confirmed" : SOURCE[link.source]}</Badge>
                <RemoveButton label={`Remove ${linkLabel(link.url)}`} disabled={disabled} onClick={() => set("profiles", value.profiles.filter((_, j) => j !== i))} />
              </li>
            ))}
          </ul>
          {findBrand ? <div>{findBrand}</div> : null}
          {!disabled && value.profiles.length < LIMITS.profiles ? (
            <AddLine
              label="A profile link"
              placeholder="https://www.linkedin.com/company/…"
              onAdd={(t) => {
                if (!/^https:\/\//i.test(t)) return false;
                set("profiles", [...value.profiles, { url: t, source: "manual", confirmedAt: "" }]);
              }}
            />
          ) : null}
          <Issues messages={at("profiles")} />
        </div>
      </div>
    </Section>
  );
}
