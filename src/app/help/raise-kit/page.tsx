import { notFound } from "next/navigation";
import RaiseKitHelp from "@/components/help/pages/raise-kit";
import { helpMetadata } from "@/lib/help/metadata";
import { isRaiseKitEnabled } from "@/lib/raise/docs/flags";

export const dynamic = "force-dynamic";
export const metadata = helpMetadata("raise-kit");

/** Served only while RAISE_KIT_ENABLED is on. */
export default function Page() {
  if (!isRaiseKitEnabled()) notFound();
  return <RaiseKitHelp />;
}
