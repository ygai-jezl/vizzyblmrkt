import { CheckCircle2, Circle } from "lucide-react";
import { SEVERITY_LABEL, type IntegrationTask } from "@/lib/connect/integrationTasks";
import { Badge } from "./ui";
import { CodeText } from "./CodeText";

const TONE = { required: "red", compliance: "amber", personalisation: "green", recommended: "neutral" } as const;

/** Their side of the integration, in priority order — what to build, where, and what happens if they don't. */
export function IntegrationTasks({ tasks, showDone = true }: { tasks: IntegrationTask[]; showDone?: boolean }) {
  return (
    <ol className="space-y-3">
      {tasks.map((t, i) => (
        <li key={t.id} className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
          <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {showDone ? (
              t.status === "done" ? <CheckCircle2 size={16} className="text-green-600" /> : <Circle size={16} className="text-neutral-400" />
            ) : null}
            <span>
              {i + 1}. {t.title}
            </span>
            <Badge tone={TONE[t.severity]}>{SEVERITY_LABEL[t.severity]}</Badge>
            {t.status === "done" ? <span className="text-xs font-normal text-green-600">working</span> : null}
          </div>
          <p className="mt-1 text-sm">
            <CodeText text={t.action} />
          </p>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            <span className="font-medium">If skipped:</span> <CodeText text={t.ifSkipped} />
          </p>
          {t.fromCode.length ? (
            <ul className="mt-2 space-y-1 text-xs text-neutral-600 dark:text-neutral-400">
              {t.fromCode.map((c, j) => (
                <li key={j}>
                  <span className="font-medium">Found in your code:</span> <CodeText text={c} />
                </li>
              ))}
            </ul>
          ) : null}
          {t.files.length ? (
            <p className="mt-1 text-xs text-neutral-500">
              Look at:{" "}
              {t.files.map((f, j) => (
                <code key={j} className="mr-2 font-mono">
                  {f.path}
                  {f.line ? `:${f.line}` : ""}
                </code>
              ))}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
