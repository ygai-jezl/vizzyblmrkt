import { DashboardCards } from "@/components/admin/DashboardCards";
import { DashboardChat } from "@/components/admin/chat/DashboardChat";

export const dynamic = "force-dynamic";

/**
 * GTM command center. Mock top-level data cards sit above the root-agent chat,
 * which floats at the bottom of the screen. The chat is the orchestrator agent's
 * front-end (Phase 1: UI + stubbed streaming; live ADK agent lands in Phase 2).
 */
export default function AdminHome() {
  return (
    <div className="flex min-h-[calc(100vh-3rem)] flex-col gap-6">
      <DashboardCards />
      <DashboardChat />
    </div>
  );
}
