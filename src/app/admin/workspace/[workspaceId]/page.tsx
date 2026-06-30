import { redirect } from "next/navigation";

export default async function WorkspaceIndex({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  redirect(`/admin/workspace/${workspaceId}/curate`);
}
