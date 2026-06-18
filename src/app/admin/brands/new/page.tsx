import { NewBrandForm } from "@/components/admin/NewBrandForm";

export const dynamic = "force-dynamic";

export default function NewBrandPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-neutral-400">Brands</p>
        <h1 className="text-xl font-semibold">Add Brand</h1>
        <p className="text-sm text-neutral-500">
          Create a new brand workspace. You will be switched into it once it is
          created — its launches, audience, and settings all live inside the new
          workspace.
        </p>
      </div>
      <NewBrandForm />
    </div>
  );
}
