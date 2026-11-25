import { H1, H2, Lead, P, UL } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps } from "@/components/help/blocks";
import { BRANDS_COPY } from "@/components/admin/connectors/words";
import { isConnectorsSharingEnabled } from "@/lib/connectors/flags";
import type { HelpBodyProps } from "@/lib/help/pages";

/**
 * /help/organisation-brands (ORGANISATION_JOIN_ENABLED, Connectors 3 group 4): Settings ›
 * Organisation › Brands, where an owner brings in a brand they run or moves one out. Settings ›
 * Organisation's How to opens it while sharing is off. The lines about shared parts show while
 * sharing is on (CONNECTORS_SHARING_ENABLED), and the words it quotes are the app's own.
 */
export default function OrganisationBrandsHelp({ sharing = isConnectorsSharingEnabled() }: HelpBodyProps = {}) {
  return (
    <article>
      <H1>Brands in your organisation</H1>
      <Lead>
        Put the brands you run together in one organisation, on one plan, or move one out to an organisation of its own. Owners
        do both on Settings › Organisation, and each move asks the owners on both sides.
      </Lead>
      <Meta items={["About 3 minutes", "Owners of your organisation", "When you run more than one brand"]} />

      <BeforeAndUnlocks
        before={
          <>
            <li>You an owner of your organisation, and an admin of the brand you are in</li>
            <li>For each brand you move, you an owner of the organisation it is in now and an admin on its team</li>
            <li>Moving brands turned on in your copy of YouGrow</li>
          </>
        }
        unlocks={
          <>
            <li>Your brands on one plan, with their totals together on <Open href="/admin/account/billing">Plan and usage</Open></li>
            {sharing ? <li>One shared connection for all of them, each brand given its own site, property or zone</li> : null}
          </>
        }
      />

      <H2 id="list">The brands in your organisation</H2>
      <P>
        Open <Open href="/admin/account/organisation">Settings › Organisation</Open>. <strong>Brands</strong> lists every brand
        in it, in every region, with the region it keeps its data in and how many parts it is given from the
        organisation&apos;s shared connections. The brand you are in is marked <strong>This brand</strong>.
      </P>

      <H2 id="bring-in">Bring in a brand you run</H2>
      <Steps>
        <li>
          Press <strong>Bring in a brand you run</strong>.
        </li>
        <li>Pick the brand. Each one shows the organisation it is in now and its plan.</li>
        <li>Read what happens, then press Bring in.</li>
      </Steps>
      <UL>
        <li>
          The list holds only brands in another organisation you own, where you are an admin on the brand&apos;s team. The brand
          you first signed in with counts only once you are on its team: whoever runs your copy of YouGrow can add you.
        </li>
        <li>
          The brand takes your organisation&apos;s plan, and nothing it uses today is turned off. A brand whose plan would lose a
          feature or a monthly limit, such as Enterprise to Ultra, can&apos;t come in until its plan changes.
        </li>
        <li>It counts toward your plan&apos;s brands. When your organisation has as many as its plan allows, the plan changes first.</li>
        {sharing ? (
          <li>
            Its parts from the organisation it leaves stop at once, and what was collected through them is deleted. When that
            leaves the other organisation with no brands, its shared connections are disconnected.
          </li>
        ) : null}
      </UL>

      <H2 id="move-out">Move a brand out</H2>
      <Steps>
        <li>
          Press <strong>Move out</strong> on the brand&apos;s row.
        </li>
        <li>Read what happens, then press Move out again.</li>
      </Steps>
      <UL>
        <li>The brand gets an organisation of its own on the same plan, with you as its only owner.</li>
        <li>
          You need to be an admin on the brand&apos;s team. For the brand you first signed in with, whoever runs your copy of
          YouGrow can add you to its team, or move it for you.
        </li>
        <li>A brand alone in its organisation has no Move out: it has one of its own already.</li>
        {sharing ? (
          <li>
            Its parts from your organisation stop at once, and what was collected through them is deleted. Your shared
            connections stay where they are kept and keep serving the brands left, even those connected from the brand that
            moved.
          </li>
        ) : null}
      </UL>
      <P>Moving a brand never removes anyone from its team, or anything it made.</P>

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>Brands on Settings › Organisation lists the brand you brought in, or no longer lists the one you moved out.</li>
        <li>The brand&apos;s own Plan and usage shows its new plan.</li>
      </Checks>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          [BRANDS_COPY.none, "Ask whoever runs your copy of YouGrow to add you as an owner of the other organisation, and an admin of the brand to add you to its team."],
          [BRANDS_COPY.notOwnerThere, "Only owners on both sides can move a brand. Ask an owner of its organisation to move it, or to make you one."],
          [BRANDS_COPY.alone, "Nothing to move: the brand has an organisation of its own already."],
          [BRANDS_COPY.changed, "Someone moved the brand meanwhile. Reload the page and look again."],
          [BRANDS_COPY.busy, "Nothing changed. Try again in a minute."],
        ]}
      />

      <NextPage slug="organisation-brands" />
    </article>
  );
}
