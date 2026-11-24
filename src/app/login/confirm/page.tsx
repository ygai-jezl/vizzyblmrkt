import type { Metadata } from "next";
import { ConfirmEmail } from "@/components/auth/ConfirmEmail";
import { isPasswordSigninAvailable } from "@/lib/auth/flags";

// The switch is read on each request, so turning it on needs no new build.
export const dynamic = "force-dynamic";

// The link carries a one-time token (in the fragment): never index the page, never send it on as a referrer.
export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };

/**
 * Where the "Email me a link instead" email's link lands (/login/confirm#t=...). The page takes
 * the token from the fragment, then confirms the address from a browser signed in to the account,
 * asking for the email and password first when it isn't. With password sign-in unavailable it says
 * so, and the link does nothing.
 */
export default function ConfirmEmailPage() {
  return <ConfirmEmail enabled={isPasswordSigninAvailable()} />;
}
