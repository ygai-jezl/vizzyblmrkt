"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { environmentOf, promotionTarget } from "@/lib/connect/environments";
import { setupSteps, type SetupStep } from "@/lib/connect/setupChecklist";
import { isInvitesUiEnabled } from "@/lib/invites/flags";
import { api, errorText, type PublicConnection } from "./api";
import { Banner, Section } from "./ui";

type Tab = NonNullable<SetupStep["tab"]>;

interface JourneysResponse {
  journeys: Array<{ connectionId: string; status: string; deliveryMode: string; publishedVersion: number | null }>;
  connections: Array<{ id: string; name: string; kind: "custom" | "sandbox"; environment?: "staging" | "production" | null }>;
}

/**
 * Setup (nav v2 phase 3): this product's setup as one checklist, in the order
 * the work happens, each step opening the tab or page where it's done.
 */
export function SetupPanel({ connection, onOpenTab }: { connection: PublicConnection; onOpenTab: (tab: Tab) => void }) {
  const [steps, setSteps] = useState<SetupStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [guide, journeys, invites] = await Promise.all([
        api<{ guide: { status: { catalog: "done" | "todo"; eventsReceived: "done" | "todo"; contextEndpoint: "done" | "todo" } } }>(
          `/api/admin/connections/${connection.id}/guide`,
        ),
        api<JourneysResponse>("/api/admin/lifecycle/journeys"),
        // Nav v2 phase 4: the "Invite your waitlist" step (the API answers 503 while invites are off).
        isInvitesUiEnabled() && connection.kind === "custom"
          ? api<{ hasSignupUrl: boolean; invited: number; signedUp: number }>(`/api/admin/connections/${connection.id}/invites`)
          : null,
      ]);
      if (!alive) return;
      if (!guide.ok) return setError(errorText(guide.data));
      const all = journeys.ok ? journeys.data : { journeys: [], connections: [] };
      const withStatus = all.connections.map((c) => ({ ...c, status: "active" }));
      const self = withStatus.find((c) => c.id === connection.id) ?? { ...connection, status: "active" };
      const prod = promotionTarget(self, withStatus);
      setSteps(
        setupSteps({
          kind: connection.kind,
          environment: connection.kind === "custom" ? environmentOf(connection) : null,
          guide: guide.data.guide.status,
          journeys: all.journeys.filter((j) => j.connectionId === connection.id),
          production: prod ? { id: prod.id, hasJourney: all.journeys.some((j) => j.connectionId === prod.id) } : null,
          invites: invites?.ok ? invites.data : null,
        }),
      );
    })();
    return () => {
      alive = false;
    };
  }, [connection]);

  if (error) return <Banner tone="err">{error}</Banner>;
  if (!steps) return <p className="text-sm text-neutral-500">Loading…</p>;
  // Optional steps are shown, but "Setup complete" doesn't wait for them.
  const required = steps.filter((s) => !s.optional);
  const done = required.filter((s) => s.done).length;
  const next = required.find((s) => !s.done);

  return (
    <Section
      title={done === required.length ? "Setup complete" : `Setup · ${done} of ${required.length} done`}
      description="Everything this product needs before its journeys can send, in the order it happens."
    >
      <div className="h-1.5 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800" aria-hidden>
        <div className="h-full rounded-full bg-blue-600 dark:bg-blue-400" style={{ width: `${(100 * done) / required.length}%` }} />
      </div>
      <ol className="space-y-1">
        {steps.map((step) => {
          const current = step === next;
          const label = step.href ? (
            <Link href={step.href} className="hover:underline">
              {step.label}
            </Link>
          ) : step.tab ? (
            <button type="button" onClick={() => onOpenTab(step.tab!)} className="text-left hover:underline">
              {step.label}
            </button>
          ) : (
            step.label
          );
          return (
            <li key={step.id} className="flex items-start gap-2.5 py-1.5">
              <span
                className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full ${
                  step.done
                    ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                    : current
                      ? "border-2 border-blue-600 dark:border-blue-400"
                      : "border border-neutral-300 dark:border-neutral-600"
                }`}
              >
                {step.done ? <Check size={12} strokeWidth={3} aria-label="Done" /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block text-sm ${step.done ? "text-neutral-500" : "font-medium"}`}>{label}</span>
                <span className="block text-xs text-neutral-500">{step.detail}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
