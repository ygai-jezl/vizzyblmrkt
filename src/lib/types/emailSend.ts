/**
 * One email sent to one person (`email_sends`, the brand's regional database): who and what it
 * was, so Mandrill's events come back to it from a short id, and (EMAIL_ENGAGEMENT_DETAIL_ENABLED)
 * everything that happened to it. The id is `es_` + a hash of the brand and the email's event key,
 * so a retried send finds the same record. Personal data: erased and exported with the person.
 */
/** "earlier": the record was made from a webhook event for an email sent in an older form. */
export type EmailSendEngine = "waitlist" | "waitlist_v2" | "lifecycle" | "invite" | "earlier";

/** Everything that happened to one email (EMAIL_ENGAGEMENT_DETAIL_ENABLED). No IP or location. */
export interface EmailEngagement {
  opens?: { count: number; firstAt: string; lastAt: string; mobile: number; desktop: number; clients: Record<string, number> };
  clicks?: { count: number; firstAt: string; lastAt: string; links: Array<{ url: string; count: number }> };
  bounce?: { kind: "hard" | "soft"; description: string; diag: string; at: string };
  reject?: { reason: string; at: string };
  deferrals?: { count: number; lastAt: string };
  spamAt?: string;
  unsubAt?: string;
  /** The last few events counted, so a batch Mandrill sends again counts nothing twice. */
  seen?: string[];
}

export interface EmailSend extends EmailEngagement {
  id: string;
  tenantId: string;
  engine: EmailSendEngine;
  campaignId: string;
  journeyId: string;
  nodeId: string;
  /** The person: a signup id, or a product user id for a product journey. */
  signupId: string;
  variantId: string;
  recipientKind?: "signup" | "product_user";
  connectionId?: string;
  enrolmentId?: string;
  /** Mandrill's id for the message, from the first event that names it. */
  mandrillMessageId?: string | null;
  createdAt: string;
  updatedAt: string;
}
