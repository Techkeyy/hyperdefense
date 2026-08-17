import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import {
  RawGraph,
  replaySnapshot,
  type GraphSink,
  type Snapshot,
} from "../src/ingest/snapshot.js";

/** Minimal sink that records what it was told, for verifying replay fidelity. */
class RecordingSink implements GraphSink {
  packages: string[] = [];
  maintainers: string[] = [];
  versions: string[] = [];
  dependencies: Array<[string, string]> = [];
  publishes: Array<[string, string]> = [];
  hasVersion: Array<[string, string]> = [];

  addPackage(name: string): number {
    this.packages.push(name);
    return 0;
  }
  addMaintainer(username: string): number {
    this.maintainers.push(username);
    return 0;
  }
  addVersion(pkg: string, version: string): number {
    this.versions.push(`${pkg}@${version}`);
    return 0;
  }
  addDependency(from: string, to: string): void {
    this.dependencies.push([from, to]);
  }
  addPublishes(user: string, pkg: string): void {
    this.publishes.push([user, pkg]);
  }
  addHasVersion(pkg: string, key: string): void {
    this.hasVersion.push([pkg, key]);
  }
}

const META = {
  name: "test",
  capturedAt: "2026-08-17T00:00:00.000Z",
  roots: ["a"],
  provenance: "test",
};

describe("snapshot capture and replay", () => {
  it("round-trips every element through capture and replay", () => {
    const raw = new RawGraph();
    raw.addPackage("a", "pkg a", "1.0.0");
    raw.addPackage("b");
    raw.addMaintainer("alice", "alice@example.com");
    raw.addVersion("a", "1.0.0", "2026-05-11T09:00:00.000Z");
    raw.addDependency("a", "b");
    raw.addPublishes("alice", "a");
    raw.addHasVersion("a", "a@1.0.0");

    const snap = raw.toSnapshot(META);
    const sink = new RecordingSink();
    replaySnapshot(snap, sink);

    expect(sink.packages.sort()).toEqual(["a", "b"]);
    expect(sink.maintainers).toEqual(["alice"]);
    expect(sink.versions).toEqual(["a@1.0.0"]);
    expect(sink.dependencies).toEqual([["a", "b"]]);
    expect(sink.publishes).toEqual([["alice", "a"]]);
    expect(sink.hasVersion).toEqual([["a", "a@1.0.0"]]);
  });

  it("keeps the richest package record when a package is seen twice", () => {
    const raw = new RawGraph();
    // First seen as a bare dependency, later fetched with real metadata.
    raw.addPackage("lodash");
    raw.addPackage("lodash", "Lodash utilities", "4.17.21");
    const snap = raw.toSnapshot(META);
    const pkg = snap.packages.find((p) => p.name === "lodash");
    expect(pkg?.description).toBe("Lodash utilities");
    expect(pkg?.latestVersion).toBe("4.17.21");
  });

  it("does not lose metadata when the bare sighting comes second", () => {
    const raw = new RawGraph();
    raw.addPackage("lodash", "Lodash utilities", "4.17.21");
    raw.addPackage("lodash");
    const pkg = raw.toSnapshot(META).packages.find((p) => p.name === "lodash");
    expect(pkg?.latestVersion).toBe("4.17.21");
  });

  it("sorts output so a re-captured fixture diffs cleanly", () => {
    const raw = new RawGraph();
    raw.addPackage("zzz");
    raw.addPackage("aaa");
    raw.addDependency("zzz", "aaa");
    raw.addDependency("aaa", "zzz");
    const snap = raw.toSnapshot(META);
    expect(snap.packages.map((p) => p.name)).toEqual(["aaa", "zzz"]);
    expect(snap.dependencies[0][0]).toBe("aaa");
  });
});

describe("committed TanStack fixture", () => {
  const path = "fixtures/tanstack.json";

  it("exists and is valid, so the offline demo cannot silently rot", () => {
    expect(existsSync(path)).toBe(true);
    const snap = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
    expect(snap.packages.length).toBeGreaterThan(20);
    expect(snap.maintainers.length).toBeGreaterThan(10);
    expect(snap.dependencies.length).toBeGreaterThan(20);
  });

  it("contains the maintainer overlap the lateral-movement claim rests on", () => {
    const snap = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
    const byMaintainer = new Map<string, Set<string>>();
    for (const [m, p] of snap.publishes) {
      const set = byMaintainer.get(m) ?? new Set<string>();
      set.add(p);
      byMaintainer.set(m, set);
    }
    // At least one maintainer must publish several packages, otherwise the
    // lateral-movement layer has nothing to demonstrate.
    const widest = Math.max(...[...byMaintainer.values()].map((s) => s.size));
    expect(widest).toBeGreaterThanOrEqual(5);
  });

  it("records its own provenance, so the data's origin is never ambiguous", () => {
    const snap = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
    expect(snap.meta.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(snap.meta.provenance).toContain("npm registry");
    expect(snap.meta.roots.length).toBeGreaterThan(0);
  });
});
