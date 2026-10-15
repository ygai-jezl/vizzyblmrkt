"use client";

import { BRAND_MAP_LIMITS as LIMITS, type BrandMapQuestion, type BrandMapSubject } from "@/lib/types/brandMap";
import { BlogIntent } from "@/lib/types/contentPlan";
import { newId } from "@/lib/brandMap/changes";
import { Section, inputClass } from "@/components/admin/connect/ui";
import { AddLine, Issues, RemoveButton, smallLabel } from "./BrandMapParts";
import { issuesAt, type MapIssue } from "./brandMapForm";

/** "What you want to be known for": a few subjects, each with the questions people ask. */

export const INTENT_LABEL: Record<BlogIntent, string> = {
  definition: "what it is",
  how_to: "how to do it",
  alternatives: "alternatives",
  comparison: "comparison",
  integrations: "integrations",
  use_cases: "use cases",
  pricing: "pricing",
  limits: "limits",
  benchmarks: "benchmarks",
  other: "related",
};

export function BrandMapSubjects({
  subjects,
  onChange,
  issues,
  disabled,
  status,
}: {
  subjects: BrandMapSubject[];
  onChange: (next: BrandMapSubject[]) => void;
  issues: MapIssue[];
  disabled: boolean;
  /** Under each question: whether a page answers it (coverage, when pages are on). */
  status?: (question: BrandMapQuestion, subject: BrandMapSubject) => React.ReactNode;
}) {
  const update = (i: number, next: BrandMapSubject) => onChange(subjects.map((s, j) => (j === i ? next : s)));
  return (
    <Section title="What you want to be known for" description="Three to five subjects, each with the questions people ask.">
      <div className="space-y-3">
        {subjects.map((s, i) => (
          <div key={s.id} className="space-y-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
            <div className="flex flex-wrap items-start gap-3">
              <label className="block min-w-[12rem] flex-1 space-y-1">
                <span className={smallLabel}>Subject</span>
                <input className={inputClass} value={s.name} maxLength={LIMITS.subjectName} disabled={disabled} onChange={(e) => update(i, { ...s, name: e.target.value })} />
              </label>
              <label className="block min-w-[12rem] flex-1 space-y-1">
                <span className={smallLabel}>Its page on your site</span>
                <input
                  className={inputClass}
                  value={s.home ?? ""}
                  placeholder="https://"
                  disabled={disabled}
                  onChange={(e) => {
                    const home = e.target.value.trim();
                    const { home: _old, ...rest } = s;
                    void _old;
                    update(i, home ? { ...rest, home } : rest);
                  }}
                />
              </label>
              <div className="pt-5">
                <RemoveButton label={`Remove the subject ${s.name}`} disabled={disabled} onClick={() => onChange(subjects.filter((_, j) => j !== i))} />
              </div>
            </div>
            <Issues messages={[...issuesAt(issues, `subjects.${i}.name`), ...issuesAt(issues, `subjects.${i}.home`)]} />

            <div className="space-y-1.5">
              <span className={smallLabel}>Questions people ask</span>
              <ul className="space-y-1.5">
                {s.questions.map((q, j) => (
                  <li key={q.id} className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                    <input
                      aria-label={`Question ${j + 1} of ${s.name}`}
                      className={`${inputClass} min-w-[14rem] flex-1`}
                      value={q.text}
                      maxLength={LIMITS.questionText}
                      disabled={disabled}
                      onChange={(e) => update(i, { ...s, questions: s.questions.map((x, k) => (k === j ? { ...x, text: e.target.value } : x)) })}
                    />
                    <select
                      aria-label={`What question ${j + 1} is about`}
                      className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
                      value={q.intent}
                      disabled={disabled}
                      onChange={(e) =>
                        update(i, { ...s, questions: s.questions.map((x, k) => (k === j ? { ...x, intent: BlogIntent.parse(e.target.value) } : x)) })
                      }
                    >
                      {BlogIntent.options.map((intent) => (
                        <option key={intent} value={intent}>
                          {INTENT_LABEL[intent]}
                        </option>
                      ))}
                    </select>
                    <RemoveButton label={`Remove the question “${q.text}”`} disabled={disabled} onClick={() => update(i, { ...s, questions: s.questions.filter((_, k) => k !== j) })} />
                    </div>
                    {status?.(q, s)}
                  </li>
                ))}
              </ul>
              {!disabled && s.questions.length < LIMITS.questions ? (
                <AddLine
                  label={`A question about ${s.name}`}
                  placeholder="A question a buyer would type"
                  maxLength={LIMITS.questionText}
                  onAdd={(text) => update(i, { ...s, questions: [...s.questions, { id: newId("q"), text, intent: "other" }] })}
                />
              ) : null}
              <Issues messages={issuesAt(issues, `subjects.${i}.questions`)} />
            </div>
          </div>
        ))}
      </div>
      {!disabled && subjects.length < LIMITS.subjects ? (
        <AddLine
          label="A subject you want to be known for"
          placeholder="Add a subject"
          maxLength={LIMITS.subjectName}
          onAdd={(name) => onChange([...subjects, { id: newId("sub"), name, questions: [] }])}
        />
      ) : null}
    </Section>
  );
}
