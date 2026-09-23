import { DashboardCards } from "@/components/admin/DashboardCards";
import { DashboardChat } from "@/components/admin/chat/DashboardChat";
import { HomeV2 } from "@/components/admin/home/HomeV2";
import { isNavV2Enabled, isNavV2Phase2Enabled } from "@/lib/nav/flags";

export const dynamic = "force-dynamic";

/**
 * GTM command center. Mock top-level data cards sit above the root-agent chat,
 * which floats at the bottom of the screen. The chat is the orchestrator agent's
 * front-end (Phase 1: UI + stubbed streaming; live ADK agent lands in Phase 2).
 */
export default function AdminHome() {
  // Nav v2 phase 2: the growth path, real metrics and Review, above Vizzy.
  if (isNavV2Phase2Enabled()) return <HomeV2 />;
  return (
    // min-h keeps the chat at the bottom of the screen: 3rem of <main> padding,
    // plus the 3rem nav v2 header when that is on.
    <div
      className={`flex flex-col gap-6 ${
        isNavV2Enabled() ? "min-h-[calc(100vh-6rem)]" : "min-h-[calc(100vh-3rem)]"
      }`}
    >
      <DashboardCards />
      <DashboardChat />
    </div>
  );
}
