import { ConnectorLockup, ConnectorTile } from "@/components/admin/connectors/ConnectorTile";
import { chatSourceOf, COLLECTED_SUFFIX, type ChatSource } from "./sourceData";

/**
 * The line under a Vizzy answer that read connected data: where its numbers came from, each tool's
 * mark and name linked to the tool's own dashboard, so the numbers can be checked there. Google
 * Analytics shows its wide logo instead, linked to Google Analytics, as its branding policy asks
 * wherever an app shows its data (at least 154 by 50; the manifest's lockup is 189 by 50, which fits
 * the docked panel). No hooks: names, marks and links come from the manifests only.
 */

export const SOURCE_COPY = {
  from: "Numbers from",
  newTab: " (opens in a new tab)",
  /** After the name, when the numbers were the ones YouGrow collected rather than read live. */
  collected: "(collected)",
} as const;

function Source({ s }: { s: ChatSource }) {
  // The logo has its words in it, as its owner asks, so collected is said to screen readers only.
  if (s.icon?.lockup)
    return (
      <span className="inline-flex items-center">
        <ConnectorLockup lockup={s.icon.lockup} />
        {s.collected ? <span className="sr-only"> {SOURCE_COPY.collected}</span> : null}
      </span>
    );
  const label = (
    <>
      <ConnectorTile id={s.id} name={s.name} initials={s.initials} icon={s.icon} size="sm" />
      <span>{s.collected ? `${s.name} ${SOURCE_COPY.collected}` : s.name}</span>
    </>
  );
  const look = "inline-flex items-center gap-1.5 font-medium text-neutral-700 dark:text-neutral-200";
  if (!s.home) return <span className={look}>{label}</span>;
  return (
    <a href={s.home} target="_blank" rel="noopener noreferrer" className={`${look} rounded underline-offset-2 hover:underline`}>
      {label}
      <span className="sr-only">{SOURCE_COPY.newTab}</span>
    </a>
  );
}

/**
 * The sources of one answer, by connector id in the order read (collected numbers as
 * "<id>:collected"); nothing for ids no manifest has. A wide logo shows once, however its numbers
 * were read.
 */
export function SourceLine({ ids }: { ids: readonly string[] }) {
  const all = ids.map(chatSourceOf).filter((s): s is ChatSource => s !== null);
  const sources = all.filter((s, i) => !s.icon?.lockup || all.findIndex((o) => o.id === s.id) === i);
  if (!sources.length) return null;
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-neutral-500 dark:text-neutral-400">
      <span>{SOURCE_COPY.from}</span>
      {sources.map((s) => (
        <Source key={`${s.id}${s.collected ? COLLECTED_SUFFIX : ""}`} s={s} />
      ))}
    </p>
  );
}
