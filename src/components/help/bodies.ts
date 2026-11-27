import type { ReactNode } from "react";
import type { HelpBodyProps } from "@/lib/help/pages";
import GetSetUpHelp from "./pages/get-set-up";
import PlanAndUsageHelp from "./pages/plan-and-usage";
import SignInAndPasswordsHelp from "./pages/sign-in-and-passwords";
import WorkHelp from "./pages/work";
import EmailSendingHelp from "./pages/email-sending";
import YourBrandHelp from "./pages/your-brand";
import EmailStyleHelp from "./pages/email-style";
import LaunchAndWaitlistHelp from "./pages/launch-and-waitlist";
import NewsletterFromYourSiteHelp from "./pages/newsletter-from-your-site";
import ProgrammesAndKnowledgeHelp from "./pages/programmes-and-knowledge";
import BrandMapHelp from "./pages/brand-map";
import WriteAndScheduleHelp from "./pages/write-and-schedule";
import WhatYouGrowLearnedHelp from "./pages/what-yougrow-learned";
import ConnectedAccountsHelp from "./pages/connected-accounts";
import ConnectedDataHelp from "./pages/connected-data";
import SharedConnectionsHelp from "./pages/shared-connections";
import OrganisationBrandsHelp from "./pages/organisation-brands";
import ConnectYourProductHelp from "./pages/connect-your-product";
import InviteYourWaitlistHelp from "./pages/invite-your-waitlist";
import OnboardingJourneysHelp from "./pages/onboarding-journeys";
import ReviewAndApprovalsHelp from "./pages/review-and-approvals";
import PeopleHelp from "./pages/people";
import SearchHelp from "./pages/search";
import LanguagesHelp from "./pages/languages";
import YourAudienceHelp from "./pages/your-audience";
import InvestorsAndFundingHelp from "./pages/investors-and-funding";
import HistoryAndRestoreHelp from "./pages/history-and-restore";
import TroubleshootingHelp from "./pages/troubleshooting";

/** Each help page's body by slug ("" = Get set up): the /help routes, their Markdown copies and llms-full.txt render these. */
export const HELP_BODIES: Record<string, (props?: HelpBodyProps) => ReactNode> = {
  "": GetSetUpHelp,
  "plan-and-usage": PlanAndUsageHelp,
  "organisation-brands": OrganisationBrandsHelp,
  "sign-in-and-passwords": SignInAndPasswordsHelp,
  "work": WorkHelp,
  "email-sending": EmailSendingHelp,
  "your-brand": YourBrandHelp,
  "email-style": EmailStyleHelp,
  "languages": LanguagesHelp,
  "launch-and-waitlist": LaunchAndWaitlistHelp,
  "newsletter-from-your-site": NewsletterFromYourSiteHelp,
  "programmes-and-knowledge": ProgrammesAndKnowledgeHelp,
  "brand-map": BrandMapHelp,
  "write-and-schedule": WriteAndScheduleHelp,
  "what-yougrow-learned": WhatYouGrowLearnedHelp,
  "connected-accounts": ConnectedAccountsHelp,
  "connected-data": ConnectedDataHelp,
  "shared-connections": SharedConnectionsHelp,
  "connect-your-product": ConnectYourProductHelp,
  "invite-your-waitlist": InviteYourWaitlistHelp,
  "onboarding-journeys": OnboardingJourneysHelp,
  "review-and-approvals": ReviewAndApprovalsHelp,
  "people": PeopleHelp,
  "search": SearchHelp,
  "your-audience": YourAudienceHelp,
  "investors-and-funding": InvestorsAndFundingHelp,
  "history-and-restore": HistoryAndRestoreHelp,
  "troubleshooting": TroubleshootingHelp,
};
