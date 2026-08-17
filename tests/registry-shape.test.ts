import { describe, it, expect } from "vitest";
import type { NpmPackageData } from "../src/ingest/npm-registry.js";

/**
 * Regression guard for a real finding from the first doctor run.
 *
 * npm omits the `dependencies` key entirely when a package has none, so
 * `chalk@6` returns a version record with no `dependencies` at all. A shape
 * check that only asserts "the key parses" cannot tell a working parser apart
 * from one that returns nothing, which is why the probe asserts a NON-EMPTY
 * dependency map and runs against a package known to have dependencies.
 */

function readDeps(pkg: NpmPackageData): Record<string, string> {
  const latest = pkg["dist-tags"]?.latest;
  const versionData = latest ? pkg.versions?.[latest] : undefined;
  return versionData?.dependencies ?? {};
}

describe("npm payload shape", () => {
  it("treats an absent dependencies key as zero deps, not a crash", () => {
    const dependencyFree: NpmPackageData = {
      name: "chalk",
      "dist-tags": { latest: "6.0.0" },
      versions: {
        // no `dependencies` key at all, exactly as npm serves it
        "6.0.0": { name: "chalk", version: "6.0.0" },
      },
    };
    expect(readDeps(dependencyFree)).toEqual({});
  });

  it("reads a populated dependency map", () => {
    const withDeps: NpmPackageData = {
      name: "express",
      "dist-tags": { latest: "5.2.1" },
      versions: {
        "5.2.1": {
          name: "express",
          version: "5.2.1",
          dependencies: { qs: "^6.14.0", depd: "^2.0.0", etag: "^1.8.1" },
        },
      },
    };
    expect(Object.keys(readDeps(withDeps))).toHaveLength(3);
  });

  it("survives a missing dist-tags block", () => {
    const broken: NpmPackageData = { name: "ghost" };
    expect(readDeps(broken)).toEqual({});
  });

  it("survives dist-tags pointing at a version that is not present", () => {
    const inconsistent: NpmPackageData = {
      name: "weird",
      "dist-tags": { latest: "9.9.9" },
      versions: { "1.0.0": { name: "weird", version: "1.0.0" } },
    };
    expect(readDeps(inconsistent)).toEqual({});
  });
});
