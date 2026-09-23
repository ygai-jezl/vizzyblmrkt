"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Copy } from "lucide-react";
import { ENVIRONMENT_LABEL, promotionTarget } from "@/lib/connect/environments";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";
import { api, errorText } from "../connect/api";

type Option = { id: string; name: string; kind: "custom" | "sandbox"; environment?: "staging" | "production" | null };
import { Banner, Button, Field, Section, inputClass } from "../connect/ui";

/**
 * Copy this journey onto another product in the account — typically from the
 * staging product it was tested on to the production one. The copy is a new
 * draft in test mode with no test users: publishing it is a separate decision.
 */
export function CopyJourneyPanel({
  journeyId,
  journeyName,
  connectionId,
  published,
  onCancel,
}: {
  journeyId: string;
  journeyName: string;
  connectionId: string;
  published: boolean;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [connections, setConnections] = useState<Option[]>([]);
  const [target, setTarget] = useState("");
  // Nav v2 phase 3: from a staging connection, the same product's production one.
  const [promoteTo, setPromoteTo] = useState<Option | null>(null);
  const [name, setName] = useState(journeyName);
  const [which, setWhich] = useState<"published" | "draft">(published ? "published" : "draft");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await api<{ connections: Option[] }>("/api/admin/lifecycle/journeys");
      if (!r.ok) return setErr(errorText(r.data));
      const others = r.data.connections.filter((c) => c.id !== connectionId);
      const self = r.data.connections.find((c) => c.id === connectionId);
      const withStatus = r.data.connections.map((c) => ({ ...c, status: "active" }));
      const prod = isNavV2Phase3Enabled() && self ? promotionTarget({ ...self, status: "active" }, withStatus) : null;
      setConnections(others);
      setPromoteTo(prod);
      setTarget(prod?.id ?? others[0]?.id ?? "");
    })();
  }, [connectionId]);

  const copy = async () => {
    setBusy(true);
    setErr(null);
    const r = await api<{ journeyId: string }>(`/api/admin/lifecycle/journeys/${journeyId}/duplicate`, {
      method: "POST",
      body: JSON.stringify({ connectionId: target, name, which }),
    });
    setBusy(false);
    if (!r.ok) return setErr(errorText(r.data));
    router.push(`/admin/lifecycle/${r.data.journeyId}`);
  };

  return (
    <Section
      title={promoteTo && target === promoteTo.id ? `Promote to ${ENVIRONMENT_LABEL.production}` : "Copy to another product"}
      description={
        promoteTo && target === promoteTo.id
          ? `Copies this journey to ${promoteTo.name}, this product's production connection. The copy starts as a draft in test mode — nothing sends until you publish it there.`
          : "E.g. from your staging app, where you tested it, to your production app. The copy starts as a draft in test mode — nothing sends until you publish it there."
      }
    >
      {connections.length === 0 ? (
        <Banner tone="info">Connect another product first (Products → Connect a product) — for example your production app.</Banner>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Copy to">
            <select className={inputClass} value={target} onChange={(e) => setTarget(e.target.value)}>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.kind === "sandbox" ? " (sandbox)" : ""}
                  {promoteTo?.id === c.id ? " — production" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Name">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value.slice(0, 120))} />
          </Field>
          <Field label="Which version">
            <select className={inputClass} value={which} onChange={(e) => setWhich(e.target.value as "published" | "draft")}>
              {published ? <option value="published">Published version</option> : null}
              <option value="draft">Current draft</option>
            </select>
          </Field>
        </div>
      )}
      {err ? <Banner tone="err">{err}</Banner> : null}
      <div className="flex gap-2">
        <Button tone="primary" disabled={busy || !target || !name.trim()} onClick={() => void copy()}>
          <Copy size={14} />{" "}
          {busy ? "Copying…" : promoteTo && target === promoteTo.id ? "Promote to Production" : "Copy journey"}
        </Button>
        <Button disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Section>
  );
}
