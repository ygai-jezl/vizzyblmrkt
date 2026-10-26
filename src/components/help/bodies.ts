import type { ReactNode } from "react";
import GetSetUpHelp from "./pages/get-set-up";
import EmailSendingHelp from "./pages/email-sending";
import YourBrandHelp from "./pages/your-brand";
import EmailStyleHelp from "./pages/email-style";
import LaunchAndWaitlistHelp from "./pages/launch-and-waitlist";
import NewsletterFromYourSiteHelp from "./pages/newsletter-from-your-site";
import ProgrammesAndKnowledgeHelp from "./pages/programmes-and-knowledge";
import BrandMapHelp from "./pages/brand-map";
import WriteAndScheduleHelp from "./pages/write-and-schedule";
import ConnectedAccountsHelp from "./pages/connected-accounts";
import ConnectYourProductHelp from "./pages/connect-your-product";
import InviteYourWaitlistHelp from "./pages/invite-your-waitlist";
import OnboardingJourneysHelp from "./pages/onboarding-journeys";
import ReviewAndApprovalsHelp from "./pages/review-and-approvals";
import PeopleHelp from "./pages/people";
import TroubleshootingHelp from "./pages/troubleshooting";

/** Each help page's body by slug ("" = Get set up): the /help routes, their Markdown copies and llms-full.txt render these. */
export const HELP_BODIES: Record<string, () => ReactNode> = {
  "": GetSetUpHelp,
  "email-sending": EmailSendingHelp,
  "your-brand": YourBrandHelp,
  "email-style": EmailStyleHelp,
  "launch-and-waitlist": LaunchAndWaitlistHelp,
  "newsletter-from-your-site": NewsletterFromYourSiteHelp,
  "programmes-and-knowledge": ProgrammesAndKnowledgeHelp,
  "brand-map": BrandMapHelp,
  "write-and-schedule": WriteAndScheduleHelp,
  "connected-accounts": ConnectedAccountsHelp,
  "connect-your-product": ConnectYourProductHelp,
  "invite-your-waitlist": InviteYourWaitlistHelp,
  "onboarding-journeys": OnboardingJourneysHelp,
  "review-and-approvals": ReviewAndApprovalsHelp,
  "people": PeopleHelp,
  "troubleshooting": TroubleshootingHelp,
};
