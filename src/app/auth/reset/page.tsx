import type { Metadata } from "next";
import { ResetPassword } from "@/components/auth/ResetPassword";
import { isPasswordSigninEnabled } from "@/lib/auth/flags";

// The switch is read on each request, so turning it on needs no new build.
export const dynamic = "force-dynamic";

// A reset link carries a one-time code: never index it, never pass it on as a referrer.
export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };

/**
 * Where the password reset email's link lands. Firebase sends the email; this page checks the
 * link and saves the new password from the browser. Switched off, it says password sign-in is off.
 */
export default function ResetPasswordPage() {
  return <ResetPassword enabled={isPasswordSigninEnabled()} />;
}
