import { describe, it, expect } from "vitest";
import { launchInView, vizzyPageLabel, vizzySuggestions } from "./vizzy";

describe("vizzyPageLabel", () => {
  it("joins the breadcrumb", () => {
    expect(vizzyPageLabel([{ label: "Launches" }, { label: "Fernlight Beta" }, { label: "Signups" }])).toBe(
      "Launches › Fernlight Beta › Signups",
    );
  });

  it("drops characters the context envelope can't carry, and caps the length", () => {
    expect(vizzyPageLabel([{ label: 'Launch {x}] "quoted" \\ok' }])).toBe("Launch x quoted ok");
    expect(vizzyPageLabel([{ label: "a".repeat(300) }])).toHaveLength(160);
  });
});

describe("launchInView", () => {
  it("reads the launch id from launch pages only", () => {
    expect(launchInView("/admin/launches/beta-launch/signups")).toBe("beta-launch");
    expect(launchInView("/admin/launches/new")).toBeNull();
    expect(launchInView("/admin/launches")).toBeNull();
    expect(launchInView("/admin/crm")).toBeNull();
  });
});

describe("vizzySuggestions", () => {
  it("has starters for every area, defaulting to Home's", () => {
    expect(vizzySuggestions("launches")[0]).toBe("Draft a broadcast for this launch");
    expect(vizzySuggestions(null)).toEqual(vizzySuggestions("home"));
  });
});
