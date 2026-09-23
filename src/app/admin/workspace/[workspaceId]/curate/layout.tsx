import type { ReactNode } from "react";
import { CurateSubTabs } from "@/components/admin/workspace/CurateSubTabs";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";

export default async function CurateLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return (
    <div className="space-y-4">
      {/* Nav v2 phase 3: Ideas and Knowledge are tabs of their own. */}
      {isNavV2Phase3Enabled() ? null : <CurateSubTabs workspaceId={workspaceId} />}
      {children}
    </div>
  );
}
