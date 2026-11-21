import { meaningsOf } from "@/lib/metrics/meanings";
import { HEALTH_STATES, type HealthState } from "@/lib/types/dataConnection";
import { lagWords } from "./live";
import type { ConnectorManifest } from "./manifest";
import { CONNECTOR_ERRORS } from "./messages";
import { allConnectors } from "./registry";

/**
 * The words of the Connected data help page, generated from the manifests so the page can't drift
 * from what each connector really reads and asks for (the Vizzybl lesson: a directory written by
 * hand went out of date). The help page itself comes with the Browse, Listing and Connected
 * screens it describes and renders these words; nothing here needs a screen.
 */

export interface ConnectorHelp {
  id: string;
  name: string;
  summary: string;
  /** The shared data table: what, which way, where it goes. */
  shares: Array<{ what: string; detail: string | null; direction: "Read only" | "Never"; where: string }>;
  /** Every number it gives, with its meaning. */
  numbers: Array<{ name: string; definition: string; caveat: string | null }>;
  lag: string;
  /** How to connect with a pasted token, when it can. */
  token: { permissions: string[]; steps: string[]; link: string | null; fields: Array<{ label: string; help: string | null }> } | null;
  disconnect: string;
}

export function connectorHelp(m: ConnectorManifest): ConnectorHelp {
  const token = m.connect.find((c) => c.method === "token_fields");
  const measures = [...new Set(m.produces.flatMap((p) => p.measures))];
  const lag = Math.max(...m.produces.map((p) => p.lagDays));
  return {
    id: m.id,
    name: m.name,
    summary: m.summary,
    shares: m.shares.map((s) => ({ what: s.what, detail: s.detail ?? null, direction: s.direction === "read" ? "Read only" : "Never", where: s.where })),
    numbers: Object.values(meaningsOf(measures)).map((mm) => ({ name: mm!.name, definition: mm!.definition, caveat: mm!.caveat ?? null })),
    lag: lagWords(lag),
    token:
      token && token.method === "token_fields"
        ? { permissions: token.permissions, steps: token.steps, link: token.tokenLink ?? null, fields: token.fields.map((f) => ({ label: f.label, help: f.help ?? null })) }
        : null,
    disconnect: m.disconnect,
  };
}

/** What each health state means, as the Connected view shows it. */
export const HEALTH_HELP: Readonly<Record<HealthState | "disconnected", string>> = {
  ok: "Working: the last check or read went through.",
  check: "The last call failed for a reason that may pass, such as the provider being down. YouGrow tries again on the next check.",
  broken: "The provider turned the connection down, usually because the token was deleted or lost its permission. Connect it again.",
  paused: "No calls go out: an admin paused it, or YouGrow did for a while after the provider asked it to slow down.",
  disconnected: "Its token was deleted from YouGrow. The record stays so you can see its history.",
};

/** The grants table in plain words. */
export const GRANTS_HELP: readonly string[] = [
  "Admins see, read and manage every connection. That can't be turned off.",
  "Everyone else on the team sees each connection's name and health. They read its numbers only when an admin allows members to read.",
  "Vizzy reads a connection only when an admin allows Vizzy to read it. When it reads for a member, members must be allowed too.",
  "Only admins connect, check, pause, change who may read and disconnect.",
  "The admin who connected gets nothing extra, and the connection stays when they leave the team.",
];

export interface ConnectedDataHelp {
  connectors: ConnectorHelp[];
  health: typeof HEALTH_HELP;
  healthOrder: ReadonlyArray<HealthState | "disconnected">;
  grants: readonly string[];
  /** The messages people see, quoted on the page. */
  messages: typeof CONNECTOR_ERRORS;
}

/** Everything the help page says, for every connector this build knows. */
export function connectedDataHelp(manifests: readonly ConnectorManifest[] = allConnectors()): ConnectedDataHelp {
  return {
    connectors: manifests.map(connectorHelp),
    health: HEALTH_HELP,
    healthOrder: [...HEALTH_STATES, "disconnected"],
    grants: GRANTS_HELP,
    messages: CONNECTOR_ERRORS,
  };
}
