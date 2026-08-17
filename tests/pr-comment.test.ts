import { describe, it, expect } from "vitest";
import { renderPrComment, COMMENT_MARKER } from "../src/report/pr-comment.js";
import type { VerifyResult } from "../src/remediate/verify.js";
import type { BlastRadiusResult } from "../src/analysis/blast-radius.js";

const clean: VerifyResult = {
  ok: true,
  violations: [],
  reviewHits: [],
  packagesScanned: 134,
};

const blocked: VerifyResult = {
  ok: false,
  violations: [
    {
      package: "@tanstack/router-core",
      version: "1.0.1",
      path: "node_modules/@tanstack/router-core",
    },
  ],
  reviewHits: [
    { package: "@tanstack/store", version: "0.7.7", via: ["tannerlinsley"] },
  ],
  packagesScanned: 210,
};

const blast: BlastRadiusResult = {
  found: true,
  downstream: [{ name: "@tanstack/react-router" }],
  lateralMovement: [
    {
      maintainer: "tannerlinsley",
      atRiskPackages: ["@tanstack/store", "@tanstack/history"],
    },
  ],
  totalAffected: 3,
};

describe("renderPrComment", () => {
  it("carries a stable marker so a workflow can update instead of duplicating", () => {
    const md = renderPrComment({ compromised: "x", verify: clean });
    expect(md.startsWith(COMMENT_MARKER)).toBe(true);
  });

  it("says blocked when a version resolved, and names it", () => {
    const md = renderPrComment({
      compromised: "@tanstack/router-core",
      verify: blocked,
    });
    expect(md).toContain("blocked");
    expect(md).toContain("`@tanstack/router-core`");
    expect(md).toContain("1.0.1");
  });

  it("says passed, with the scan count, when nothing resolved", () => {
    const md = renderPrComment({ compromised: "x", verify: clean });
    expect(md).toContain("passed");
    expect(md).toContain("134 packages scanned");
  });

  it("leads with the contrast that is the whole argument", () => {
    const md = renderPrComment({
      compromised: "@tanstack/router-core",
      verify: blocked,
      blast,
    });
    expect(md).toContain("**1**");
    expect(md).toContain("**3**");
    expect(md).toMatch(/dependency-only scanner/i);
  });

  it("refuses to suggest a pin when no safe version is known", () => {
    const md = renderPrComment({
      compromised: "@tanstack/router-core",
      verify: blocked,
    });
    expect(md).toMatch(/will not guess/i);
    expect(md).not.toContain('"overrides"');
  });

  it("emits a valid overrides block when a safe version is supplied", () => {
    const md = renderPrComment({
      compromised: "@tanstack/router-core",
      verify: blocked,
      safeVersion: "1.0.0",
    });
    expect(md).toContain('"overrides"');
    const json = md.split("```json")[1].split("```")[0];
    expect(JSON.parse(json)).toEqual({
      overrides: { "@tanstack/router-core": "1.0.0" },
    });
  });

  it("renders attack chains so a reviewer sees where to cut", () => {
    const md = renderPrComment({
      compromised: "@tanstack/router-core",
      verify: blocked,
      blast,
      paths: [
        {
          from: "@tanstack/router-core",
          to: "@tanstack/react-router",
          chain: [
            "@tanstack/router-core",
            "@tanstack/router-plugin",
            "@tanstack/react-router",
          ],
          hops: 2,
        },
      ],
    });
    expect(md).toContain("@tanstack/router-plugin");
    expect(md).toContain("2 hops");
  });

  it("keeps review hits collapsed so the comment stays readable", () => {
    const md = renderPrComment({
      compromised: "@tanstack/router-core",
      verify: blocked,
    });
    expect(md).toContain("<details>");
    expect(md).toContain("@tanstack/store");
  });

  it("works with no graph data at all, so a PR check never fails on it", () => {
    const md = renderPrComment({ compromised: "x", verify: clean });
    expect(md.length).toBeGreaterThan(50);
    expect(md).toContain("Supply chain gate");
  });
});
