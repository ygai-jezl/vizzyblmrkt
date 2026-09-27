"use client";

import { JOURNEY_ABOUT_DEFAULT, type JourneyAbout, type LifecycleSettings } from "@/lib/types/lifecycle";
import type { ConnectionCatalog } from "@/lib/types/productConnection";
import { Field, Section, inputClass } from "../connect/ui";

/**
 * What a journey's emails are about when people have several of something —
 * workspaces, brands, projects (API v2 `entities`, named in the catalog): the
 * person, one of their entities picked by a rule, all of them, or each one
 * separately.
 */

const PICKS: Array<{ id: JourneyAbout["pick"]; label: (one: string) => string }> = [
  { id: "focus", label: (one) => `The ${one} they're setting up — follows their onboarding, ending on a finished one` },
  { id: "trigger", label: (one) => `The ${one} the trigger happened to` },
  { id: "recent", label: (one) => `The ${one} they worked on most recently` },
  { id: "fact_high", label: () => "The highest on a fact" },
  { id: "fact_low", label: () => "The lowest on a fact" },
];

export function AboutSection({
  settings,
  catalog,
  readOnly,
  onChange,
}: {
  settings: LifecycleSettings;
  catalog: ConnectionCatalog | undefined;
  readOnly: boolean;
  onChange: (next: LifecycleSettings) => void;
}) {
  const about = settings.about ?? JOURNEY_ABOUT_DEFAULT;
  const kinds = catalog?.entityKinds ?? [];
  const set = (patch: Partial<JourneyAbout>) => onChange({ ...settings, about: { ...about, ...patch } });
  const kind = kinds.find((k) => k.kind === about.kind) ?? kinds[0];
  const one = kind?.label ?? "one";
  const many = kind?.plural ?? "them";
  const facts = (catalog?.facts ?? []).filter((f) => !kind || f.kind === kind.kind || !f.kind);

  return (
    <Section
      title="About"
      description="When people have several of something — workspaces, brands, projects — which of them this journey's emails are about. Each person still gets one journey."
    >
      {kinds.length === 0 ? (
        <p className="text-sm text-neutral-500">
          This product&apos;s catalog has no kinds of thing people have several of. Add them in Products → Catalog (or Learn
          from repo), and have the product send them as <code>entities</code>.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Emails are about">
              <select
                className={inputClass}
                disabled={readOnly}
                value={about.mode}
                onChange={(e) => {
                  const mode = e.target.value as JourneyAbout["mode"];
                  set({ mode, kind: mode === "person" ? null : (about.kind ?? kinds[0]!.kind) });
                }}
              >
                <option value="person">The person</option>
                <option value="one">One of their {many}</option>
                <option value="all">All their {many}, in one email</option>
                <option value="each">Each {one} separately</option>
              </select>
            </Field>
            {about.mode !== "person" ? (
              <Field label="Of kind">
                <select className={inputClass} disabled={readOnly} value={about.kind ?? ""} onChange={(e) => set({ kind: e.target.value })}>
                  {kinds.map((k) => (
                    <option key={k.kind} value={k.kind}>
                      {k.plural}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
          </div>

          {about.mode === "one" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Which one" hint="Every rule but the first keeps its choice, so a sequence never switches mid-way.">
                <select className={inputClass} disabled={readOnly} value={about.pick} onChange={(e) => set({ pick: e.target.value as JourneyAbout["pick"] })}>
                  {PICKS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label(one)}
                    </option>
                  ))}
                </select>
              </Field>
              {about.pick === "fact_high" || about.pick === "fact_low" ? (
                <Field label="Fact">
                  <select className={inputClass} disabled={readOnly} value={about.fact ?? ""} onChange={(e) => set({ fact: e.target.value || null })}>
                    <option value="">Choose…</option>
                    {facts.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}
            </div>
          ) : null}

          {about.mode === "all" ? (
            <Field label={`${many[0]?.toUpperCase() ?? ""}${many.slice(1)} listed in one email`} hint="The rest show as “and 3 more”. Put {{block.entities}} in the email.">
              <input
                className={inputClass}
                type="number"
                min={1}
                max={20}
                disabled={readOnly}
                value={about.maxListed}
                onChange={(e) => set({ maxListed: Math.min(20, Math.max(1, Number(e.target.value) || 1)) })}
              />
            </Field>
          ) : null}

          {about.mode === "each" ? (
            <p className="text-xs text-neutral-500">
              One enrolment per {one}, and at most one email a day to the person across them. Use it sparingly — most journeys
              are better about one {one}, or all of them in one email.
            </p>
          ) : null}

          {about.mode !== "person" ? (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5" disabled={readOnly} checked={about.includeJoined} onChange={(e) => set({ includeJoined: e.target.checked })} />
              <span>
                Include {many} they only joined or were invited to
                <span className="block text-xs text-neutral-500">Off: only the ones they own. Their onboarding always counts only what they own.</span>
              </span>
            </label>
          ) : null}

          <p className="text-xs text-neutral-500">
            In emails: {"{{entity.name}}"} and {"{{entity.kind}}"} name the one an email is about (give a fallback, e.g.{" "}
            {`{{entity.name|your ${one}}}`}); {"{{entities.count}}"} and {"{{block.entities}}"} cover all of them.
          </p>
        </div>
      )}
    </Section>
  );
}
