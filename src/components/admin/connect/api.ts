import type {
  ConnectionCatalog,
  ConsentPolicy,
  SandboxUser,
} from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import type { ConnectionDiagnostics, ProductEvent } from "@/lib/types/productEvent";

/** A connection as the admin API returns it (never the sealed secrets). */
export interface PublicConnection {
  id: string;
  name: string;
  kind: "custom" | "sandbox";
  status: "active" | "paused" | "revoked";
  keyId: string;
  secretPrefix: string;
  rotating: boolean;
  prevSecretExpiresAt?: string | null;
  contextEndpoint?: { url: string; enabled: boolean; timeoutMs: number } | null;
  webhookEndpoint?: { url: string; enabled: boolean } | null;
  linkDomains: string[];
  catalog: ConnectionCatalog;
  consentPolicy: ConsentPolicy;
  defaults: { timezone: string; locale: string };
  health: {
    lastEventAt?: string | null;
    lastContextOkAt?: string | null;
    lastContextError?: string | null;
    consecutiveContextFailures?: number;
  };
  sandbox?: {
    users: SandboxUser[];
    webhookInbox: Array<{ receivedAt: string; type: string; body: string }>;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export type { ProductUser, ProductEvent, ConnectionDiagnostics, SandboxUser, ConnectionCatalog };

export interface ApiResponse<T> {
  ok: boolean;
  status: number;
  data: T;
}

/** JSON fetch against the admin API. Never throws on HTTP errors. */
export async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<ApiResponse<T>> {
  try {
    const res = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
    const data = (await res.json().catch(() => ({}))) as T;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "network" } as T };
  }
}

const MESSAGES: Record<string, string> = {
  lifecycle_disabled: "Lifecycle journeys are switched off in this environment.",
  forbidden: "Only admins can do that.",
  unauthorized: "Your session expired — sign in again.",
  not_found: "Not found.",
  connection_revoked: "This connection has been revoked.",
  sandbox_endpoints_fixed: "A sandbox's endpoints are fixed.",
  invalid_url: "That URL isn't allowed. Use a public https address on port 443.",
  invalid_link_domain: "That link domain isn't valid.",
  recipient_not_allowed: "Test users must use your own address or one on a verified sending domain.",
  duplicate_user_id: "Two test users share the same user id.",
  connect_enc_key_unconfigured: "Connection secrets aren't configured in this environment yet.",
  network: "Couldn't reach the server.",
  // Learn from repo
  invalid_repo_url: "That isn't a GitHub or GitLab repository address (e.g. github.com/your-org/your-app).",
  analysis_in_progress: "An analysis of this product is already running.",
  analysis_daily_cap: "You've reached today's limit for repo analyses. Try again tomorrow.",
  rate_limited: "Too many requests — try again in a minute.",
  job_not_configured: "Repo analysis isn't set up in this environment yet.",
  job_dispatch_failed: "Couldn't start the analysis — try again shortly.",
  no_map: "That analysis has no results to add.",
  invalid_app_origin: "Your app's address must start with https://.",
  catalog_invalid: "Those items don't fit the catalog (too many, or an invalid id).",
  no_readable_files: "We couldn't find source files in that repository (or couldn't read it — check the connected account can access it).",
  analysis_not_queued: "That analysis had already started.",
  // Lifecycle journeys
  connection_not_found: "That product connection doesn't exist.",
  connection_unavailable: "The journey's product connection is revoked.",
  invalid_draft: "The journey couldn't be saved — part of it is malformed.",
  invalid_journey: "Fix the issues listed before publishing.",
  publish_conflict: "Someone else published at the same moment — reload and try again.",
  not_published: "Publish the journey first.",
  sender_unverified: "Live sending needs a From address on a verified sending domain.",
  shadow_inbox_required: "Shadow mode needs a shadow inbox.",
  shadow_inbox_not_allowed: "The shadow inbox must be your own address or on a verified sending domain.",
  journey_not_active: "The journey must be published and active.",
  user_not_found: "We haven't received this user from the product yet. The product must send an identify (or sign-up) event for them first.",
  sandbox_send_failed: "The Sandbox couldn't send this test user — check its test users in Products.",
  already_enrolled: "That user is already in this journey.",
  invalid_document: "That isn't a journey file this version of the platform can read.",
  document_too_large: "That journey file is too large.",
  not_a_test_recipient: "In test mode only listed test users can be enrolled.",
  enrolment_cap: "Today's enrolment cap for this journey is reached.",
  user_deleted: "That user has been deleted.",
  live: "Run-now is only for test and shadow enrolments.",
  busy: "That enrolment is being processed right now — try again in a moment.",
  not_active: "That enrolment has already finished.",
};

/** A readable message for an admin-API error body. */
export function errorText(data: unknown): string {
  const d = (data ?? {}) as { error?: string; detail?: string };
  const base = (d.error && MESSAGES[d.error]) || d.error || "Something went wrong.";
  return d.detail ? `${base} (${d.detail})` : base;
}

/** "3 min ago" style relative time. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "—";
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}
