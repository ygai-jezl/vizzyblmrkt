import { z } from "zod";

/**
 * MailChimp Marketing API surface used by the email hub. Mirrors the email
 * layer's contract: helpers NEVER throw — they return a verdict object so the
 * caller's flow (signup / verify / delivery worker) can degrade gracefully.
 */
export interface MailchimpResult<T = unknown> {
  ok: boolean;
  reason?: string;
  data?: T;
}

/** Resolved, ready-to-use credentials for a single Marketing API call. */
export interface ResolvedMailchimpConfig {
  apiKey: string;
  /** Data-center prefix, e.g. "us21" (the suffix of the API key). */
  serverPrefix: string;
  audienceId: string;
  /** Whether these came from the tenant's BYO config or the shared account. */
  source: "tenant" | "shared";
}

export type MailchimpConfigError =
  /** Gate is on (requiresOwnApiKey) but the tenant has no usable own creds. */
  | "byo_required_not_configured"
  /** No shared env creds (e.g. local dev / before secrets are set). */
  | "shared_not_configured"
  /** Couldn't determine the data-center prefix from the key. */
  | "no_server_prefix";

export type MailchimpConfigResult =
  | { ok: true; config: ResolvedMailchimpConfig }
  | { ok: false; reason: MailchimpConfigError };

export const MemberStatus = z.enum([
  "subscribed",
  "unsubscribed",
  "pending",
  "cleaned",
  "transactional",
]);
export type MemberStatus = z.infer<typeof MemberStatus>;

export interface UpsertMemberInput {
  email: string;
  /** Defaults to "subscribed" (verified signups have already double-opted-in). */
  status?: MemberStatus;
  mergeFields?: Record<string, string | number>;
  tags?: string[];
}
