import { notFound } from "next/navigation";
import HistoryAndRestoreHelp from "@/components/help/pages/history-and-restore";
import { helpMetadata } from "@/lib/help/metadata";
import { isSettingsHistoryEnabled } from "@/lib/settings/flags";

export const dynamic = "force-dynamic";
export const metadata = helpMetadata("history-and-restore");

/** Served only while SETTINGS_HISTORY_ENABLED is on. */
export default function Page() {
  if (!isSettingsHistoryEnabled()) notFound();
  return <HistoryAndRestoreHelp />;
}
