import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, rm, mkdtemp } from "node:fs/promises";
import { buildPlan, toBlocklist } from "../src/remediate/plan.js";
import { renderOverrides } from "../src/remediate/artifacts.js";
import { verifyLockfile } from "../src/remediate/verify.js";
import type { BlastRadiusResult } from "../src/analysis/blast-radius.js";

const BLAST: BlastRadiusResult = {
  found: true,
  downstream: [{ name: "express" }, { name: "connect" }],
  lateralMovement: [
    { maintainer: "dougwilson", atRiskPackages: ["etag", "fresh", "express"] },
    { maintainer: "wesleytodd", atRiskPackages: ["etag", "router"] },
  ],
  totalAffected: 5,
};

describe("buildPlan", () => {
  it("puts the compromised package first", () => {
    const plan = buildPlan("body-parser", BLAST);
    expect(plan.entries[0]).toEqual({
      name: "body-parser",
      reason: "compromised",
    });
  });

  it("classifies downstream before shared-maintainer", () => {
    const plan = buildPlan("body-parser", BLAST);
    const reasons = plan.entries.map((e) => e.reason);
    const lastDownstream = reasons.lastIndexOf("downstream");
    const firstShared = reasons.indexOf("shared-maintainer");
    expect(lastDownstream).toBeLessThan(firstShared);
  });

  it("does not double-count a package that is both downstream and shared", () => {
    // express appears in downstream AND in dougwilson's portfolio.
    const plan = buildPlan("body-parser", BLAST);
    const express = plan.entries.filter((e) => e.name === "express");
    expect(express).toHaveLength(1);
    // Downstream is the stronger claim, so it must win.
    expect(express[0].reason).toBe("downstream");
  });

  it("collapses every maintainer that reaches a package", () => {
    const plan = buildPlan("body-parser", BLAST);
    const etag = plan.entries.find((e) => e.name === "etag");
    expect(etag?.reason).toBe("shared-maintainer");
    expect(etag?.via).toEqual(["dougwilson", "wesleytodd"]);
  });

  it("is deterministic: identical inputs give identical entries", () => {
    const a = buildPlan("body-parser", BLAST);
    const b = buildPlan("body-parser", BLAST);
    expect(a.entries).toEqual(b.entries);
  });
});

describe("toBlocklist", () => {
  it("hard-blocks only the compromised package", () => {
    const bl = toBlocklist(buildPlan("body-parser", BLAST, ["1.20.3"]));
    expect(Object.keys(bl.blocked)).toEqual(["body-parser"]);
    expect(bl.blocked["body-parser"]).toEqual(["1.20.3"]);
  });

  it("routes suspicion to review rather than blocking builds on it", () => {
    const bl = toBlocklist(buildPlan("body-parser", BLAST));
    expect(bl.review["etag"].reason).toBe("shared-maintainer");
    expect(bl.blocked["etag"]).toBeUndefined();
  });
});

describe("renderOverrides", () => {
  it("refuses to invent a pin when no safe version is known", () => {
    const r = renderOverrides(buildPlan("body-parser", BLAST));
    expect(r.applicable).toBe(false);
    expect(r.content).toBe("");
    expect(r.note).toMatch(/will not guess/i);
  });

  it("emits valid JSON overrides when given a safe version", () => {
    const r = renderOverrides(buildPlan("body-parser", BLAST), "1.20.4");
    expect(r.applicable).toBe(true);
    expect(JSON.parse(r.content)).toEqual({
      overrides: { "body-parser": "1.20.4" },
    });
  });
});

describe("verifyLockfile", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    dirs.length = 0;
  });

  async function setup(
    blocked: Record<string, string[]>,
    lock: unknown,
  ): Promise<{ bl: string; lf: string }> {
    const dir = await mkdtemp(join(tmpdir(), "hd-verify-"));
    dirs.push(dir);
    const bl = join(dir, "blocklist.json");
    const lf = join(dir, "package-lock.json");
    await writeFile(
      bl,
      JSON.stringify({
        $schema: "hyperdefense/blocklist@1",
        generatedAt: "2026-08-17T00:00:00.000Z",
        compromised: "body-parser",
        blocked,
        review: { etag: { reason: "shared-maintainer", via: ["dougwilson"] } },
      }),
    );
    await writeFile(lf, JSON.stringify(lock));
    return { bl, lf };
  }

  it("fails when a blocked version resolved", async () => {
    const { bl, lf } = await setup(
      { "body-parser": ["1.20.3"] },
      {
        lockfileVersion: 3,
        packages: {
          "node_modules/body-parser": { version: "1.20.3" },
        },
      },
    );
    const r = await verifyLockfile(bl, lf);
    expect(r.ok).toBe(false);
    expect(r.violations[0]).toMatchObject({
      package: "body-parser",
      version: "1.20.3",
    });
  });

  it("passes when the resolved version is not the blocked one", async () => {
    const { bl, lf } = await setup(
      { "body-parser": ["1.20.3"] },
      {
        lockfileVersion: 3,
        packages: { "node_modules/body-parser": { version: "1.20.4" } },
      },
    );
    const r = await verifyLockfile(bl, lf);
    expect(r.ok).toBe(true);
  });

  it("treats an empty version array as blocking every version", async () => {
    const { bl, lf } = await setup(
      { "body-parser": [] },
      {
        lockfileVersion: 3,
        packages: { "node_modules/body-parser": { version: "9.9.9" } },
      },
    );
    const r = await verifyLockfile(bl, lf);
    expect(r.ok).toBe(false);
  });

  it("catches a nested transitive resolution, not just the top level", async () => {
    const { bl, lf } = await setup(
      { "body-parser": ["1.20.3"] },
      {
        lockfileVersion: 3,
        packages: {
          "node_modules/express": { version: "4.18.0" },
          "node_modules/express/node_modules/body-parser": {
            version: "1.20.3",
          },
        },
      },
    );
    const r = await verifyLockfile(bl, lf);
    expect(r.ok).toBe(false);
    expect(r.violations[0].path).toContain("express/node_modules/body-parser");
  });

  it("handles scoped package names", async () => {
    const { bl, lf } = await setup(
      { "@tanstack/router-core": ["1.0.1"] },
      {
        lockfileVersion: 3,
        packages: {
          "node_modules/@tanstack/router-core": { version: "1.0.1" },
        },
      },
    );
    const r = await verifyLockfile(bl, lf);
    expect(r.ok).toBe(false);
    expect(r.violations[0].package).toBe("@tanstack/router-core");
  });

  it("supports lockfile v1 shape", async () => {
    const { bl, lf } = await setup(
      { "body-parser": ["1.20.3"] },
      {
        lockfileVersion: 1,
        dependencies: { "body-parser": { version: "1.20.3" } },
      },
    );
    const r = await verifyLockfile(bl, lf);
    expect(r.ok).toBe(false);
  });

  it("reports review hits without failing the gate", async () => {
    const { bl, lf } = await setup(
      { "body-parser": ["1.20.3"] },
      {
        lockfileVersion: 3,
        packages: { "node_modules/etag": { version: "1.8.1" } },
      },
    );
    const r = await verifyLockfile(bl, lf);
    expect(r.ok).toBe(true);
    expect(r.reviewHits[0]).toMatchObject({ package: "etag", version: "1.8.1" });
  });
});
