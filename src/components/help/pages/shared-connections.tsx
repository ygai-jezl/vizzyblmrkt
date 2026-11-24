import { H1, H2, Lead, P, Pairs, UL } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps } from "@/components/help/blocks";
import { CONNECTOR_ERRORS, SIGNIN_REASONS } from "@/lib/connectors/messages";

/**
 * /help/shared-connections (CONNECTORS_SHARING_ENABLED, Connectors 3): an organisation connects
 * Search Console, Google Analytics 4 or Cloudflare once, and its owners give each brand one part.
 * Settings › Organisation's How to opens it. No switch inside: the page is served only while
 * sharing is on, and the words it quotes are the app's own.
 */
export default function SharedConnectionsHelp() {
  return (
    <article>
      <H1>Shared connections</H1>
      <Lead>
        Connect Search Console, Google Analytics 4 or Cloudflare once for your organisation, then give each brand its own site,
        property or zone. Each brand&apos;s team sees only its own, and each brand&apos;s numbers stay in that brand&apos;s own
        region.
      </Lead>
      <Meta items={["About 4 minutes", "Owners of your organisation", "Once your brands share an organisation"]} />

      <BeforeAndUnlocks
        before={
          <>
            <li>
              Two or more brands in one organisation, and you one of its owners (<Open href="/help/plan-and-usage#brands">Plan and usage</Open>{" "}
              says who runs that)
            </li>
            <li>You an admin of the brand you are in, and of each brand you give a part to</li>
            <li>Sharing turned on in your copy of YouGrow</li>
          </>
        }
        unlocks={
          <>
            <li>One sign in, one Google address or one token for all your brands, instead of one per brand</li>
            <li>Each brand reads, collects and plans from its own part, as if it had connected it itself</li>
          </>
        }
      />

      <H2 id="connect">Connect once for the organisation</H2>
      <Steps>
        <li>
          Open <Open href="/admin/account/connections/browse">Settings › Connections › Browse</Open> and press the tool you use.
        </li>
        <li>
          Under <strong>Connect for</strong>, choose your organisation (<strong>all its brands</strong>). The page says where it
          is kept: in the region of the brand you are in. Each brand&apos;s numbers stay in its own region.
        </li>
        <li>
          Sign in with Google, make a Google address for your organisation and add it to each site or property, or paste a
          Cloudflare token that reaches every zone your brands use.
        </li>
        <li>
          YouGrow takes you to <Open href="/admin/account/organisation">Settings › Organisation</Open>. Nothing is read or
          collected until you give a brand its part.
        </li>
      </Steps>
      <P>
        Before Google&apos;s screen, a Google sign in says who will see what: you can give each brand one site this Google
        account can see; only you see the list; each brand&apos;s team sees only its own site, and the other owners see which
        brand has which.
      </P>

      <H2 id="give">Give a brand its part</H2>
      <Steps>
        <li>
          On <Open href="/admin/account/organisation">Settings › Organisation</Open>, press <strong>Give a brand a site</strong>{" "}
          (or a property, or a zone) on the connection.
        </li>
        <li>Choose the brand, then the site, property or zone it reads.</li>
        <li>Tick who can read it besides its admins: its members, and Vizzy when someone asks.</li>
        <li>Press Give. The brand&apos;s first 90 days fill within about a day.</li>
      </Steps>
      <UL>
        <li>A brand gets one part from each connection, and a part goes to one brand only.</li>
        <li>You can give a part only to a brand you are an admin of. Other brands show greyed.</li>
        <li>
          For a Google sign in, only the owner who signed in sees its list and gives its parts. A Google address or a token is
          the organisation&apos;s own, so any owner can.
        </li>
        <li>
          The list warns when a site sits inside a domain property another brand has (both would see those pages), when a part
          isn&apos;t on the brand&apos;s own website, and when another brand already reads it with its own connection.
        </li>
        <li>A brand that already has its own connection to that part can&apos;t be given it until that one is disconnected.</li>
      </UL>

      <H2 id="regions">Where everything is kept</H2>
      <P>
        A shared connection is kept in the region of the brand it was connected from, and stays there even if that brand later
        leaves. It can give parts to your brands in any region. Each brand&apos;s own record, its numbers, suggestions and search
        entries stay in that brand&apos;s region. Only the sign in is read across regions, into the server&apos;s memory, when a
        brand in another region reads or collects.
      </P>

      <H2 id="change">Change or take back a part</H2>
      <Pairs
        head={["Action", "What happens"]}
        rows={[
          ["Change", "The brand stops reading the old part at once. Its numbers from the old part are deleted, and 90 days fill again from the new one within a day."],
          [
            "Take back",
            "The brand stops reading it now, and what YouGrow collected for it is deleted, with its suggestions. A Google address can still read the site until you remove it there.",
          ],
        ]}
      />
      <P>
        Any owner can take a part back. A brand&apos;s own admins can stop using theirs too; the connection&apos;s card then says
        when they stopped. Every part given, changed or ended is kept in that brand&apos;s settings history.
      </P>

      <H2 id="sign-in-again">Sign in again</H2>
      <P>
        Any owner can sign in again to a shared Google sign in, for example when Google ended it or when the owner who signed in
        has left. Before Google&apos;s screen it lists every brand it serves. Afterwards you are its signer, each part is checked
        with your Google account, and a part your account can&apos;t read is marked on that brand only.
      </P>

      <H2 id="pause">Pause or disconnect</H2>
      <UL>
        <li>Pause stops every brand reading it live and collecting it. Numbers already collected stay readable.</li>
        <li>
          Disconnect ends every brand&apos;s part and deletes what YouGrow collected for them. A Google address is deleted. A Google
          sign in is also removed at Google only when your copy of YouGrow does that, and then the same Google account&apos;s other
          YouGrow connections need signing in again.
        </li>
      </UL>

      <H2 id="limits">Limits</H2>
      <UL>
        <li>Up to 50 brands can have a part of one connection.</li>
        <li>Up to 5 Google addresses per organisation for each tool.</li>
        <li>
          Search Console and Cloudflare count their limits per sign in or token, so when one says its limit was reached, collecting
          pauses for every brand on it for a while. Live reads go on. Google Analytics counts per property, so only that brand
          waits.
        </li>
      </UL>

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>The connection&apos;s card on Settings › Organisation lists the brand under Given to.</li>
        <li>The brand&apos;s own Connected view lists the connection, and its Collected column fills within a day.</li>
        <li>Another brand&apos;s screens, search and Vizzy never show this brand&apos;s part.</li>
      </Checks>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          [SIGNIN_REASONS.not_owner, "Ask an owner of your organisation to connect it, or connect it for this brand instead."],
          [SIGNIN_REASONS.sharing_off, "Ask whoever runs your YouGrow to turn sharing on, or connect it for each brand."],
          [CONNECTOR_ERRORS.org_share_limit, "Disconnect an address your organisation no longer uses on Settings › Organisation."],
          ["This token can't list its zones, so YouGrow can't give a brand one. Give it Zone Read, or connect it for this brand instead.", "Make a token with Zone Read and paste it again."],
          [
            "Only the owner who signed in can see its list and give its parts. You can take one back, pause, disconnect, or sign in again yourself.",
            "Ask the owner who signed in, or sign in again yourself so you become its signer.",
          ],
          ["That one is given to a brand already. Take it back there first.", "Each part goes to one brand. Take it back from the other brand first."],
          ["That isn't one this connection can read now. Pick one from the list.", "Its access may have changed at Google or Cloudflare. Open the list again and pick one it can read."],
          [SHARED_LAST_GONE, "No brand reads it any more. Disconnect it, or give a brand a part."],
        ]}
      />

      <NextPage slug="shared-connections" />
    </article>
  );
}

const SHARED_LAST_GONE = "No brand uses this any more. Disconnect it?";
