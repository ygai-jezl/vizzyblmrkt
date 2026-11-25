import type { ReactElement } from "react";
import { requireAdminContext } from "@/lib/auth/session";
import { getTenantById } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { isNavV2Enabled, isNavV2Phase2Enabled, isNavV2Phase3Enabled } from "@/lib/nav/flags";
import { isOnboardingEnabled } from "@/lib/onboarding/flags";
import { aboutConversations, aboutFacts, aboutWaiting } from "@/lib/onboarding/aboutYourBusiness";
import { openFactSuggestions } from "@/lib/onboarding/factSuggestions";
import { listBusinessFacts, listConversations } from "@/lib/onboarding/store";
import { mayTalkWithVizzy } from "@/lib/onboarding/voiceAccess";
import { AboutYourBusiness } from "@/components/admin/onboarding/AboutYourBusiness";
import { AccountSettings } from "@/components/admin/AccountSettings";
import { SearchSettingsCard } from "@/components/admin/search/SearchSettingsCard";
import { isSearchUiEnabled } from "@/lib/search/flags";
import { GoogleMarketCard } from "@/components/admin/signals/GoogleMarketCard";
import { isBrandSignalsEnabled } from "@/lib/signals/flags";
import { TimeZoneCard } from "@/components/admin/settings/TimeZoneCard";
import { isBlogDatesEnabled } from "@/lib/brandMap/flags";
import { SignInSecurityCard } from "@/components/admin/SignInSecurityCard";
import { isPasswordSigninEnabled } from "@/lib/auth/flags";

export const dynamic = "force-dynamic";

const REGION: Record<string, string> = { us: "United States", eu: "Europe", asia: "Asia" };

/**
 * About your business is for admins, with the shell's palette (nav v2): shown while the switch is
 * on, and after it while the brand has a profile or keeps a conversation or a fact, so kept words
 * can always be read and deleted.
 */
function mayShowAbout(ctx: Pick<TenantContext, "role">): boolean {
  return ctx.role === "admin" && isNavV2Enabled();
}

/**
 * Settings › General › About your business (ONBOARDING_ENABLED): the brand's four answers, what
 * Vizzy learned (and, with the switch on, what it heard in later chats, waiting to be kept) and
 * the kept conversations. Two or three regional reads, for admins only; a list that fails shows
 * as not loaded, never as empty.
 */
async function aboutYourBusiness(ctx: TenantContext, tenant: Tenant | null): Promise<ReactElement | null> {
  const onboarding = isOnboardingEnabled();
  const profile = tenant?.businessProfile;
  if (!mayShowAbout(ctx)) return null;
  // With the switch off, a brand with no profile may still keep a call (one never confirmed): both
  // lists are read (bounded, in the brand's region), and the section shows only to read and delete.
  const [facts, conversations, waiting] = await Promise.all([
    listBusinessFacts(ctx).then(aboutFacts, () => {
      console.warn("[settings] about your business: the facts didn't load");
      return null;
    }),
    listConversations(ctx).then(aboutConversations, () => {
      console.warn("[settings] about your business: the conversations didn't load");
      return null;
    }),
    onboarding
      ? openFactSuggestions(ctx).then(aboutWaiting, () => {
          console.warn("[settings] about your business: what Vizzy heard in chats didn't load");
          return [];
        })
      : [],
  ]);
  if (!onboarding && !profile && !facts?.length && !conversations?.length) return null;
  return (
    <AboutYourBusiness
      answers={profile?.answers ?? {}}
      facts={facts}
      conversations={conversations}
      waiting={waiting}
      // The welcome needs nav v2 phase 2, so the link does too.
      voice={isNavV2Phase2Enabled() && mayTalkWithVizzy(tenant)}
      editable={onboarding}
    />
  );
}

/**
 * Account-wide settings: content-language defaults. With nav v2 phase 3 this is
 * Settings › General, and also shows the brand's details (the ids and data region
 * that used to sit in the sidebar footer). With PASSWORD_SIGNIN_ENABLED it also
 * has Sign-in and security: how you sign in, change password, sign out everywhere.
 * With ONBOARDING_ENABLED an admin sees About your business first.
 */
export default async function AccountSettingsPage() {
  const ctx = await requireAdminContext();
  const search = isSearchUiEnabled() ? <SearchSettingsCard isAdmin={ctx.role === "admin"} /> : null;
  const market = isBrandSignalsEnabled() ? <GoogleMarketCard isAdmin={ctx.role === "admin"} /> : null;
  const zone = isBlogDatesEnabled() ? <TimeZoneCard isAdmin={ctx.role === "admin"} /> : null;
  const security = isPasswordSigninEnabled() ? <SignInSecurityCard /> : null;
  const phase3 = isNavV2Phase3Enabled();
  // One read of the brand, shared by Brand details and About your business.
  const tenant = phase3 || mayShowAbout(ctx) ? await getTenantById(ctx.tenantId).catch(() => null) : null;
  const about = await aboutYourBusiness(ctx, tenant);
  if (!phase3) {
    return about || search || market || zone || security ? (
      <div className="space-y-6">
        {about}
        <AccountSettings />
        {security}
        {search}
        {market}
        {zone}
      </div>
    ) : (
      <AccountSettings />
    );
  }
  const rows: Array<[string, string]> = [
    ["Brand", tenant?.tenantName ?? ctx.tenantId],
    ["Primary domain", tenant?.rootDomain || "Not set. Add it under Sending."],
    ["Data region", `${REGION[ctx.region] ?? ctx.region} (can't be changed)`],
    ["Brand ID", ctx.tenantId],
  ];
  return (
    <div className="space-y-6">
      {about}
      <section className="max-w-2xl space-y-2">
        <h2 className="text-sm font-semibold">Brand details</h2>
        <dl className="divide-y divide-neutral-100 rounded-md border border-neutral-200 text-sm dark:divide-neutral-900 dark:border-neutral-800">
          {rows.map(([k, v]) => (
            <div key={k} className="flex gap-4 px-4 py-2.5">
              <dt className="w-36 shrink-0 text-neutral-500 dark:text-neutral-400">{k}</dt>
              <dd className={k === "Brand ID" ? "font-mono text-xs leading-5" : ""}>{v}</dd>
            </div>
          ))}
        </dl>
      </section>
      {security}
      {search}
      {market}
      {zone}
      <AccountSettings />
    </div>
  );
}
