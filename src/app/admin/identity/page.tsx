import { redirect } from "next/navigation";
import { StubPage } from "@/components/admin/StubPage";
import { isOneViewEnabled } from "@/lib/audience/flags";

export const dynamic = "force-dynamic";

export default function IdentityRadarPage() {
  // The one People list (AUDIENCE_ONE_VIEW_ENABLED) is what this placeholder promised.
  if (isOneViewEnabled()) redirect("/admin/crm");
  return (
    <StubPage
      title="Identity Radar"
      description="Resolve and enrich the people and companies behind your signups — firmographic and technographic signals surfaced automatically."
    />
  );
}
