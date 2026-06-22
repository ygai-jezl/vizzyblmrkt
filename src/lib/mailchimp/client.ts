import { createHash } from "node:crypto";
import type {
  MailchimpResult,
  ResolvedMailchimpConfig,
  UpsertMemberInput,
} from "./types";

/**
 * Thin MailChimp Marketing API client over native fetch. Every call returns a
 * MailchimpResult (never throws). Auth is HTTP Basic — the username is arbitrary
 * and the password is the API key.
 */
const TIMEOUT_MS = 8000;

function baseUrl(cfg: ResolvedMailchimpConfig): string {
  return `https://${cfg.serverPrefix}.api.mailchimp.com/3.0`;
}

function authHeader(cfg: ResolvedMailchimpConfig): string {
  return `Basic ${Buffer.from(`key:${cfg.apiKey}`).toString("base64")}`;
}

/** MailChimp subscriber hash = md5 of the lowercased, trimmed email. */
export function subscriberHash(email: string): string {
  return createHash("md5").update(email.trim().toLowerCase()).digest("hex");
}

async function call<T>(
  cfg: ResolvedMailchimpConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<MailchimpResult<T>> {
  try {
    const res = await fetch(`${baseUrl(cfg)}${path}`, {
      method,
      headers: {
        Authorization: authHeader(cfg),
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 204 (e.g. archive) has no JSON body.
    const json =
      res.status === 204
        ? {}
        : ((await res.json().catch(() => ({}))) as Record<string, unknown>);
    if (!res.ok) {
      const reason =
        (json.title as string) ||
        (json.detail as string) ||
        `http_${res.status}`;
      return { ok: false, reason };
    }
    return { ok: true, data: json as T };
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "TimeoutError"
        ? "timeout"
        : "request_error";
    return { ok: false, reason };
  }
}

// ---- Audience / member operations -----------------------------------------

/** Idempotent member upsert (PUT keyed by the subscriber hash). */
export async function upsertMember(
  cfg: ResolvedMailchimpConfig,
  input: UpsertMemberInput,
): Promise<MailchimpResult<{ id: string }>> {
  const hash = subscriberHash(input.email);
  const status = input.status ?? "subscribed";
  const res = await call<{ id: string }>(
    cfg,
    "PUT",
    `/lists/${cfg.audienceId}/members/${hash}`,
    {
      email_address: input.email,
      status_if_new: status,
      status,
      ...(input.mergeFields ? { merge_fields: input.mergeFields } : {}),
    },
  );
  // Tags are applied via a separate endpoint; best-effort, don't fail the upsert.
  if (res.ok && input.tags && input.tags.length > 0) {
    await addTags(cfg, input.email, input.tags);
  }
  return res;
}

export async function addTags(
  cfg: ResolvedMailchimpConfig,
  email: string,
  tags: string[],
): Promise<MailchimpResult> {
  const hash = subscriberHash(email);
  return call(cfg, "POST", `/lists/${cfg.audienceId}/members/${hash}/tags`, {
    tags: tags.map((name) => ({ name, status: "active" })),
  });
}

/** Archive (soft-remove) a member from the audience. */
export async function archiveMember(
  cfg: ResolvedMailchimpConfig,
  email: string,
): Promise<MailchimpResult> {
  const hash = subscriberHash(email);
  return call(cfg, "DELETE", `/lists/${cfg.audienceId}/members/${hash}`);
}

// ---- Campaign (newsletter / broadcast) operations -------------------------

export interface CreateCampaignInput {
  subject: string;
  title: string;
  fromName: string;
  replyTo: string;
  /** Optional saved-segment / tag id to scope recipients to one launch. */
  segmentId?: number;
}

export async function createCampaign(
  cfg: ResolvedMailchimpConfig,
  input: CreateCampaignInput,
): Promise<MailchimpResult<{ id: string }>> {
  return call<{ id: string }>(cfg, "POST", `/campaigns`, {
    type: "regular",
    recipients: {
      list_id: cfg.audienceId,
      ...(input.segmentId != null
        ? { segment_opts: { saved_segment_id: input.segmentId } }
        : {}),
    },
    settings: {
      subject_line: input.subject,
      title: input.title,
      from_name: input.fromName,
      reply_to: input.replyTo,
    },
  });
}

export async function setCampaignContent(
  cfg: ResolvedMailchimpConfig,
  campaignId: string,
  html: string,
): Promise<MailchimpResult> {
  return call(cfg, "PUT", `/campaigns/${campaignId}/content`, { html });
}

export async function sendCampaign(
  cfg: ResolvedMailchimpConfig,
  campaignId: string,
): Promise<MailchimpResult> {
  return call(cfg, "POST", `/campaigns/${campaignId}/actions/send`);
}

/**
 * Current send-state of a campaign ("save" | "paused" | "schedule" | "sending"
 * | "sent" | …), or null if it can't be read. Used by the delivery worker to
 * avoid re-dispatching a campaign a prior (interrupted) attempt already sent.
 */
export async function getCampaignStatus(
  cfg: ResolvedMailchimpConfig,
  campaignId: string,
): Promise<string | null> {
  const res = await call<{ status?: string }>(
    cfg,
    "GET",
    `/campaigns/${campaignId}`,
  );
  return res.ok ? (res.data?.status ?? null) : null;
}

export interface CampaignReport {
  emails_sent: number;
  opens: { open_rate: number };
  clicks: { click_rate: number };
  /** Top-level unique unsubscribe count from the MailChimp report. */
  unsubscribed: number;
}

export async function getCampaignReport(
  cfg: ResolvedMailchimpConfig,
  campaignId: string,
): Promise<MailchimpResult<CampaignReport>> {
  return call<CampaignReport>(cfg, "GET", `/reports/${campaignId}`);
}

/**
 * Find the static-segment id backing a MailChimp tag (tags are static segments
 * under the hood). Used to scope a broadcast to one launch's subscribers.
 */
export async function findTagSegmentId(
  cfg: ResolvedMailchimpConfig,
  tagName: string,
): Promise<number | null> {
  const res = await call<{ segments: Array<{ id: number; name: string }> }>(
    cfg,
    "GET",
    `/lists/${cfg.audienceId}/segments?type=static&count=1000`,
  );
  if (!res.ok || !res.data?.segments) return null;
  return res.data.segments.find((s) => s.name === tagName)?.id ?? null;
}
