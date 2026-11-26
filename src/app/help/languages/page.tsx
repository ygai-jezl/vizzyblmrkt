import { notFound } from "next/navigation";
import LanguagesHelp from "@/components/help/pages/languages";
import { helpMetadata } from "@/lib/help/metadata";
import { isContentLanguageEnabled } from "@/lib/i18n/flags";

export const dynamic = "force-dynamic";
export const metadata = helpMetadata("languages");

/** Served only while CONTENT_LANGUAGE_ENABLED is on. */
export default function Page() {
  if (!isContentLanguageEnabled()) notFound();
  return <LanguagesHelp />;
}
