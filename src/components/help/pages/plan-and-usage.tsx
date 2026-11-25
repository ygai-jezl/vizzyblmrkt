import { H1, H2, Lead, P, Pairs, UL } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Messages, Meta, NextPage, Open } from "@/components/help/blocks";
import { allowanceLabels, PLANS, planSummary } from "@/lib/plans/catalog";
import { isEditModeLearningFollowsVizzyEnabled } from "@/lib/content/editor/flags";
import { isOrganisationJoinEnabled, isUsageMeterUiEnabled } from "@/lib/plans/flags";
import { IMAGE_LIMIT_MESSAGE, WEB_SEARCH_LIMIT_MESSAGE } from "@/lib/plans/resources";
import { isPeopleNameEnabled } from "@/lib/audience/flags";
import { isAddPersonEnabled } from "@/lib/audience/peopleFlags";
import { isConnectorsSharingEnabled } from "@/lib/connectors/flags";
import { isOnboardingVoiceEnabled } from "@/lib/onboarding/flags";
import type { HelpBodyProps } from "@/lib/help/pages";
import { isIdeaWordsEnabled } from "@/lib/ideas/flags";
import { ideaWord } from "@/lib/nav/terms";

/**
 * /help/plan-and-usage (NEXT_PUBLIC_PLANS_ENABLED): Settings › Plan and usage. No prices: they may change.
 * With ideas in the words (`ideaWords`) launches are ideas, as the page's own labels say.
 */
export default function PlanAndUsageHelp({
  people = isPeopleNameEnabled(),
  addPerson = isAddPersonEnabled(),
  sharing = isConnectorsSharingEnabled(),
  join = isOrganisationJoinEnabled(),
  ideaWords = isIdeaWordsEnabled(),
  onboardingVoice = isOnboardingVoiceEnabled(),
}: HelpBodyProps = {}) {
  const meter = isUsageMeterUiEnabled();
  const w = ideaWord(ideaWords);
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
      <Pairs head={["Plan", "In a sentence"]} rows={PLANS.map((p) => [p.name, planSummary(p, ideaWords)])} />
      <P>
        Every plan includes {w.many} and waitlists, journeys, posts and {people ? "People" : "your Audience"}. Plans differ in the features they add
        and in how much they allow.
      </P>
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
          Whoever runs your copy of YouGrow can put brands together on one plan, or take one back out.
          {join ? (
            <>
              {" "}
              Owners can too, on Settings › Organisation: they bring in a brand they run, or move one out to an organisation of
              its own, as <Open href="/help/organisation-brands">Brands in your organisation</Open> explains.
            </>
          ) : null}{" "}
          {sharing
            ? "Moving a brand never removes anyone from it, or anything it made. Its shared parts from the organisation it leaves stop, and what was collected through them is deleted."
            : "Moving a brand never removes anyone or anything from it."}
        </li>
        <li>
          Owners see every brand on the plan, with its data region, and the totals across them. A brand that is suspended
          still counts, marked <strong>Suspended</strong>.
        </li>
        <li>
          When the plan holds only your brand, everyone in it sees the <strong>Your organisation</strong> box too, because
          its totals are your brand&apos;s own.
        </li>
        <li>
          When it holds other brands, everyone else sees their own brand&apos;s figures, and a line saying the plan is
          shared.
        </li>
        {sharing ? (
          <li>
            Owners can connect Search Console, Google Analytics 4 or Cloudflare once for every brand on the plan, on every plan,
            and give each brand its own part, as <Open href="/help/shared-connections">Shared connections</Open> explains.
          </li>
        ) : null}
      </UL>

      <H2 id="use">What is counted</H2>
      <P>
        <strong>Now</strong> is what you have today:
      </P>
      <Pairs
        head={["Line", "What it counts"]}
        rows={[
          ["Brands", "Every brand on the plan, suspended ones too."],
          ["Users", "Everyone added to any of the plan's brands, counted once however many brands they are in."],
          ["People", `Everyone in each brand's ${people ? "People list" : "Audience"}, added up across the plan's brands.`],
          [allowanceLabels(ideaWords).liveIdeas, `Each brand's ${w.many} that aren't archived. This one is per brand, not shared.`],
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
        {meter ? (
          <>
            <li>
              <strong>Web searches for research</strong>: the Google searches Gemini runs for your brand when it researches,
              with a line for each feature that used them (brand map research, buying situations, blog research and the
              autopilot, finding a competitor&apos;s sitemap). Free and Pro set how many a brand may use in a month; on other
              plans your copy of YouGrow sets it.
            </li>
            <li>
              <strong>AI model use</strong>: the tokens the AI models read and write for your brand, with a line for each
              feature and each model, Vizzy&apos;s chat and Learn from your repo included. It has no limit yet. It shows what
              each feature uses. Writing in a workflow has a line each for posts, workflow emails, hub content, briefs and
              angles. A month counted before those lines were split shows all five as Writing posts.
            </li>
            <li>
              <strong>Images made</strong>: every image the AI makes for your brand, with a line for each feature (blog
              heroes, post images, email images, ebook images, customised images and carousels). Your copy of YouGrow sets how
              many a brand may make in a month.
            </li>
            {onboardingVoice ? (
              <>
                <li>
                  <strong>Voice conversations</strong>: the seconds of each Talk with Vizzy call, from its start to its end,
                  counted once the call ends. It has no limit.
                </li>
                <li>
                  Not counted: the model Google runs for Vizzy&apos;s memory, the voice chat on your waitlist pages, and turning
                  your knowledge into search.
                </li>
              </>
            ) : (
              <li>
                Not counted: the model Google runs for Vizzy&apos;s memory, the voice chat in your browser, and turning your
                knowledge into search.
              </li>
            )}
            <li>Ask Vizzy how much your brand has used this month, and what is left.</li>
          </>
        ) : null}
        <li>
          Emails and AI credits show as <strong>Not counted yet</strong>, with the allowance your plan gives. AI credits are
          given per user on some plans.
        </li>
      </UL>

      <H2 id="limits">At a limit</H2>
      <P>Nobody and nothing is removed, and new sign-ups, {w.many} and teammates still come in for now.</P>
      <UL>
        <li>A monthly allowance that runs out stops that feature for the rest of the month. It starts again on the 1st.</li>
        {meter ? (
          <li>
            When web searches for research run out, research stops searching Google for the rest of the month. Brand map
            research and buying situations say so and file nothing. Blog research carries on from your own sources and says
            Google wasn&apos;t searched. The autopilot finds and sorts the next article for you to write instead of drafting
            it.
          </li>
        ) : null}
        {meter ? (
          <li>
            When images run out, the AI makes no more images for the rest of the month. A blog article keeps its title card,
            post cards are drawn without art, and the other image tools say so.
          </li>
        ) : null}
        <li>A plan that has all the brands it allows takes no more until there is room.</li>
        <li>Over a shared allowance, owners see it in the Your organisation box on Plan and usage.</li>
        {addPerson ? (
          <li>
            When your plan&apos;s people are nearly used up or over, <Open href="/help/your-audience#add">New person</Open> says so, and
            still adds them.
          </li>
        ) : null}
        <li>
          To make room, archive {w.a} you have finished, or ask whoever runs your copy of YouGrow about another plan.
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
              or not in your plan. A feature granted on its own that works only with another says what it needs: the
              article autopilot needs Next up.
            </>,
          ],
        ]}
      />
      <P>
        Some features are turned on brand by brand as well, such as <Open href="/help/search">Search</Open>. One granted to
        your brand works even when your plan leaves it out.
      </P>
      {isEditModeLearningFollowsVizzyEnabled() ? (
        <P>
          On this copy, Vizzy in Edit mode also learns from your edits there when your brand keeps its data in the region where
          Vizzy runs, even when Plan and usage lists Vizzy learning from edits as not in your plan. Learning from LinkedIn and X
          posts still needs Vizzy learning from edits.
        </P>
      ) : null}

      <H2 id="change">Changing your plan</H2>
      <P>
        To change your plan or put brands together on one plan, ask whoever runs your copy of YouGrow. They can also add
        owners. Before anything changes they see what would, including any feature your brands would lose.
      </P>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          [
            "Over your plan. Nobody and nothing is removed, and new ones still come in for now.",
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
          ...(meter
            ? ([
                [
                  WEB_SEARCH_LIMIT_MESSAGE,
                  "Research starts searching Google again on the 1st. Until then, add what you know by hand, or ask whoever runs your copy of YouGrow to raise your brand's web searches.",
                ],
                [
                  IMAGE_LIMIT_MESSAGE,
                  "Images start again on the 1st. Until then, upload your own, or ask whoever runs your copy of YouGrow to raise your brand's images.",
                ],
              ] as Array<[string, string]>)
            : []),
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
