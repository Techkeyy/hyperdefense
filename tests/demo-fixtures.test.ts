import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, rm, mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { verifyLockfile } from "../src/remediate/verify.js";
import type { Snapshot } from "../src/ingest/snapshot.js";

/**
 * Guards the `demo` command. Every number in the demo comes from these
 * fixtures, so if one drifts the demo quietly stops demonstrating anything.
 * These tests fail loudly instead.
 */

describe("vulnerable-app lockfile fixture", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    dirs.length = 0;
  });

  it("actually trips the gate, so the demo has a failure to show", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hd-demo-"));
    dirs.push(dir);
    const bl = join(dir, "blocklist.json");
    await writeFile(
      bl,
      JSON.stringify({
        $schema: "hyperdefense/blocklist@1",
        generatedAt: "2026-08-17T00:00:00.000Z",
        compromised: "@tanstack/router-core",
        blocked: { "@tanstack/router-core": ["1.0.1"] },
        review: {},
      }),
    );

    const r = await verifyLockfile(bl, "fixtures/vulnerable-app-lock.json");
    expect(r.ok).toBe(false);
    expect(r.violations.length).toBeGreaterThanOrEqual(2);
  });

  it("includes a nested transitive resolution, not only a top-level one", async () => {
    const lock = JSON.parse(
      readFileSync("fixtures/vulnerable-app-lock.json", "utf8"),
    ) as { packages: Record<string, unknown> };
    const nested = Object.keys(lock.packages).filter(
      (p) => (p.match(/node_modules/g) ?? []).length > 1,
    );
    expect(nested.length).toBeGreaterThan(0);
  });

  it("is labelled synthetic, so it is never mistaken for real data", () => {
    const raw = readFileSync("fixtures/vulnerable-app-lock.json", "utf8");
    expect(raw).toMatch(/SYNTHETIC/);
  });
});

describe("typosquat demo fixture", () => {
  const load = () =>
    JSON.parse(readFileSync("fixtures/typosquat-demo.json", "utf8")) as Snapshot;

  it("declares plainly that it is hand-authored, unlike the npm fixture", () => {
    const snap = load();
    expect(snap.meta.provenance).toMatch(/SYNTHETIC/);
    expect(snap.meta.provenance).toMatch(/not published/);
  });

  it("contains near-misses within edit distance 2 of a legitimate name", () => {
    const snap = load();
    const names = snap.packages.map((p) => p.name);
    expect(names).toContain("express");
    // Character omission and adjacent-swap variants must both be present.
    expect(names).toContain("expres");
    expect(names.some((n) => n === "aixos" || n === "reqeust")).toBe(true);
  });

  it("attributes the near-misses to a separate account", () => {
    const snap = load();
    const suspicious = snap.publishes
      .filter(([m]) => m === "suspicious-actor")
      .map(([, p]) => p);
    expect(suspicious.length).toBeGreaterThanOrEqual(10);
    expect(suspicious).not.toContain("express");
  });
});

describe("tanstack fixture carries real version history", () => {
  const load = () =>
    JSON.parse(readFileSync("fixtures/tanstack.json", "utf8")) as Snapshot;

  it("has many versions per package, not just the latest", () => {
    // Regression guard. The first version of the ingester recorded only
    // dist-tags.latest, giving exactly one version node per package, which
    // makes the temporal layer unable to answer "which version introduced
    // this" no matter how the query is written.
    const snap = load();
    const byPackage = new Map<string, number>();
    for (const v of snap.versions) {
      byPackage.set(v.package, (byPackage.get(v.package) ?? 0) + 1);
    }
    const counts = [...byPackage.values()];
    expect(Math.max(...counts)).toBeGreaterThan(10);
    expect(snap.versions.length).toBeGreaterThan(500);
  });

  it("version timestamps span a real range, so a window can select a subset", () => {
    const snap = load();
    const times = snap.versions.map((v) => v.publishedAt).sort();
    expect(times[0]).not.toBe(times[times.length - 1]);
    const spanDays =
      (Date.parse(times[times.length - 1]) - Date.parse(times[0])) / 86_400_000;
    expect(spanDays).toBeGreaterThan(30);
  });
});

describe("tanstack fixture is real data, and says so", () => {
  it("distinguishes itself from the synthetic fixtures", () => {
    const snap = JSON.parse(
      readFileSync("fixtures/tanstack.json", "utf8"),
    ) as Snapshot;
    expect(snap.meta.provenance).toMatch(/Real registry data/);
    expect(snap.meta.provenance).not.toMatch(/SYNTHETIC/);
  });
});
