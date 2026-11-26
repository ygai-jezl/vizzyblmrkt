import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CompetitorGroupPicker } from "./CompetitorGroupPicker";

const render = (props: Partial<Parameters<typeof CompetitorGroupPicker>[0]> = {}) =>
  renderToStaticMarkup(createElement(CompetitorGroupPicker, { id: "cmp_aaaaaaaa01", name: "Rivalco", group: null, canEdit: true, onSaved: () => undefined, onError: () => undefined, ...props }));

describe("the group picker", () => {
  it("shows the record's group, and an older draft's only as a hint with nothing chosen", () => {
    const hinted = render({ was: "most" });
    // Nothing chosen: the empty "Choose a group" is selected, so picking "Does most of what you do" saves it.
    expect(hinted).toMatch(/<option value="" disabled="" selected="">Choose a group<\/option>/);
    expect(hinted).not.toMatch(/<option value="most" selected=""/);
    expect(hinted).toContain("Was: Does most of what you do");
    const set = render({ group: "big", was: "most" });
    expect(set).toMatch(/<option value="big" selected="">The big names<\/option>/);
    expect(set).not.toContain("Choose a group");
    expect(set).not.toContain("Was:");
  });

  it("reads as words to a member, the hint too", () => {
    expect(render({ canEdit: false, was: "instead" })).toBe(
      '<span class="inline-flex items-center gap-1.5"><span class="text-[11px] text-neutral-500">Not grouped yet</span><span class="text-[11px] text-neutral-500">Was: What buyers do instead</span></span>',
    );
    expect(render({ canEdit: false, group: "open_source" })).not.toContain("<select");
  });
});
