import { describe, expect, it } from "vitest";
import { diffResolved, formatDiff, formatResolved, mergeApphosting, toJson } from "./apphosting-merge.mjs";

const base = {
  runConfig: { minInstances: 0, maxInstances: 10, cpu: 1 },
  env: [
    { variable: "PROJECT", value: "acme-dev", availability: ["RUNTIME"] },
    { variable: "API_KEY", secret: "api-key", availability: ["RUNTIME", "BUILD"] },
    { variable: "FEATURE_ENABLED", value: "false" },
    { variable: "ONLY_IN_BASE", value: "kept", availability: ["RUNTIME"] },
  ],
};

const overlay = {
  runConfig: { minInstances: 1, maxInstances: 50 },
  env: [
    // Replaces the whole base entry: a different value and availability.
    { variable: "PROJECT", value: "acme-prod", availability: ["BUILD", "RUNTIME"] },
    // A value in the base becomes a secret here.
    { variable: "FEATURE_ENABLED", secret: "feature-flag" },
    { variable: "ONLY_IN_OVERLAY", value: "added", availability: ["RUNTIME"] },
  ],
};

describe("mergeApphosting", () => {
  it("is the base alone when there is no overlay (our dev backend)", () => {
    const r = mergeApphosting(base, null);
    expect([...r.env.keys()]).toEqual(["API_KEY", "FEATURE_ENABLED", "ONLY_IN_BASE", "PROJECT"]);
    expect(r.env.get("PROJECT")).toMatchObject({ value: "acme-dev", source: "base" });
    expect(r.runConfig).toEqual({ cpu: 1, maxInstances: 10, minInstances: 0 });
  });

  it("merges the overlay by variable name, replacing whole entries, and runConfig key by key", () => {
    const r = mergeApphosting(base, overlay);
    expect(r.env.get("PROJECT")).toEqual({ value: "acme-prod", availability: ["BUILD", "RUNTIME"], source: "overlay" });
    expect(r.env.get("FEATURE_ENABLED")).toEqual({ secret: "feature-flag", availability: ["BUILD", "RUNTIME"], source: "overlay" });
    expect(r.env.get("ONLY_IN_BASE")).toMatchObject({ value: "kept", source: "base" });
    expect(r.env.get("ONLY_IN_OVERLAY")).toMatchObject({ value: "added", source: "overlay" });
    expect(r.runConfig).toEqual({ cpu: 1, maxInstances: 50, minInstances: 1 });
    expect(r.warnings).toEqual([]);
  });

  it("fills in the default availability and sorts it", () => {
    const r = mergeApphosting(base, null);
    expect(r.env.get("FEATURE_ENABLED")?.availability).toEqual(["BUILD", "RUNTIME"]);
    expect(r.env.get("API_KEY")?.availability).toEqual(["BUILD", "RUNTIME"]);
  });

  it("warns about duplicates and entries with both or neither of value and secret", () => {
    const r = mergeApphosting({
      env: [
        { variable: "A", value: "1" },
        { variable: "A", value: "2" },
        { variable: "B", value: "x", secret: "y" },
        { variable: "C" },
      ],
    });
    expect(r.env.get("A")).toMatchObject({ value: "2" });
    expect(r.warnings).toEqual([
      "base defines A more than once; the last one is used",
      "B has both a value and a secret",
      "C has neither a value nor a secret",
    ]);
  });

  it("refuses an entry without a variable name", () => {
    expect(() => mergeApphosting({ env: [{ value: "x" }] })).toThrow(/needs a "variable" name/);
  });
});

describe("formatResolved / toJson", () => {
  it("prints one stable, sorted line per setting, with value types kept", () => {
    expect(formatResolved(mergeApphosting(base, overlay))).toBe(
      [
        "runConfig.cpu=1",
        "runConfig.maxInstances=50",
        "runConfig.minInstances=1",
        'API_KEY secret="api-key" availability=BUILD,RUNTIME',
        'FEATURE_ENABLED secret="feature-flag" availability=BUILD,RUNTIME',
        'ONLY_IN_BASE value="kept" availability=RUNTIME',
        'ONLY_IN_OVERLAY value="added" availability=RUNTIME',
        'PROJECT value="acme-prod" availability=BUILD,RUNTIME',
      ].join("\n"),
    );
    expect(formatResolved(mergeApphosting({ env: [{ variable: "N", value: 80 }] }))).toBe("N value=80 availability=BUILD,RUNTIME");
  });

  it("gives JSON with the file each setting came from", () => {
    const json = toJson(mergeApphosting(base, overlay));
    expect(json.env.PROJECT).toEqual({ value: "acme-prod", availability: ["BUILD", "RUNTIME"], source: "overlay" });
    expect(Object.keys(json.env)).toEqual(["API_KEY", "FEATURE_ENABLED", "ONLY_IN_BASE", "ONLY_IN_OVERLAY", "PROJECT"]);
  });
});

describe("diffResolved", () => {
  it("reports additions, removals and changes, but not a move between files", () => {
    const before = mergeApphosting(base, overlay);
    const after = mergeApphosting(
      {
        ...base,
        env: [
          ...base.env.filter((e) => e.variable !== "ONLY_IN_BASE"),
          // Moved from the overlay into the base, same value: not a change.
          { variable: "ONLY_IN_OVERLAY", value: "added", availability: ["RUNTIME"] },
          { variable: "NEW_ONE", value: "x", availability: ["RUNTIME"] },
        ],
      },
      { ...overlay, runConfig: { ...overlay.runConfig, maxInstances: 60 }, env: overlay.env.filter((e) => e.variable !== "ONLY_IN_OVERLAY") },
    );
    const changes = diffResolved(before, after);
    expect(changes.map((c) => [c.kind, c.key])).toEqual([
      ["changed", "runConfig.maxInstances"],
      ["added", "NEW_ONE"],
      ["removed", "ONLY_IN_BASE"],
    ]);
    expect(formatDiff(changes)).toBe(
      [
        "~ runConfig.maxInstances",
        "    was: runConfig.maxInstances=50",
        "    now: runConfig.maxInstances=60",
        '+ NEW_ONE value="x" availability=RUNTIME',
        '- ONLY_IN_BASE value="kept" availability=RUNTIME',
      ].join("\n"),
    );
    expect(diffResolved(before, mergeApphosting(base, overlay))).toEqual([]);
  });

  it("sees a value turning into a secret", () => {
    const changes = diffResolved(mergeApphosting(base, null), mergeApphosting(base, { env: [overlay.env[1]!] }));
    expect(changes).toEqual([
      {
        kind: "changed",
        key: "FEATURE_ENABLED",
        before: 'FEATURE_ENABLED value="false" availability=BUILD,RUNTIME',
        after: 'FEATURE_ENABLED secret="feature-flag" availability=BUILD,RUNTIME',
      },
    ]);
  });
});
