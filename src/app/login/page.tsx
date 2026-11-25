import { LoginClient } from "@/components/auth/LoginClient";
import type { LegalHrefs } from "@/components/auth/views";
import { isPasswordSigninAvailable, isSelfServeSignupOpen } from "@/lib/auth/flags";
import { legalLinks } from "@/lib/legal/pages";

// The sign-in switches are read on each request, so turning one on needs no new build.
export const dynamic = "force-dynamic";

/** The legal pages this copy publishes, for the line under Create account. */
function legalHrefs(): LegalHrefs {
  const hrefs = new Set(legalLinks().map((l) => l.href));
  return { terms: hrefs.has("/terms") ? "/terms" : null, privacy: hrefs.has("/privacy") ? "/privacy" : null };
}

/**
 * Admin sign in. With password sign-in unavailable (switch off, or no way to deliver the code)
 * this is the Google-only page, unchanged.
 */
export default function LoginPage() {
  const passwordSignin = isPasswordSigninAvailable();
  return (
    <LoginClient
      passwordSignin={passwordSignin}
      selfServeSignup={passwordSignin && isSelfServeSignupOpen()}
      legal={passwordSignin ? legalHrefs() : undefined}
    />
  );
}
