import { meaningsOf } from "@/lib/metrics/meanings";
import { HEALTH_STATES, type HealthState } from "@/lib/types/dataConnection";
import { lagWords } from "./live";
import { oauthMethod, type ConnectorManifest } from "./manifest";
import { CONNECTOR_ERRORS, SIGNIN_REASONS } from "./messages";
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
  /** How to connect by signing in with Google, when it can: the steps and what it reads. */
  signIn: { steps: string[]; reads: string[] } | null;
  disconnect: string;
}

/** The steps of a sign in, from the manifest: its name, and whether a site is picked after. */
function signInSteps(m: ConnectorManifest): string[] {
  const steps = [
    `On ${m.name} in Connected data, press Sign in with Google.`,
    `Pick the Google account that can see your ${m.name} data.`,
    "On Google's screen, allow YouGrow to read it. It asks to read only, never to change anything.",
  ];
  if (m.hooks.accounts) steps.push("Back in YouGrow, pick which site or property this connection reads. Nothing is read until you do.");
  return steps;
}

export function connectorHelp(m: ConnectorManifest): ConnectorHelp {
  const token = m.connect.find((c) => c.method === "token_fields");
  const signIn = oauthMethod(m);
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
    signIn: signIn ? { steps: signInSteps(m), reads: m.shares.filter((s) => s.direction === "read" && s.needs.some((n) => signIn.scopes.includes(n))).map((s) => s.what) } : null,
    disconnect: m.disconnect,
  };
}

/** What each health state means, as the Connected view shows it. */
export const HEALTH_HELP: Readonly<Record<HealthState | "disconnected", string>> = {
  ok: "Working: the last check or read went through.",
  check: "The last call failed for a reason that may pass, such as the provider being down. YouGrow tries again on the next check.",
  broken: "The provider turned the connection down, usually because the token was deleted or lost its permission, or Google ended a sign in. Connect it again, or press Reconnect for a sign in.",
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

/**
 * Signing in with Google, for every connector that can (Connectors 1b). Google's own rules,
 * from developers.google.com/identity/protocols/oauth2: at most 100 live sign ins per Google
 * account for one app, the oldest ended without warning; 7 days for an app still in testing;
 * revoking ends every grant of that account; people remove access at
 * myaccount.google.com/permissions.
 */
export const SIGN_IN_HELP = {
  account:
    "Sign in with a Google account that can already see the data, such as an owner, full user or restricted user of the site in Search Console. Sites that account hasn't verified aren't listed.",
  unverified:
    "When a permission is one Google treats as sensitive and Google hasn't checked this copy of YouGrow yet, its sign in screen warns that the app isn't verified. Whoever runs the copy can go on past the warning; everyone else should wait for Google's check. Reading Search Console isn't sensitive.",
  testing: "While this copy's Google app is still in testing, Google ends each sign in after 7 days, so the connection asks you to reconnect every week.",
  limit:
    "Google keeps at most 100 sign ins for one Google account with one app. A 101st quietly ends the oldest, and the connection that used it asks you to reconnect. This only matters if one Google account signs in very often, for example for many brands.",
  reconnect:
    "When Google ends a sign in, the connection shows broken with the words below. Press Reconnect and sign in with the same Google account: the site it reads, who may read it and its history all stay.",
  removeAccess:
    "To end YouGrow's access at Google, open your Google account at myaccount.google.com/permissions, choose YouGrow and remove its access. That ends every connection that Google account made on this copy of YouGrow, for every brand.",
  disconnect:
    "Disconnect deletes the sign in YouGrow keeps, so nothing more is read, but leaves the access in your Google account: remove it there as well. A copy can turn on revoking at Google when someone disconnects; then every connection signed in with that Google account has to sign in again.",
  message: CONNECTOR_ERRORS.signin_refused,
} as const;

export interface ConnectedDataHelp {
  connectors: ConnectorHelp[];
  /** Signing in with Google, and why a sign in didn't finish. */
  signIn: typeof SIGN_IN_HELP;
  signInReasons: typeof SIGNIN_REASONS;
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
    signIn: SIGN_IN_HELP,
    signInReasons: SIGNIN_REASONS,
    health: HEALTH_HELP,
    healthOrder: [...HEALTH_STATES, "disconnected"],
    grants: GRANTS_HELP,
    messages: CONNECTOR_ERRORS,
  };
}
