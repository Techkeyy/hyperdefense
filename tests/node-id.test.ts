import { describe, it, expect } from "vitest";
import { nodeId } from "../src/db/node-id.js";

describe("nodeId", () => {
  it("is deterministic: same kind and name always give the same id", () => {
    expect(nodeId("package", "express")).toBe(nodeId("package", "express"));
    expect(nodeId("maintainer", "sindresorhus")).toBe(
      nodeId("maintainer", "sindresorhus"),
    );
  });

  it("namespaces by kind: a package and a maintainer with the same name differ", () => {
    expect(nodeId("package", "foo")).not.toBe(nodeId("maintainer", "foo"));
  });

  it("distinguishes different names within a kind", () => {
    expect(nodeId("package", "react")).not.toBe(nodeId("package", "vue"));
  });

  it("always returns a non-negative safe integer (HydraDB id constraint)", () => {
    const names = [
      "express",
      "@tanstack/router",
      "a",
      "",
      "package-with-a-very-long-name-that-goes-on",
      "unicode-π-name",
    ];
    for (const kind of ["package", "maintainer", "version"] as const) {
      for (const name of names) {
        const id = nodeId(kind, name);
        expect(Number.isInteger(id)).toBe(true);
        expect(id).toBeGreaterThanOrEqual(0);
        expect(id).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
      }
    }
  });

  it("has no collisions across a realistic package set", () => {
    const names = [
      "lodash", "chalk", "react", "express", "axios", "tslib", "commander",
      "request", "moment", "debug", "uuid", "glob", "minimist", "semver",
      "yargs", "fs-extra", "dotenv", "inquirer", "rxjs", "bluebird", "async",
      "underscore", "body-parser", "webpack", "typescript", "eslint",
      "prettier", "mkdirp", "rimraf", "cross-env", "@tanstack/react-query",
      "@tanstack/router", "next", "vue", "svelte", "vite", "esbuild", "rollup",
      "keyv", "cacheable", "flat-cache", "file-entry-cache", "nx",
    ];
    const ids = new Set(names.map((n) => nodeId("package", n)));
    expect(ids.size).toBe(names.length);
  });
});
