/**
 * One email sent to one person (`email_sends`, the brand's regional database): who and what it
 * was, so Mandrill's events come back to it from a short id, and (EMAIL_ENGAGEMENT_DETAIL_ENABLED)
 * everything that happened to it. The id is `es_` + a hash of the brand and the email's event key,
 * so a retried send finds the same record. Personal data: erased and exported with the person.
 */
export type EmailSendEngine = "waitlist" | "waitlist_v2" | "lifecycle" | "invite";

export interface EmailSend {
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
