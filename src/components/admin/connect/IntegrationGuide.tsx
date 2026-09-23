"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Circle, Info } from "lucide-react";
import type { GuideStatus, IntegrationGuide as Guide } from "@/lib/connect/integrationGuide";
import { api, errorText, type PublicConnection } from "./api";
import { Badge, Banner, Section } from "./ui";
import { CopyAgentPrompt } from "./CopyAgentPrompt";
import { IntegrationTasks } from "./IntegrationTasks";
import { CodeText } from "./CodeText";

/**
 * What this product's developers need to build, with their own ids — from the
 * catalog and what "Learn from repo" found in their code. Links to the full docs.
 */

const HOW: Record<string, string> = {
  server_event: "send it where the server makes this happen",
  reconcile: "a scheduled check of stored state (use a stable messageId)",
  client_only: "only computed in the browser today — check stored state on a schedule",
};

function Tick({ s }: { s: GuideStatus }) {
  if (s === "done") return <CheckCircle2 size={16} className="text-green-600" />;
  if (s === "info") return <Info size={16} className="text-neutral-400" />;
  return <Circle size={16} className="text-neutral-400" />;
}

export function IntegrationGuide({ connection }: { connection: PublicConnection }) {
  const [guide, setGuide] = useState<Guide | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await api<{ guide: Guide }>(`/api/admin/connections/${connection.id}/guide`);
      if (!r.ok) return setErr(errorText(r.data));
      setGuide(r.data.guide);
    })();
  }, [connection.id]);

  if (err) return <Banner tone="err">{err}</Banner>;
  if (!guide) return <p className="text-sm text-neutral-500">Loading…</p>;

  const code = (s: string) => <code className="rounded bg-neutral-100 px-1 font-mono text-xs dark:bg-neutral-800">{s}</code>;

  return (
    <div className="space-y-4">
      <Section
        title="Integration guide"
        description="What your developers need to build, using this product's own ids. Share this page with them, along with the developer docs."
      >
        <ul className="grid gap-1 text-sm sm:grid-cols-2">
          <li className="flex items-center gap-2"><Tick s={guide.status.catalog} /> Catalog has onboarding steps</li>
          <li className="flex items-center gap-2"><Tick s={guide.status.eventsReceived} /> Events are arriving</li>
          <li className="flex items-center gap-2"><Tick s={guide.status.contextEndpoint} /> Context endpoint tested OK</li>
          <li className="flex items-center gap-2"><Tick s={guide.status.webhookEndpoint} /> Webhook endpoint set (optional)</li>
        </ul>
        <p className="text-sm">
          Key id {code(guide.keyId)} · events go to {code(guide.eventsUrl)} ·{" "}
          <a className="underline" href={guide.docsUrl} target="_blank" rel="noreferrer">
            developer docs
          </a>
        </p>
        {!guide.fromRepo ? (
          <p className="text-xs text-neutral-500">Tip: run <strong>Learn from repo</strong> — the guide then includes how each step can be detected in your code, and anything your code doesn&apos;t handle yet.</p>
        ) : null}
      </Section>

      <CopyAgentPrompt connectionId={connection.id} prompt={guide.agentPrompt} />

      <Section
        title="What to build, in priority order"
        description="Only the first is required for journeys to run. The rest make the emails personal, or keep them compliant — each says what happens if it's skipped."
      >
        <IntegrationTasks tasks={guide.tasks} />
      </Section>

      {guide.warnings.length > 0 ? (
        <Banner tone="info">
          <span className="font-medium">Gaps we noticed in your code:</span>{" "}
          {guide.warnings.map((w, i) => (
            <span key={i}>
              {i ? " · " : ""}
              <CodeText text={w} />
            </span>
          ))}
        </Banner>
      ) : null}

      <h3 className="pt-2 text-sm font-semibold">Reference: the exact details</h3>

      <Section title="1. Identify each user at sign-up" description="An identify message with these traits, alongside user.signed_up.">
        <ul className="space-y-1 text-sm">
          {guide.identify.traits.map((t) => (
            <li key={t.key}>
              {code(t.key)} <span className="text-neutral-600 dark:text-neutral-400">{t.note}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="2. Send these events" description="Each with a unique messageId. Retries are safe.">
        <ul className="divide-y divide-neutral-100 text-sm dark:divide-neutral-900">
          {guide.events.map((e, i) => (
            <li key={i} className="py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                {code(e.name)}
                {e.properties ? code(JSON.stringify(e.properties)) : null}
                {e.how ? <Badge>{e.how === "server_event" ? "server event" : e.how === "reconcile" ? "scheduled check" : "browser only"}</Badge> : null}
              </div>
              <p className="text-neutral-600 dark:text-neutral-400">
                {e.when}
                {e.how ? ` — ${HOW[e.how]}.` : ""}
              </p>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="3. Build the context endpoint" description="We call it just before emailing someone. Return their live state — see the docs for the full format and how to verify our requests.">
        <h4 className="text-xs font-semibold uppercase text-neutral-500">steps</h4>
        <ul className="space-y-1 text-sm">
          {guide.context.steps.map((s) => (
            <li key={s.id}>
              {code(s.id)} {s.label}
              {s.completion ? <span className="text-neutral-500"> — done when {s.completion.charAt(0).toLowerCase() + s.completion.slice(1)}</span> : null}
            </li>
          ))}
          {guide.context.steps.length === 0 ? <li className="text-neutral-500">Add onboarding steps to the catalog first.</li> : null}
        </ul>
        <h4 className="mt-3 text-xs font-semibold uppercase text-neutral-500">facts</h4>
        <ul className="space-y-1 text-sm">
          {guide.context.facts.map((f) => (
            <li key={f.id}>
              {code(f.id)} {f.label}
              {f.unit ? ` (${f.unit})` : ""}
              {f.source ? <span className="text-neutral-500"> — from {f.source}</span> : null}
            </li>
          ))}
          {guide.context.facts.length === 0 ? <li className="text-neutral-500">No facts in the catalog yet — add the numbers your product can report about each user.</li> : null}
        </ul>
        <h4 className="mt-3 text-xs font-semibold uppercase text-neutral-500">exit — never email these people</h4>
        <ul className="space-y-1 text-sm">
          {guide.context.exitRules.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
          {guide.context.exitRules.length === 0 ? <li className="text-neutral-500">E.g. staff, invited team members, accounts pending deletion — return <code>exit</code> for them.</li> : null}
        </ul>
      </Section>

    </div>
  );
}
