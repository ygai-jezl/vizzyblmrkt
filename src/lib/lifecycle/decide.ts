import type { AiDraft, FallbackReason } from "@/lib/types/lifecycle";
import type { ProductContext } from "@/lib/connect/protocol";
import { validateAiLine, validateAiSubject } from "./insightValidator";

/**
 * At send time, for an `ai_line` email: does the reviewed AI line go out, the
 * standard version, or nothing? The AI line only goes out when ALL hold:
 *  1. staff approved it;
 *  2. the insight it follows is still in the product's live context;
 *  3. it still passes the validator.
 * Otherwise the standard version sends, with the reason recorded. People
 * enrolled by backfill (`requireApproval`) get NOTHING unless staff approved —
 * or explicitly chose the standard version — for them.
 *
 * Pure: the runner calls it inside the send transaction with the freshest draft,
 * so a decision racing the send is either seen or loses cleanly.
 */

export type SendVersion =
  | { version: "ai"; aiLine: string; subject: string | null; insightId: string }
  | { version: "fallback"; reason: FallbackReason }
  | { version: "skip"; reason: "staff_skipped" | "approval_required" };

export function decideSendVersion(a: {
  draft: AiDraft | null;
  requireApproval: boolean;
  context: ProductContext | null;
  aiEnabled: boolean;
}): SendVersion {
  const { draft, requireApproval } = a;
  const fallback = (reason: FallbackReason): SendVersion =>
    requireApproval ? { version: "skip", reason: "approval_required" } : { version: "fallback", reason };

  if (draft?.status === "skipped") return { version: "skip", reason: "staff_skipped" };
  if (draft?.status === "use_fallback" && draft.fallbackReason === "staff_choice") {
    // Staff chose the standard version — that IS an approval, even for a backfill.
    return { version: "fallback", reason: "staff_choice" };
  }
  if (!a.aiEnabled) return fallback("ai_off");
  if (!draft) return fallback("no_draft");

  switch (draft.status) {
    case "approved": {
      if (!draft.aiLine || !draft.insightId) return fallback("validation_failed");
      if (!a.context?.insights.some((i) => i.id === draft.insightId)) return fallback("insight_stale");
      const allowed = [...draft.allowedTerms, ...draft.attestedTerms];
      if (!validateAiLine(draft.aiLine, allowed).ok) return fallback("validation_failed");
      const subject = draft.subjectVariant && validateAiSubject(draft.subjectVariant, allowed).ok ? draft.subjectVariant : null;
      return { version: "ai", aiLine: draft.aiLine, subject, insightId: draft.insightId };
    }
    case "use_fallback":
      return fallback(draft.fallbackReason ?? "generation_failed");
    case "pending":
    case "awaiting_approval":
      return fallback("no_decision");
    default:
      return fallback("superseded");
  }
}
