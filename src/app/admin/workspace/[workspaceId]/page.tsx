import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowRight, BookOpen, Calendar, Lightbulb, PenLine, Send } from "lucide-react";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant, getTenantById } from "@/lib/tenant";
import { listContentPlans, listIdeaItems, listTemplates } from "@/lib/tenant/workspaceContent";
import { listScheduledPosts } from "@/lib/distribute/scheduler";
import { renderBrandVoice } from "@/lib/agents/prompts/compose";
import { programmeOverview } from "@/lib/content/programmeOverview";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";

export const dynamic = "force-dynamic";

async function soft<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * A content programme. Before nav v2 phase 3 this redirected to Curate. With
 * phase 3 it's the Overview: the pipeline at a glance, the next seven days, what
 * needs a person, and which voice and knowledge the writing uses.
 */
export default async function WorkspaceIndex({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  if (!isNavV2Phase3Enabled()) redirect(`/admin/workspace/${workspaceId}/curate`);

  const ctx = await requireAdminContext();
  const repos = forTenant(ctx);
  const ws = await repos.workspaces.getById(workspaceId);
  if (!ws) notFound();
  const [ideas, templates, plans, posts, newsletters, sources, tenant] = await Promise.all([
    soft(listIdeaItems(ctx, workspaceId, 200), []),
    soft(listTemplates(ctx, workspaceId, 300), []),
    soft(listContentPlans(ctx, workspaceId, 200), []),
    soft(listScheduledPosts(ctx, workspaceId, undefined, 500), []),
    soft(repos.broadcasts.find({ where: [["sourceWorkspaceId", "==", workspaceId]] }), []),
    soft(
      repos.ingestionTickets.find({
        where: [
          ["ownerKind", "==", "workspace"],
          ["ownerId", "==", workspaceId],
        ],
      }),
      [],
    ),
    soft(getTenantById(ctx.tenantId), null),
  ]);
  const overview = programmeOverview({
    workspace: { id: ws.id, name: ws.name },
    ideas,
    templates: templates.length,
    plans,
    posts,
    newsletters,
    now: new Date(),
  });
  const base = `/admin/workspace/${workspaceId}`;
  const brandVoice = !!tenant && renderBrandVoice(tenant.brandVoice).trim().length > 0;
  const voice = brandVoice ? "Your brand voice" : ws.brandVoice?.trim() ? "This programme's own voice" : "No voice set yet";

  return (
    <div className="space-y-6">
      <ol aria-label="Pipeline" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {overview.pipeline.map((stage) => (
          <li key={stage.key}>
            <Link
              href={`${base}/${stage.tab}`}
              className="block rounded-lg border border-neutral-200 px-4 py-3 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
            >
              <span className="block text-xs text-neutral-500 dark:text-neutral-400">{stage.label}</span>
              <span className="block text-2xl font-semibold tabular-nums">{stage.count}</span>
              <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400">{stage.note ?? " "}</span>
            </Link>
          </li>
        ))}
      </ol>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <section className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">Next 7 days</h2>
            <Link href={`${base}/distribute`} className="text-xs font-medium text-blue-700 hover:underline dark:text-blue-300">
              Open calendar
            </Link>
          </div>
          {overview.upcoming.length ? (
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-900">
              {overview.upcoming.map((u, i) => (
                <li key={`${u.at}:${i}`} className="flex items-center gap-3 py-2 text-sm">
                  <span className="w-32 shrink-0 text-xs tabular-nums text-neutral-500 dark:text-neutral-400">{when(u.at)}</span>
                  <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-medium dark:bg-neutral-800">
                    {u.channel}
                  </span>
                  <span className="min-w-0 truncate">{u.title}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">Nothing scheduled this week.</p>
          )}
        </section>

        <section className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-sm font-semibold">Needs you</h2>
          {overview.needsYou.length ? (
            <ul className="space-y-1">
              {overview.needsYou.map((item) => (
                <li key={item.id}>
                  <Link href={item.href} className="block rounded-md px-2 py-1.5 hover:bg-neutral-50 dark:hover:bg-neutral-900">
                    <span className="block text-sm">{item.title}</span>
                    <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400">{item.detail}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">Nothing waiting on you here.</p>
          )}
        </section>
      </div>

      <div className="flex flex-wrap gap-2">
        {[
          { href: `${base}/curate/idea-board`, label: "Capture an idea", Icon: Lightbulb },
          { href: `${base}/create`, label: "New draft", Icon: PenLine },
          { href: `${base}/distribute`, label: "Schedule posts", Icon: Calendar },
          { href: `${base}/weekly`, label: "Send this week's newsletter", Icon: Send },
        ].map(({ href, label, Icon }) => (
          <Link
            key={label}
            href={href}
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            <Icon size={15} aria-hidden /> {label}
          </Link>
        ))}
      </div>

      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400">
        <span>
          Voice: {voice} ·{" "}
          <Link href={brandVoice ? "/admin/brand-kit/voice" : `${base}/settings`} className="underline underline-offset-2">
            {brandVoice ? "edit in Brand" : "set it"}
          </Link>
        </span>
        <span className="inline-flex items-center gap-1">
          <BookOpen size={13} aria-hidden /> Knowledge: {sources.length} source{sources.length === 1 ? "" : "s"} ·{" "}
          <Link href={`${base}/curate/grounding`} className="inline-flex items-center gap-0.5 underline underline-offset-2">
            manage <ArrowRight size={11} aria-hidden />
          </Link>
        </span>
      </p>
    </div>
  );
}
