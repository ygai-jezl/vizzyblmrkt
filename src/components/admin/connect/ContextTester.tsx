"use client";

import { useState } from "react";
import { api, errorText, type PublicConnection } from "./api";
import { Badge, Banner, Button, Field, JsonBlock, inputClass } from "./ui";

/** One of the user's things we hold (API v2 entities), to test for. */
interface KnownEntity {
  id: string;
  kind: string;
  name: string | null;
}
interface ContextOk {
  ok: true;
  entities?: KnownEntity[];
  latencyMs: number;
  warnings: string[];
  context: {
    asOf: string;
    steps: Array<{ id: string; label: string; done: boolean; url?: string | null }>;
    nextStep?: { id: string; label: string; url?: string | null } | null;
    facts: Array<{ id: string; label: string; value: string | number | boolean; unit?: string | null }>;
    insights: Array<{ id: string; sentence: string; weight: number }>;
  };
}
interface ContextFail {
  ok: false;
  latencyMs: number;
  error: string;
  detail?: string;
  entities?: KnownEntity[];
}

const HELP: Record<string, string> = {
  not_configured: "No context endpoint is set up (or it's disabled) — add one in Settings.",
  signing_unavailable: "The platform couldn't sign the request (its signing key is unavailable), so nothing was sent. Try again shortly.",
  blocked_url: "The endpoint URL isn't allowed: it must be public https on port 443, with no redirects.",
  timeout: "Your endpoint didn't answer within the timeout.",
  too_large: "The response was over 64 KB.",
  bad_json: "The response wasn't JSON.",
  bad_schema: "The response didn't match the context schema.",
};

/** "Test connection": pull context for one user and show the validated payload. */
export function ContextTester({ connection, canEdit }: { connection: PublicConnection; canEdit: boolean }) {
  const [userId, setUserId] = useState(connection.sandbox?.users[0]?.userId ?? "");
  const kinds = connection.catalog.entityKinds ?? [];
  const [kind, setKind] = useState(kinds[0]?.kind ?? "");
  const [entityId, setEntityId] = useState("");
  /** What the last test asked about, to say which facts it should have had. */
  const [asked, setAsked] = useState<{ kind: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ContextOk | ContextFail | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    const entity = kinds.length > 0 ? entityId.trim() : "";
    setBusy(true);
    setError(null);
    const r = await api<ContextOk | ContextFail>(`/api/admin/connections/${connection.id}/test-context`, {
      method: "POST",
      body: JSON.stringify({ userId, entity: entity ? { id: entity, kind } : null }),
    });
    setBusy(false);
    setAsked(entity ? { kind } : null);
    if (!r.ok) return setError(errorText(r.data));
    setResult(r.data);
  }

  const known = result?.entities ?? [];
  const kindLabel = (k: string) => kinds.find((x) => x.kind === k)?.label ?? k;
  const kindPlural = (k: string) => kinds.find((x) => x.kind === k)?.plural ?? `${kindLabel(k)}s`;
  // Catalog facts the answer left out: an endpoint sends nothing for a fact it has no value for.
  const returned = new Set(result?.ok ? result.context.facts.map((f) => f.id) : []);
  const missing = result?.ok
    ? (connection.catalog.facts ?? []).filter((f) => !returned.has(f.id) && (!asked || !f.kind || f.kind === asked.kind))
    : [];

  return (
    <div className="space-y-4">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Before each email the platform asks your product for this user&apos;s onboarding steps,
        facts and insight sentences. Try it for one user.
      </p>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Field label="User id (your product's id for the user)">
            <input className={inputClass} value={userId} onChange={(e) => setUserId(e.target.value)} />
          </Field>
        </div>
        <Button tone="primary" disabled={busy || !userId.trim() || !canEdit} onClick={run}>
          {busy ? "Asking…" : "Test connection"}
        </Button>
      </div>
      {kinds.length > 0 ? (
        <div className="flex items-end gap-2">
          {kinds.length > 1 ? (
            <Field label="About a">
              <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value)}>
                {kinds.map((k) => (
                  <option key={k.kind} value={k.kind}>{k.label}</option>
                ))}
              </select>
            </Field>
          ) : null}
          <div className="flex-1">
            <Field
              label={`${kindLabel(kind)} id (optional)`}
              hint={`Blank: your endpoint picks — as it does when an email isn't about one ${kindLabel(kind).toLowerCase()}.`}
            >
              <input className={inputClass} value={entityId} list="test-context-entities" placeholder="Your product's id for it"
                onChange={(e) => setEntityId(e.target.value)} />
            </Field>
            <datalist id="test-context-entities">
              {known.filter((e) => e.kind === kind).map((e) => (
                <option key={e.id} value={e.id}>{e.name ?? e.id}</option>
              ))}
            </datalist>
          </div>
        </div>
      ) : null}
      {known.some((e) => e.kind === kind) && !entityId ? (
        <p className="text-xs text-neutral-500">
          This user&apos;s {kindPlural(kind).toLowerCase()} we know of:{" "}
          {known.filter((e) => e.kind === kind).map((e, i) => (
            <span key={e.id}>
              {i > 0 ? ", " : null}
              <button type="button" className="underline" onClick={() => setEntityId(e.id)}>{e.name ?? e.id}</button>
            </span>
          ))}
        </p>
      ) : null}
      {error ? <Banner tone="err">{error}</Banner> : null}

      {result && !result.ok ? (
        <Banner tone="err">
          {HELP[result.error] ?? `Your endpoint answered ${result.error.replace("http_", "HTTP ")}.`}
          {result.detail ? ` (${result.detail})` : ""} · {result.latencyMs} ms
        </Banner>
      ) : null}

      {result?.ok ? (
        <div className="space-y-3">
          <Banner tone="ok">Valid context in {result.latencyMs} ms.</Banner>
          {result.warnings.some((w) => w.startsWith("link_dropped")) ? (
            <Banner tone="info">
              Links outside your allowed link domains were removed:{" "}
              {result.warnings.filter((w) => w.startsWith("link_dropped")).join(", ")}
            </Banner>
          ) : null}
          {result.warnings.some((w) => w.startsWith("unknown_fact:")) ? (
            <Banner tone="info">
              Your endpoint returned facts that aren&apos;t in the catalog:{" "}
              {result.warnings.filter((w) => w.startsWith("unknown_fact:")).map((w) => w.slice(13)).join(", ")}. They still
              work, but add them to the catalog (Facts) so journeys and Vizzy know what they mean.
            </Banner>
          ) : null}
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <h4 className="text-xs font-semibold">Onboarding</h4>
              <ul className="space-y-0.5 text-sm">
                {result.context.steps.map((s) => (
                  <li key={s.id}>
                    {s.done ? "✓" : "☐"} {s.label}{" "}
                    {result.context.nextStep?.id === s.id ? <Badge tone="amber">next</Badge> : null}
                  </li>
                ))}
              </ul>
            </div>
            <div className="space-y-1">
              <h4 className="text-xs font-semibold">Facts</h4>
              <ul className="space-y-0.5 text-sm">
                {result.context.facts.map((f) => (
                  <li key={f.id}>
                    {f.label}: <strong>{String(f.value)}{f.unit ?? ""}</strong>
                  </li>
                ))}
              </ul>
              {missing.length > 0 ? (
                <div className="pt-1 text-xs text-neutral-500">
                  <p>
                    Not in this answer ({missing.length} of {(connection.catalog.facts ?? []).length} in the catalog) — your endpoint
                    sends nothing for a fact it has no value for:
                  </p>
                  <ul className="list-disc pl-5">
                    {missing.map((f) => (
                      <li key={f.id}>
                        {f.label || f.id}
                        {f.kind ? ` · per ${kindLabel(f.kind).toLowerCase()}` : ""}
                        {f.appliesWhen ? ` · only for ${f.appliesWhen}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </div>
          <div className="space-y-1">
            <h4 className="text-xs font-semibold">Insight candidates</h4>
            <ul className="list-disc space-y-0.5 pl-5 text-sm">
              {result.context.insights.map((i) => (
                <li key={i.id}>{i.sentence}</li>
              ))}
            </ul>
          </div>
          <details>
            <summary className="cursor-pointer text-xs text-neutral-500">Raw payload</summary>
            <JsonBlock value={result.context} />
          </details>
        </div>
      ) : null}
    </div>
  );
}
