import type { ReactNode } from "react";
import { CurateSubTabs } from "@/components/admin/workspace/CurateSubTabs";

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
      <CurateSubTabs workspaceId={workspaceId} />
      {children}
    </div>
  );
}
