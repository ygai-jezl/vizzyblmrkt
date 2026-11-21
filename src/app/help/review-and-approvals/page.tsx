import ReviewAndApprovalsHelp from "@/components/help/pages/review-and-approvals";
import { helpMetadata } from "@/lib/help/metadata";

export const metadata = helpMetadata("review-and-approvals");

/** A page of its own, so Next.js never passes the route's props to the help body. */
export default function Page() {
  return <ReviewAndApprovalsHelp />;
}
