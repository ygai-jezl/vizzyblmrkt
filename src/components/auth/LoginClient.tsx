"use client";

import { GoogleOnlyLogin } from "./GoogleOnlyLogin";
import { PasswordLogin } from "./PasswordLogin";
import type { LegalHrefs } from "./views";

export interface LoginClientProps {
  /** Password sign-in can be offered (isPasswordSigninAvailable). Off: the Google-only page, as before. */
  passwordSignin: boolean;
  /** Anyone may create an account (isSelfServeSignupOpen); off, only addresses an admin added. */
  selfServeSignup: boolean;
  /** The legal pages this copy publishes, linked under Create account. */
  legal?: LegalHrefs;
}

const NO_LEGAL: LegalHrefs = { terms: null, privacy: null };

/** /login in the browser: the server reads the switches and picks the page. */
export function LoginClient({ passwordSignin, selfServeSignup, legal }: LoginClientProps) {
  if (!passwordSignin) return <GoogleOnlyLogin />;
  return <PasswordLogin selfServeSignup={selfServeSignup} legal={legal ?? NO_LEGAL} />;
}
