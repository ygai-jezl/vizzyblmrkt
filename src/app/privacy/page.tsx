import { LegalPage, legalMetadata } from "@/components/legal/LegalPage";

export const dynamic = "force-dynamic";

export function generateMetadata() {
  return legalMetadata("privacy");
}

export default function Page() {
  return <LegalPage slug="privacy" />;
}
