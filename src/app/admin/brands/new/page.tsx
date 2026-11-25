import { NewBrandForm } from "@/components/admin/NewBrandForm";
import { newBrandPlanNote, planById } from "@/lib/plans/catalog";
import { isPlansEnabled, isPlansUiEnabled, newOrganisationPlan } from "@/lib/plans/flags";
import { isIdeaWordsEnabled } from "@/lib/ideas/flags";
import { ideaWord } from "@/lib/nav/terms";

export const dynamic = "force-dynamic";

export default function NewBrandPage() {
  // With plans on, every new brand starts an organisation of its own (src/app/api/admin/tenants).
  const plan = isPlansEnabled() && isPlansUiEnabled() ? planById(newOrganisationPlan()) : null;
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-neutral-400">Brands</p>
        <h1 className="text-xl font-semibold">Add Brand</h1>
        <p className="text-sm text-neutral-500">
          Create a new brand workspace. You will be switched into it once it is
          created. Its {ideaWord(isIdeaWordsEnabled()).many}, audience and settings all live inside the new
          workspace.
        </p>
      </div>
      <NewBrandForm organisationNote={plan ? newBrandPlanNote(plan) : undefined} />
    </div>
  );
}
