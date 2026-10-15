"use client";

import { useMemo } from "react";
import type { BrandMapDecided } from "@/lib/types/brandMap";
import { organizationJsonLd } from "@/lib/brandMap/orgMarkup";
import { schemaScriptTag } from "@/lib/content/blog/schema";
import { CopyField, Section } from "@/components/admin/connect/ui";

/** "Markup for your home page": the Organization markup, from the saved map, to paste in. */
export function BrandMapMarkup({ saved }: { saved: BrandMapDecided }) {
  const json = useMemo(() => organizationJsonLd(saved), [saved]);
  if (!json) return null;
  const tag = schemaScriptTag(json);
  return (
    <Section title="Markup for your home page" description="Built from the saved map. Your confirmed profile links become sameAs.">
      <pre className="max-h-80 overflow-auto rounded-md border border-neutral-200 bg-neutral-50 p-3 font-mono text-xs dark:border-neutral-800 dark:bg-neutral-900">
        {tag}
      </pre>
      <CopyField label="Copy it into your home page's <head>" value={tag.replace(/\s*\n\s*/g, " ")} />
    </Section>
  );
}
