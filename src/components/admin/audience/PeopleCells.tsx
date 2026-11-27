"use client";

import type { PeopleRow } from "@/lib/audience/peopleList";
import { Chip, type ChipTone } from "../people/Chip";

/**
 * The People list's cells that show more than a value: where someone came from, their stage in
 * each product, and whether they can be emailed. The list and its views (CRM_VIEWS_ENABLED) show
 * the same cells.
 */

export const STAGE_LABEL = { new: "New", onboarding: "Onboarding", stuck: "Stuck", activated: "Activated", member: "Member", quiet: "Quiet" } as const;
const STAGE_TONE: Record<keyof typeof STAGE_LABEL, ChipTone> = {
  new: "blue",
  onboarding: "blue",
  stuck: "amber",
  activated: "green",
  member: "neutral",
  quiet: "amber",
};
const LAUNCH_STATUS: Record<string, string> = { verified_active: "Confirmed", unverified: "Not confirmed", offboarded: "Offboarded" };
const BLOCKED: Record<string, string> = { unsubscribe: "Unsubscribed", spam: "Marked as spam", hard_bounce: "Address bounced" };

/** Their launches (ideas), products, and Added by hand. */
export function WhereFromCell({ p }: { p: PeopleRow }) {
  return (
    <span className="flex max-w-[18rem] flex-wrap gap-1">
      {p.launches.map((l) => (
        <Chip key={l.id} tone="neutral" title={`${LAUNCH_STATUS[l.status] ?? l.status}${l.via === "site" ? ", from your site" : ""}`}>
          {l.name}
        </Chip>
      ))}
      {p.products.map((x, i) => (
        <Chip key={`${x.id}:${i}`} tone="blue">
          {x.name}
        </Chip>
      ))}
      {p.addedByHand ? <Chip tone="neutral">Added by hand</Chip> : null}
    </span>
  );
}

/** Their stage in each product, or whether they confirmed when they only joined a launch. */
export function StageCell({ p, multiProduct }: { p: PeopleRow; multiProduct: boolean }) {
  return (
    <span className="flex flex-wrap gap-1">
      {p.products.map((x, i) => (
        <span key={`${x.id}:${i}`} className="flex gap-1">
          {x.stage === "member" ? null : (
            <Chip tone={STAGE_TONE[x.stage]} title={multiProduct ? x.name : undefined}>
              {STAGE_LABEL[x.stage]}
            </Chip>
          )}
          {x.quiet ? <Chip tone="amber">Quiet</Chip> : null}
        </span>
      ))}
      {p.products.length === 0
        ? p.launches.slice(0, 1).map((l) => (
            <Chip key={l.id} tone={l.status === "verified_active" ? "green" : "neutral"}>
              {LAUNCH_STATUS[l.status] ?? l.status}
            </Chip>
          ))
        : null}
    </span>
  );
}

/** Whether we can email them, and why not. */
export function CanEmailCell({ p }: { p: PeopleRow }) {
  if (p.reach === "yes") {
    return p.addedByHand && !p.launches.length && !p.products.length ? (
      <Chip tone="green" title="Your team recorded that they agreed. Nothing is sent to people added by hand yet.">
        Yes, recorded
      </Chip>
    ) : (
      <Chip tone="green">Yes</Chip>
    );
  }
  if (p.addedByHand && !p.blocked && !p.launches.length && !p.products.length) {
    return p.consentWithdrawn ? (
      <Chip tone="neutral" title="Your team recorded that they withdrew their agreement.">
        Withdrawn
      </Chip>
    ) : (
      <Chip tone="neutral">Not yet</Chip>
    );
  }
  if (p.reach === "limited") {
    return (
      <Chip tone="amber" title="Some emails only: service emails, the confirmation, or not every category">
        Some
      </Chip>
    );
  }
  return (
    <Chip tone="red" title={p.blocked ? BLOCKED[p.blocked] : undefined}>
      {p.blocked ? BLOCKED[p.blocked] : "No"}
    </Chip>
  );
}
