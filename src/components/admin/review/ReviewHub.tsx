import Link from "next/link";
import { requireAdminContext } from "@/lib/auth/session";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { isWorkEnabled } from "@/lib/work/flags";
import { loadReview, REVIEW_ORDER, REVIEW_SECTIONS, type ReviewItem, type ReviewKind } from "@/lib/review/summary";
import { ApprovalQueue } from "../approvals/ApprovalQueue";
import { DismissCheckButton } from "./DismissCheckButton";
import { MarkSeenButton } from "./MarkSeenButton";
import { FollowUpButtons } from "../investors/FollowUpButtons";
import { SignalRow } from "./SignalActions";
import { GoBackRow } from "./GoBackRow";
import { WorkRow } from "./WorkRows";
import { forTenant } from "@/lib/tenant";
import { programmeWord } from "@/lib/nav/terms";

/**
 * Review (nav v2 phase 2): every decision waiting on a person, grouped by what
 * it is, each linking back to its source. AI lines keep their own queue (with
 * Approve / Edit / Use standard / Skip); the rest open where the fix happens.
 */
export async function ReviewHub() {
  const ctx = await requireAdminContext();
  const lifecycle = isLifecycleEnabled();
  const work = isWorkEnabled();
  const review = await loadReview(ctx, { lifecycle, includeContent: true });
  const byKind = new Map<ReviewKind, ReviewItem[]>();
  for (const item of review.items) byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), item]);
  const countOf = (kind: ReviewKind) => (kind === "ai_line" ? review.aiLines : (byKind.get(kind)?.length ?? 0));
  const total = review.aiLines + review.items.length;
  const withItems = REVIEW_ORDER.filter((k) => countOf(k) > 0);
  // Suggestions from collected numbers are planned in a programme: the brand's active ones.
  const programmes = review.items.some((i) => i.signal)
    ? (await forTenant(ctx).workspaces.find({ limit: 200 }).catch(() => [])).filter((w) => !w.archivedAt).map((w) => ({ id: w.id, name: w.name }))
    : [];

  return (
    <div className="mx-auto max-w-4xl space-y-6 text-shell-ink">
      <div>
        <h1 className="text-xl font-semibold">Review</h1>
        <p className="mt-1 max-w-prose text-sm text-shell-muted">
          Every decision waiting on a person, in one place. Each one links back to where it came from.
        </p>
      </div>

      {withItems.length ? (
        <nav aria-label="Review sections" className="flex flex-wrap gap-2">
          {withItems.map((kind) => (
            <a
              key={kind}
              href={`#${kind}`}
              className="rounded-full border border-shell-line bg-shell-card px-3 py-1 text-sm text-shell-ink hover:bg-shell-hover"
            >
              {REVIEW_SECTIONS[kind].title} · <span className="tabular-nums">{countOf(kind)}</span>
            </a>
          ))}
        </nav>
      ) : null}

      {total === 0 ? (
        <p className="rounded-xl border border-dashed border-shell-line p-8 text-center text-sm text-shell-muted">
          Nothing needs you right now. AI lines, Vizzy&rsquo;s drafts and suggestions, failed posts, repo results, connection
          problems and what your competitors changed land here{work ? ", with Work's checks due and tasks ready to start" : ""}.
        </p>
      ) : null}

      {REVIEW_ORDER.map((kind) => {
        const items = byKind.get(kind) ?? [];
        // The AI-lines queue always shows where lifecycle exists: it has a Decided tab too.
        if (kind === "ai_line" ? !lifecycle : items.length === 0) return null;
        const { title, description } = REVIEW_SECTIONS[kind];
        return (
          <section key={kind} id={kind} aria-labelledby={`${kind}-title`} className="scroll-mt-16 space-y-3">
            <div>
              <h2 id={`${kind}-title`} className="text-base font-semibold">
                {title} <span className="font-normal tabular-nums text-shell-muted">· {countOf(kind)}</span>
              </h2>
              <p className="max-w-prose text-sm text-shell-muted">{description}</p>
            </div>
            {kind === "ai_line" ? (
              <ApprovalQueue canEdit={ctx.role === "admin"} embedded />
            ) : (
              <ul className="space-y-2">
                {items.map((item) =>
                  item.work ? (
                    // Work's rows (WORK_ENABLED): members act on them too.
                    <WorkRow key={item.id} item={{ ...item, work: item.work }} />
                  ) : item.goBack && ctx.role === "admin" ? (
                    <GoBackRow key={item.id} item={{ ...item, goBack: item.goBack }} />
                  ) : item.signal && ctx.role === "admin" ? (
                    <SignalRow key={item.id} item={{ ...item, signal: item.signal }} programmes={programmes} programmeWord={programmeWord().one} />
                  ) : (
                    <li
                      key={item.id}
                      className="flex items-center gap-3 rounded-lg border border-shell-line bg-shell-card px-4 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{item.title}</p>
                        {item.goBack && item.details?.length ? (
                          // A member sees a Go back card's lines in full, with Open.
                          item.details.map((line) => (
                            <p key={line} className="text-xs text-shell-muted text-pretty">
                              {line}
                            </p>
                          ))
                        ) : item.dismissCheck && item.details?.length ? (
                          // The strategy check's reasons, each in full.
                          <ul className="mt-0.5 space-y-0.5 text-xs text-shell-muted">
                            {item.details.map((line) => (
                              <li key={line}>{line}</li>
                            ))}
                          </ul>
                        ) : (
                          <p className="truncate text-xs text-shell-muted">{item.detail}</p>
                        )}
                      </div>
                      {item.markSeen && ctx.role === "admin" ? <MarkSeenButton competitorId={item.markSeen.competitorId} /> : null}
                      {item.dismissCheck && ctx.role === "admin" ? <DismissCheckButton /> : null}
                      {item.followUp && ctx.role === "admin" ? <FollowUpButtons id={item.followUp.id} rev={item.followUp.rev} quiet={item.followUp.quiet} /> : null}
                      <Link
                        href={item.href}
                        className="shrink-0 rounded-md border border-shell-line px-3 py-1.5 text-sm font-medium hover:bg-shell-hover"
                      >
                        {item.action}
                      </Link>
                    </li>
                  ),
                )}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
