"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Circle, Info } from "lucide-react";
import type { GuideField, GuideStatus, IntegrationGuide as Guide } from "@/lib/connect/integrationGuide";
import { api, errorText, type PublicConnection } from "./api";
import { Badge, Banner, Section } from "./ui";
import { CopyAgentPrompt } from "./CopyAgentPrompt";
import { IntegrationTasks } from "./IntegrationTasks";
import { CodeText } from "./CodeText";

/**
 * What this product's developers need to build, with their own ids — from the
 * catalog and what "Learn from repo" found in their code. API v2: each user's
 * state, field by field. Links to the full docs.
 */

const HOW: Record<string, string> = {
  server_event: "set it where the server makes this happen",
  reconcile: "a scheduled sync of stored state (resending is harmless)",
  client_only: "only computed in the browser today — sync it from stored state on a schedule",
};

const HOW_BADGE: Record<string, string> = { server_event: "server moment", reconcile: "scheduled sync", client_only: "browser only" };

function Tick({ s }: { s: GuideStatus }) {
  if (s === "done") return <CheckCircle2 size={16} className="text-green-600" />;
  if (s === "info") return <Info size={16} className="text-neutral-400" />;
  return <Circle size={16} className="text-neutral-400" />;
}

function Mono({ children }: { children: string }) {
  return <code className="rounded bg-neutral-100 px-1 font-mono text-xs dark:bg-neutral-800">{children}</code>;
}

/** Each field with a fixed value to send, or its type, and when. */
function FieldList({ fields }: { fields: GuideField[] }) {
  return (
    <ul className="divide-y divide-neutral-100 text-sm dark:divide-neutral-900">
      {fields.map((f) => (
        <li key={f.field} className="py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Mono>{f.field}</Mono>
            {f.example ? <Mono>{f.example}</Mono> : <span className="text-xs text-neutral-500">{f.type}</span>}
            {f.how ? <Badge>{HOW_BADGE[f.how] ?? f.how}</Badge> : null}
          </div>
          <p className="text-neutral-600 dark:text-neutral-400">
            <CodeText text={f.when} />
            {f.how && HOW[f.how] ? ` — ${HOW[f.how]}.` : ""}
          </p>
        </li>
      ))}
    </ul>
  );
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

  const { send } = guide;

  return (
    <div className="space-y-4">
      <Section
        title="Integration guide"
        description="What your developers need to build, using this product's own ids. Share this page with them, along with the developer docs."
      >
        <ul className="grid gap-1 text-sm sm:grid-cols-2">
          <li className="flex items-center gap-2"><Tick s={guide.status.catalog} /> Catalog has onboarding steps</li>
          <li className="flex items-center gap-2"><Tick s={guide.status.eventsReceived} /> Users are arriving</li>
          <li className="flex items-center gap-2"><Tick s={guide.status.contextEndpoint} /> Context endpoint tested OK (optional)</li>
          <li className="flex items-center gap-2"><Tick s={guide.status.webhookEndpoint} /> Webhook endpoint set (optional)</li>
        </ul>
        <p className="text-sm">
          Key id <Mono>{guide.keyId}</Mono> · each user&apos;s state goes to <Mono>{`PATCH ${guide.usersUrl}`}</Mono>
          {guide.docsUrl ? (
            <>
              {" "}
              ·{" "}
              <a className="underline" href={guide.docsUrl} target="_blank" rel="noreferrer">
                developer docs
              </a>
            </>
          ) : null}
        </p>
        {!guide.fromRepo ? (
          <p className="text-xs text-neutral-500">Tip: run <strong>Learn from repo</strong> — the guide then includes how each step can be detected in your code, and anything your code doesn&apos;t handle yet.</p>
        ) : null}
      </Section>

      <CopyAgentPrompt connectionId={connection.id} prompt={guide.agentPrompt} />

      <Section
        title="What to build, in priority order"
        description="Only the first is required for journeys to run. The rest keep them compliant, or make the emails personal — each says what happens if it's skipped."
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

      <h3 className="pt-2 text-sm font-semibold">Reference: what to send</h3>

      <Section title="1. At sign-up" description="One PATCH with these fields, where your server creates the account. userId is your own id for the user.">
        <FieldList fields={send.signup} />
      </Section>

      <Section title="2. Opt-outs, exclusions and deletion" description="In the same PATCH whenever they change — they decide who may be emailed.">
        <FieldList fields={send.compliance} />
        <p className="text-sm">
          <Mono>{"DELETE /api/v2/users/{userId}"}</Mono>{" "}
          <span className="text-neutral-600 dark:text-neutral-400">
            <CodeText text={send.deletion} />
          </span>
        </p>
      </Section>

      <Section
        title="3. Onboarding steps and facts"
        description="In the same PATCH whenever they change. A step's value is the time it was done (null if it's undone); a fact's is its latest value."
      >
        {send.progress.length ? (
          <FieldList fields={send.progress} />
        ) : (
          <p className="text-sm text-neutral-500">Add onboarding steps and facts to the catalog first.</p>
        )}
      </Section>

      {send.milestones.length > 0 ? (
        <Section title="Optional: milestones" description="POST /api/v2/users/{userId}/events, for moments that matter in themselves. Journeys can start from them or branch on them.">
          <ul className="space-y-1 text-sm">
            {send.milestones.map((m) => (
              <li key={m.event}>
                <Mono>{m.event}</Mono> <span className="text-neutral-600 dark:text-neutral-400">{m.when}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section
        title="Optional: the context endpoint"
        description="Only if some values change too fast to send. We call it just before emailing someone and use its answer over the stored state — see the docs for the format and how to verify our requests."
      >
        <h4 className="text-xs font-semibold uppercase text-neutral-500">steps</h4>
        <ul className="space-y-1 text-sm">
          {guide.context.steps.map((s) => (
            <li key={s.id}>
              <Mono>{s.id}</Mono> {s.label}
              {s.completion ? <span className="text-neutral-500"> — done when {s.completion.charAt(0).toLowerCase() + s.completion.slice(1)}</span> : null}
            </li>
          ))}
          {guide.context.steps.length === 0 ? <li className="text-neutral-500">Add onboarding steps to the catalog first.</li> : null}
        </ul>
        <h4 className="mt-3 text-xs font-semibold uppercase text-neutral-500">facts</h4>
        <ul className="space-y-1 text-sm">
          {guide.context.facts.map((f) => (
            <li key={f.id}>
              <Mono>{f.id}</Mono> {f.label}
              {f.unit ? ` (${f.unit})` : ""}
              {f.source ? <span className="text-neutral-500"> — from {f.source}</span> : null}
            </li>
          ))}
          {guide.context.facts.length === 0 ? <li className="text-neutral-500">No facts in the catalog yet — add the numbers your product can report about each user.</li> : null}
        </ul>
      </Section>
    </div>
  );
}
