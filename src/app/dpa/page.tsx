import { LegalPage, legalMetadata } from "@/components/legal/LegalPage";

export const dynamic = "force-dynamic";

export function generateMetadata() {
  return legalMetadata("dpa");
}

export default function Page() {
  return <LegalPage slug="dpa" />;
}
