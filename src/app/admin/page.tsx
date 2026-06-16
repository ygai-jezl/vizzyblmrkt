import { StubPage } from "@/components/admin/StubPage";

export const dynamic = "force-dynamic";

export default function AdminHome() {
  return (
    <StubPage
      title="Dashboard"
      description="Your GTM command center — live goal tickers, the approval queue, and launch health across every active launch. Real-time KPIs are already captured per launch (open a launch's Analytics tab); the unified command view lands here next."
    />
  );
}
