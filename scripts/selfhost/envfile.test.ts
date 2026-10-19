import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { addMissing, baseSwitches, entryMap, formatEntry, parseEntries, renderEnvFile, secretEntry, setEntries, valueEntry } from "./envfile.mjs";
import { KEPT_OFF, switchesForAddon } from "./spec.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const base = readFileSync(join(REPO, "apphosting.yaml"), "utf8");

const sample = renderEnvFile({ project: "my-project", envName: "live" }, [
  { title: "Project", entries: [valueEntry("GOOGLE_CLOUD_PROJECT", "my-project"), secretEntry("API_KEY", "api-key", ["BUILD", "RUNTIME"])] },
  { title: "Switches", entries: [valueEntry("A_ENABLED", "true"), valueEntry("B_ENABLED", "true")] },
]);

describe("env file entries", () => {
  it("read back what they wrote: values, secrets and availability", () => {
    const env = entryMap(sample);
    expect(env.get("GOOGLE_CLOUD_PROJECT")).toMatchObject({ value: "my-project", availability: ["RUNTIME"] });
    expect(env.get("API_KEY")).toMatchObject({ secret: "api-key", availability: ["BUILD", "RUNTIME"] });
    expect(parseEntries(sample).map((e) => e.name)).toEqual(["GOOGLE_CLOUD_PROJECT", "API_KEY", "A_ENABLED", "B_ENABLED"]);
  });

  it("quote values safely", () => {
    const text = `env:\n${formatEntry(valueEntry("EMAIL_FROM", 'Acme "Team" <hi@acme.test> # not a comment'))}\n`;
    expect(entryMap(text).get("EMAIL_FROM")?.value).toBe('Acme "Team" <hi@acme.test> # not a comment');
  });

  it("only add what is missing and report what differs, never changing it", () => {
    const edited = sample.replace('value: "my-project"', 'value: "their-project"');
    const r = addMissing(edited, [valueEntry("GOOGLE_CLOUD_PROJECT", "my-project"), valueEntry("C_ENABLED", "true")], "added");
    expect(r.added).toEqual(["C_ENABLED"]);
    expect(r.differs.map((d) => d.name)).toEqual(["GOOGLE_CLOUD_PROJECT"]);
    expect(entryMap(r.text).get("GOOGLE_CLOUD_PROJECT")?.value).toBe("their-project");
    expect(entryMap(r.text).get("C_ENABLED")?.value).toBe("true");
    expect(addMissing(r.text, [valueEntry("C_ENABLED", "true")]).text).toBe(r.text);
  });

  it("let an add-on replace its own entries in place", () => {
    const r = setEntries(sample, [valueEntry("A_ENABLED", "false"), valueEntry("D_ENABLED", "true")]);
    expect(r.changed).toEqual(["A_ENABLED", "D_ENABLED"]);
    const names = parseEntries(r.text).map((e) => e.name);
    expect(names.indexOf("A_ENABLED")).toBe(2);
    expect(entryMap(r.text).get("A_ENABLED")?.value).toBe("false");
    expect(setEntries(r.text, [valueEntry("A_ENABLED", "false")]).changed).toEqual([]);
  });
});

describe("the switches npm run selfhost leaves off", () => {
  const switches = new Set(baseSwitches(base).map((s) => s.name));

  it("are all switches apphosting.yaml lists (a renamed switch would otherwise turn on)", () => {
    for (const name of Object.keys(KEPT_OFF)) expect(switches.has(name), name).toBe(true);
  });

  it("are turned on only by the add-on named for them", () => {
    for (const addon of ["x", "linkedin", "vizzy", "knowledge", "github-app", "bigquery", "recaptcha"]) {
      for (const name of switchesForAddon(addon)) expect(switches.has(name), `${addon}: ${name}`).toBe(true);
    }
    expect(switchesForAddon("linkedin")).toContain("DISTRIBUTE_CAROUSEL_ENABLED");
    expect(switchesForAddon("x")).not.toContain("DISTRIBUTE_CAROUSEL_ENABLED");
    expect(Object.entries(KEPT_OFF).filter(([, k]) => k.addon === null).map(([n]) => n)).toEqual(
      expect.arrayContaining(["SITE_HOME_ENABLED", "NEXT_PUBLIC_GA_ENABLED"]),
    );
  });
});
