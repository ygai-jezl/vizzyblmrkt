import { H1, H2, Lead, P, Pairs, UL } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Messages, Meta, NextPage, Open } from "@/components/help/blocks";
import { PLANS } from "@/lib/plans/catalog";

/** /help/plan-and-usage (NEXT_PUBLIC_PLANS_ENABLED): Settings › Plan and usage. No prices: they may change. */
export default function PlanAndUsageHelp() {
  return (
    <article>
      <H1>Plan and usage</H1>
      <Lead>
        See which plan your brand is on, what it includes, the brands that share it and how much of each allowance is in use.
        A plan sets what your brands can use and how much. It never deletes anything.
      </Lead>
      <Meta items={["About 2 minutes", "Everyone on the team", "Any time"]} />

      <BeforeAndUnlocks
        before={
          <>
            <li>A brand to look at</li>
            <li>Plans turned on in your copy of YouGrow</li>
          </>
        }
        unlocks={
          <>
            <li>What your plan includes, before you start something it doesn&apos;t</li>
            <li>Where you stand on each allowance, so a limit is never a surprise</li>
          </>
        }
      />

      <H2 id="plan">Your plan</H2>
      <P>
        Open <Open href="/admin/account/billing">Settings › Plan and usage</Open>. It shows your plan, a line about it and
        since when you have had it. There are five plans:
      </P>
      <Pairs head={["Plan", "In a sentence"]} rows={PLANS.map((p) => [p.name, p.summary])} />
      <P>
        A plan guides what you do next and never deletes what you made: at a limit nothing is removed, and a feature
        outside your plan keeps everything it saved. A brand that isn&apos;t on a plan yet can use everything your copy of
        YouGrow turns on.
      </P>

      <H2 id="brands">Brands on your plan</H2>
      <UL>
        <li>
          A brand you <Open href="/admin/brands/new">add</Open> starts on a plan of its own, and you are its first owner. The
          Add Brand page says which plan it starts on.
        </li>
        <li>
          Whoever runs your copy of YouGrow can put brands together on one plan, or take one back out. Moving a brand never
          removes anyone or anything from it.
        </li>
        <li>
          Owners see every brand on the plan, with its data region, and the totals across them. A brand that is suspended
          still counts, marked <strong>Suspended</strong>.
        </li>
        <li>Everyone else sees their own brand&apos;s figures, and a line saying the plan is shared.</li>
      </UL>

      <H2 id="use">What is counted</H2>
      <P>
        <strong>Now</strong> is what you have today:
      </P>
      <Pairs
        head={["Line", "What it counts"]}
        rows={[
          ["Brands", "Every brand on the plan, suspended ones too."],
          ["Users", "Everyone who can open any of the plan's brands, counted once however many brands they are in."],
          ["People", "Everyone in each brand's Audience, added up across the plan's brands."],
          ["Live launches", "Each brand's launches that aren't archived. This one is per brand, not shared."],
        ]}
      />
      <P>
        <strong>This month</strong> starts again on the 1st (UTC):
      </P>
      <UL>
        <li>
          Per brand, the monthly allowances its features use: Google lookups for Next up, competitor articles read and
          autopilot drafts. See <Open href="/help/brand-map">Brand map</Open> for what each one does.
        </li>
        <li>
          Emails and AI credits show as <strong>Not counted yet</strong>, with the allowance your plan gives. AI credits are
          given per user on some plans.
        </li>
      </UL>

      <H2 id="limits">At a limit</H2>
      <P>Nobody and nothing is removed. New ones wait until there is room.</P>
      <UL>
        <li>A monthly allowance that runs out stops that feature for the rest of the month. It starts again on the 1st.</li>
        <li>Over a shared allowance, owners see it in the Your organisation box on Plan and usage.</li>
        <li>
          To make room, archive a launch you have finished, or ask whoever runs your copy of YouGrow about another plan.
        </li>
      </UL>

      <H2 id="not-included">When a feature isn&apos;t in your plan</H2>
      <Pairs
        head={["Part", "What happens"]}
        rows={[
          ["Kept", "Everything the feature saved. Nothing is deleted, and it is all there again when the feature is back."],
          [
            "Stops",
            "Its scheduled work, such as the weekly competitor checks, Next up and the autopilot. Its screens show one of the messages below instead, and what it saved is out of view until the feature is back.",
          ],
          [
            "Where to look",
            <>
              <Open href="/admin/account/billing">Plan and usage</Open> lists each feature as included, granted to your brand,
              or not in your plan. A feature that works only with another says what it needs: the article autopilot needs
              Next up.
            </>,
          ],
        ]}
      />
      <P>
        Some features are turned on brand by brand as well, such as <Open href="/help/search">Search</Open>. One granted to
        your brand works even when your plan leaves it out.
      </P>

      <H2 id="change">Changing your plan</H2>
      <P>
        To change your plan or put brands together on one plan, ask whoever runs your copy of YouGrow. They can also add
        owners. Before anything changes they see what would, including any feature your brands would lose.
      </P>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          [
            "Over your plan. Nobody and nothing is removed; new ones wait until there is room.",
            "Archive what you have finished, or ask whoever runs your copy of YouGrow about another plan.",
          ],
          [
            "This brand isn't on a plan yet, so everything your copy of YouGrow turns on is open.",
            "Nothing to do. Whoever runs your copy of YouGrow can give it a plan.",
          ],
          [
            "Plans are off in this copy of YouGrow, so every brand may use everything its switches turn on.",
            "Nothing to do. Every feature your copy turns on is yours to use.",
          ],
          [
            "Competitors isn't included for this brand.",
            "Check Plan and usage. Ask whoever runs your copy of YouGrow to add Competitors to your plan or grant it to your brand.",
          ],
          ["Draft isn't part of this brand's plan. Suggest is.", "Choose Suggest, or ask whoever runs your copy of YouGrow about Draft."],
          [
            "Google wasn't asked: lookups aren't part of this brand's plan.",
            "Lookups come with Next up. Ask whoever runs your copy of YouGrow to add Next up to your plan or grant it to your brand.",
          ],
          [
            "Vizzy editing isn't included for this brand.",
            "Edit the text yourself, or ask whoever runs your copy of YouGrow to add Vizzy in Edit mode.",
          ],
          [
            "Search isn't available for this brand yet.",
            "Brand search isn't in your plan, or isn't turned on for your brand yet. Ask whoever runs your copy of YouGrow.",
          ],
        ]}
      />

      <NextPage slug="plan-and-usage" />
    </article>
  );
}
