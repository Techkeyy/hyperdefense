import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, rm, mkdtemp } from "node:fs/promises";
import { downstreamBlastRadiusQuery } from "../src/db/queries.js";
import { safeInt, MAX_TRAVERSAL_HOPS } from "../src/util/num.js";
import { IdRegistry } from "../src/db/id-registry.js";
import { verifyLockfile } from "../src/remediate/verify.js";
import { loadSnapshot, RawGraph, replaySnapshot } from "../src/ingest/snapshot.js";
import { buildPlan, toBlocklist } from "../src/remediate/plan.js";
import { renderPrComment } from "../src/report/pr-comment.js";
import { decodePropertyValue } from "../src/db/http-client.js";
import type { BlastRadiusResult } from "../src/analysis/blast-radius.js";

/**
 * Adversarial tests. These target the paths that are hardest to reach by
 * running the happy path: hostile input, malformed files, boundary values, and
 * graph shapes that npm genuinely produces but a curated fixture does not.
 */

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "hd-adv-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs.length = 0;
});

describe("query interpolation cannot be broken by input", () => {
  it("never asks for more hops than the server allows", () => {
    // HydraDB rejects maxLen above max_traversal_hops (default 16). Clamping to
    // a number that merely looks safe produced a rejected query that surfaced
    // as "algo.MSpaths unavailable", blaming the feature for the bound.
    expect(MAX_TRAVERSAL_HOPS).toBe(16);
    for (const d of [17, 20, 100, 9999]) {
      const bound = Number(
        downstreamBlastRadiusQuery(1, d).match(/\*1\.\.(\d+)\]/)?.[1],
      );
      expect(bound).toBeLessThanOrEqual(MAX_TRAVERSAL_HOPS);
    }
    expect(safeInt(9999, 5, 1, MAX_TRAVERSAL_HOPS)).toBe(16);
  });

  it("clamps the traversal depth into a safe integer range", () => {
    // Depth is interpolated as a literal, so a hostile or silly value must not
    // reach the query text.
    expect(downstreamBlastRadiusQuery(1, 999)).toContain("*1..16");
    expect(downstreamBlastRadiusQuery(1, 0)).toContain("*1..1");
    expect(downstreamBlastRadiusQuery(1, -5)).toContain("*1..1");
    expect(downstreamBlastRadiusQuery(1, 3.9)).toContain("*1..3");
  });

  it("never emits a negative or fractional node id", () => {
    expect(downstreamBlastRadiusQuery(-42, 3)).toContain("{id: 0}");
    expect(downstreamBlastRadiusQuery(7.9, 3)).toContain("{id: 7}");
  });

  it("emits no NaN or Infinity into the query", () => {
    const q1 = downstreamBlastRadiusQuery(Number.NaN, Number.NaN);
    const q2 = downstreamBlastRadiusQuery(Infinity, Infinity);
    for (const q of [q1, q2]) {
      expect(q).not.toContain("NaN");
      expect(q).not.toContain("Infinity");
    }
  });
});

describe("id registry survives hostile and damaged state", () => {
  it("starts fresh rather than throwing on a corrupt map file", async () => {
    const dir = await tmp();
    const path = join(dir, "id-map.json");
    await writeFile(path, "{ this is not json");
    const r = new IdRegistry(path);
    await r.load();
    expect(r.id("package", "express")).toBe(1);
  });

  it("starts fresh on a structurally valid but wrong-shaped file", async () => {
    const dir = await tmp();
    const path = join(dir, "id-map.json");
    await writeFile(path, JSON.stringify({ unexpected: true }));
    const r = new IdRegistry(path);
    await r.load();
    // Must still assign a usable id rather than NaN or undefined.
    const id = r.id("package", "express");
    expect(Number.isInteger(id)).toBe(true);
    expect(id).toBeGreaterThanOrEqual(0);
  });

  it("keeps ids distinct for names that differ only by case or whitespace", async () => {
    const dir = await tmp();
    const r = new IdRegistry(join(dir, "m.json"));
    await r.load();
    const ids = new Set([
      r.id("package", "Express"),
      r.id("package", "express"),
      r.id("package", "express "),
      r.id("package", " express"),
    ]);
    expect(ids.size).toBe(4);
  });

  it("handles names containing the kind separator without colliding", async () => {
    const dir = await tmp();
    const r = new IdRegistry(join(dir, "m.json"));
    await r.load();
    // A naive `kind + name` key would let a crafted name impersonate another
    // kind. These must not collide.
    const a = r.id("package", "x");
    const b = r.id("maintainer", "x");
    expect(a).not.toBe(b);
  });
});

describe("lockfile verification against malformed input", () => {
  async function setup(lock: string): Promise<{ bl: string; lf: string }> {
    const dir = await tmp();
    const bl = join(dir, "b.json");
    const lf = join(dir, "l.json");
    await writeFile(
      bl,
      JSON.stringify({
        $schema: "hyperdefense/blocklist@1",
        generatedAt: "2026-08-17T00:00:00.000Z",
        compromised: "x",
        blocked: { x: ["1.0.0"] },
        review: {},
      }),
    );
    await writeFile(lf, lock);
    return { bl, lf };
  }

  it("throws a real error on a corrupt lockfile rather than passing silently", async () => {
    const { bl, lf } = await setup("{ not json");
    // Critical: a gate that cannot parse must NOT report ok.
    await expect(verifyLockfile(bl, lf)).rejects.toThrow();
  });

  it("treats an empty lockfile as zero packages, not as a pass with data", async () => {
    const { bl, lf } = await setup("{}");
    const r = await verifyLockfile(bl, lf);
    expect(r.packagesScanned).toBe(0);
    expect(r.ok).toBe(true);
  });

  it("ignores entries with no version instead of crashing", async () => {
    const { bl, lf } = await setup(
      JSON.stringify({
        packages: {
          "node_modules/x": {},
          "node_modules/y": { version: "1.0.0" },
        },
      }),
    );
    const r = await verifyLockfile(bl, lf);
    expect(r.packagesScanned).toBe(1);
  });

  it("does not mistake a path fragment for a package name", async () => {
    const { bl, lf } = await setup(
      JSON.stringify({
        packages: {
          // A directory that merely contains the substring must not match.
          "packages/my-node_modules-helper": { version: "1.0.0" },
          "": { version: "9.9.9" },
        },
      }),
    );
    const r = await verifyLockfile(bl, lf);
    expect(r.violations).toHaveLength(0);
  });

  it("rejects a missing blocklist loudly", async () => {
    const dir = await tmp();
    await expect(
      verifyLockfile(join(dir, "nope.json"), join(dir, "also-nope.json")),
    ).rejects.toThrow();
  });
});

describe("graph shapes npm actually produces", () => {
  it("handles a dependency cycle without duplicating or hanging", () => {
    // Cycles are real: packages do depend on each other circularly via dev or
    // peer edges, and a fixture replay must not loop.
    const raw = new RawGraph();
    raw.addPackage("a");
    raw.addPackage("b");
    raw.addDependency("a", "b");
    raw.addDependency("b", "a");
    const snap = raw.toSnapshot({
      name: "cycle",
      capturedAt: "2026-08-17T00:00:00.000Z",
      roots: ["a"],
      provenance: "test",
    });

    const seen: Array<[string, string]> = [];
    replaySnapshot(snap, {
      addPackage: () => 0,
      addMaintainer: () => 0,
      addVersion: () => 0,
      addDependency: (f, t) => seen.push([f, t]),
      addPublishes: () => {},
      addHasVersion: () => {},
    });
    expect(seen).toHaveLength(2);
  });

  it("handles a package that depends on itself", () => {
    const raw = new RawGraph();
    raw.addPackage("self");
    raw.addDependency("self", "self");
    const snap = raw.toSnapshot({
      name: "self",
      capturedAt: "2026-08-17T00:00:00.000Z",
      roots: ["self"],
      provenance: "test",
    });
    expect(snap.dependencies).toEqual([["self", "self"]]);
  });

  it("keeps scoped and unscoped packages of the same base name distinct", () => {
    const raw = new RawGraph();
    raw.addPackage("router", "unscoped");
    raw.addPackage("@tanstack/router", "scoped");
    const snap = raw.toSnapshot({
      name: "scope",
      capturedAt: "2026-08-17T00:00:00.000Z",
      roots: [],
      provenance: "test",
    });
    expect(snap.packages).toHaveLength(2);
  });

  it("rejects a fixture that is not valid JSON", async () => {
    const dir = await tmp();
    const p = join(dir, "bad.json");
    await writeFile(p, "{{{");
    await expect(loadSnapshot(p)).rejects.toThrow();
  });
});

describe("remediation under degenerate input", () => {
  const empty: BlastRadiusResult = {
    found: true,
    downstream: [],
    lateralMovement: [],
    totalAffected: 0,
  };

  it("produces a valid plan when nothing is affected", () => {
    const plan = buildPlan("lonely", empty);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].reason).toBe("compromised");
    const bl = toBlocklist(plan);
    expect(bl.blocked.lonely).toEqual([]);
  });

  it("blocks every version when no bad versions are named", () => {
    // An empty array means "all versions", which the gate must honour.
    const bl = toBlocklist(buildPlan("x", empty, []));
    expect(bl.blocked.x).toEqual([]);
  });

  it("renders a comment for a package with no graph data at all", () => {
    const md = renderPrComment({
      compromised: "unknown-package",
      verify: { ok: true, violations: [], reviewHits: [], packagesScanned: 0 },
    });
    expect(md).toContain("Supply chain gate");
    expect(md).not.toContain("undefined");
    expect(md).not.toContain("NaN");
  });

  it("does not emit undefined or NaN for a large blast radius", () => {
    const big: BlastRadiusResult = {
      found: true,
      downstream: Array.from({ length: 500 }, (_, i) => ({ name: `p${i}` })),
      lateralMovement: [
        {
          maintainer: "m",
          atRiskPackages: Array.from({ length: 300 }, (_, i) => `q${i}`),
        },
      ],
      totalAffected: 800,
    };
    const md = renderPrComment({
      compromised: "x",
      verify: { ok: true, violations: [], reviewHits: [], packagesScanned: 1 },
      blast: big,
    });
    expect(md).not.toContain("undefined");
    expect(md).not.toContain("NaN");
    // Must stay readable rather than dumping 800 entries into a PR.
    expect(md.length).toBeLessThan(20_000);
  });
});

describe("http value decoding against unexpected shapes", () => {
  it("does not throw on shapes it has never seen", () => {
    for (const v of [
      {},
      { Unknown: 1 },
      [],
      { String: null },
      { Integer: "not-a-number" },
      { type: "unheard_of", value: 1 },
    ]) {
      expect(() => decodePropertyValue(v)).not.toThrow();
    }
  });

  it("decodes an empty string rather than dropping it", () => {
    expect(decodePropertyValue({ String: "" })).toBe("");
  });

  it("decodes zero and false rather than treating them as absent", () => {
    expect(decodePropertyValue({ Integer: 0 })).toBe(0);
    expect(decodePropertyValue({ Bool: false })).toBe(false);
  });
});
