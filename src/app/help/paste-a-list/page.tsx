import { notFound } from "next/navigation";
import PasteAListHelp from "@/components/help/pages/paste-a-list";
import { helpMetadata } from "@/lib/help/metadata";
import { isPasteEnabled } from "@/lib/crm/paste/flags";

export const dynamic = "force-dynamic";
export const metadata = helpMetadata("paste-a-list");

/** Served only while RAISE_PASTE_ENABLED is on (with New person). */
export default function Page() {
  if (!isPasteEnabled()) notFound();
  return <PasteAListHelp />;
}
