import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CampaignSettings } from "@/lib/admin/campaignSettings";
import { aiTellsIn } from "@/lib/content/writingRules";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const { WidgetBuilder } = await import("./WidgetBuilder");
const { curlExample } = await import("./SiteFormPanel");

function render(siteForm?: { canEdit: boolean }): string {
  return renderToStaticMarkup(
    createElement(WidgetBuilder, {
      origin: "https://yougrow.test",
      embedOrigin: "https://yougrow.test",
      tenantId: "ten_A",
      campaigns: [{ id: "news", waitlistName: "Acme newsletter", settings: { configurationStyleJson: {} } as unknown as CampaignSettings }],
      initialCampaignId: "news",
      siteForm,
    }),
  );
}

describe("Your own form", () => {
  it("is a choice on Page & widget only when the launch page offers it", () => {
    expect(render({ canEdit: true })).toContain(">Your own form<");
    expect(render()).not.toContain("Your own form");
  });

  it("shows the call with the address, the key's placeholders and a made-up person", () => {
    const example = curlExample("https://yougrow.test/api/v2/signups");
    expect(example).toContain("curl https://yougrow.test/api/v2/signups");
    expect(example).toContain('-u "$YOUGROW_KEY_ID:$YOUGROW_SECRET"');
    expect(example).toContain("sam@example.com");
    expect(aiTellsIn(example)).toEqual([]);
  });
});
