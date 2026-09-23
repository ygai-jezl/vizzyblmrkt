import type { ContentPlan } from "@/lib/types/contentPlan";
import type { ScheduledPost } from "@/lib/types/scheduledPost";
import { contentHubItem, failedPostItem, type ReviewItem } from "@/lib/review/summary";

/**
 * A content programme at a glance (nav v2 phase 3): how much sits at each stage
 * of the pipeline, what goes out in the next seven days, and what needs a person.
 * Pure — the Overview page loads the inputs.
 */

export interface PipelineStage {
  key: "ideas" | "templates" | "drafts" | "scheduled" | "published";
  label: string;
  count: number;
  /** A second line, e.g. "3 ready to schedule". */
  note: string | null;
  /** The tab it opens, relative to the programme. */
  tab: string;
}

export interface UpcomingItem {
  at: string;
  kind: "post" | "newsletter";
  channel: string;
  title: string;
}

export interface ProgrammeOverview {
  pipeline: PipelineStage[];
  upcoming: UpcomingItem[];
  needsYou: ReviewItem[];
}

const CHANNEL: Record<string, string> = {
  blog: "Blog",
  newsletter: "Newsletter",
  linkedin: "LinkedIn",
  x: "X",
  instagram: "Instagram",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function programmeOverview(input: {
  workspace: { id: string; name: string };
  ideas: Array<{ status: string }>;
  templates: number;
  plans: Array<Pick<ContentPlan, "id" | "name" | "graph">>;
  posts: Array<Pick<ScheduledPost, "id" | "workspaceId" | "contentPlanId" | "channel" | "jobKind" | "status" | "scheduledAt" | "lastError">>;
  newsletters: Array<{ subject: string; status: string; scheduledAt?: string | null }>;
  now: Date;
}): ProgrammeOverview {
  const { workspace, now } = input;
  const publishJobs = input.posts.filter((p) => (p.jobKind ?? "publish") === "publish");
  const nodes = input.plans.flatMap((p) => p.graph?.nodes ?? []);
  const ready = nodes.filter((n) => n.status === "generated" || n.status === "approved").length;
  const newIdeas = input.ideas.filter((i) => i.status !== "templatized").length;
  const scheduled = publishJobs.filter((p) => p.status === "pending" || p.status === "processing");
  const published = publishJobs.filter((p) => p.status === "done");

  const pipeline: PipelineStage[] = [
    {
      key: "ideas",
      label: "Ideas",
      count: input.ideas.length,
      note: newIdeas ? `${newIdeas} not templated yet` : null,
      tab: "curate/idea-board",
    },
    { key: "templates", label: "Templates", count: input.templates, note: null, tab: "templatize" },
    {
      key: "drafts",
      label: "Drafts",
      count: input.plans.length,
      note: ready ? `${plural(ready, "piece")} written` : null,
      tab: "create",
    },
    { key: "scheduled", label: "Scheduled", count: scheduled.length, note: null, tab: "distribute" },
    { key: "published", label: "Published", count: published.length, note: null, tab: "distribute" },
  ];

  const until = now.getTime() + 7 * 24 * 3600 * 1000;
  const inWeek = (iso: string | null | undefined) => {
    const t = iso ? new Date(iso).getTime() : NaN;
    return !Number.isNaN(t) && t >= now.getTime() && t <= until;
  };
  const planNames = new Map(input.plans.map((p) => [p.id, p.name]));
  const upcoming: UpcomingItem[] = [
    ...scheduled
      .filter((p) => inWeek(p.scheduledAt))
      .map((p) => ({
        at: p.scheduledAt,
        kind: "post" as const,
        channel: CHANNEL[p.channel] ?? p.channel,
        title: planNames.get(p.contentPlanId) ?? "A post",
      })),
    ...input.newsletters
      .filter((n) => n.status === "scheduled" && inWeek(n.scheduledAt))
      .map((n) => ({ at: n.scheduledAt!, kind: "newsletter" as const, channel: "Newsletter", title: n.subject })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const needsYou: ReviewItem[] = [
    ...input.plans.map((p) => contentHubItem(workspace, p)).filter((i): i is ReviewItem => !!i),
    ...publishJobs.filter((p) => p.status === "failed").map((p) => failedPostItem(p, workspace.name)),
  ];

  return { pipeline, upcoming, needsYou };
}
