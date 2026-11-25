import { notFound } from "next/navigation";
import SignInAndPasswordsHelp from "@/components/help/pages/sign-in-and-passwords";
import { isPasswordSigninAvailable } from "@/lib/auth/flags";
import { helpMetadata } from "@/lib/help/metadata";

export const dynamic = "force-dynamic";
export const metadata = helpMetadata("sign-in-and-passwords");

/** Served only while PASSWORD_SIGNIN_ENABLED is on. */
export default function Page() {
  if (!isPasswordSigninAvailable()) notFound();
  return <SignInAndPasswordsHelp />;
}
