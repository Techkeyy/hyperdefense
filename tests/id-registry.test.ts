import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { IdRegistry } from "../src/db/id-registry.js";

function tmpPath(): string {
  return join(tmpdir(), `hd-idreg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

describe("IdRegistry", () => {
  const paths: string[] = [];
  const track = (p: string) => (paths.push(p), p);

  afterEach(async () => {
    await Promise.all(paths.map((p) => rm(p, { force: true })));
    paths.length = 0;
  });

  it("assigns compact sequential ids starting at 1", async () => {
    const r = new IdRegistry(track(tmpPath()));
    await r.load();
    expect(r.id("package", "express")).toBe(1);
    expect(r.id("package", "react")).toBe(2);
    expect(r.id("maintainer", "sindresorhus")).toBe(3);
  });

  it("is get-or-assign: the same name keeps its id", async () => {
    const r = new IdRegistry(track(tmpPath()));
    await r.load();
    const first = r.id("package", "express");
    expect(r.id("package", "express")).toBe(first);
  });

  it("keeps ids small enough to be a GraphBLAS index", async () => {
    const r = new IdRegistry(track(tmpPath()));
    await r.load();
    for (let i = 0; i < 5000; i++) r.id("package", `pkg-${i}`);
    // 5000 distinct names must stay well under any large-id threshold.
    expect(r.id("package", "pkg-4999")).toBeLessThan(6000);
  });

  it("namespaces by kind so a package and maintainer of the same name differ", async () => {
    const r = new IdRegistry(track(tmpPath()));
    await r.load();
    expect(r.id("package", "foo")).not.toBe(r.id("maintainer", "foo"));
  });

  it("persists and reloads the map so a separate process resolves the same id", async () => {
    const path = track(tmpPath());
    const writer = new IdRegistry(path);
    await writer.load();
    const expressId = writer.id("package", "express");
    writer.id("maintainer", "wesleytodd");
    await writer.save();

    // Simulate `blast express` in a fresh process.
    const reader = new IdRegistry(path);
    await reader.load();
    expect(reader.lookup("package", "express")).toBe(expressId);
  });

  it("continues the counter after reload (no id reuse)", async () => {
    const path = track(tmpPath());
    const a = new IdRegistry(path);
    await a.load();
    a.id("package", "one");
    a.id("package", "two");
    await a.save();

    const b = new IdRegistry(path);
    await b.load();
    const nextId = b.id("package", "three");
    expect(nextId).toBe(3);
  });

  it("lookup returns undefined for a name never ingested", async () => {
    const r = new IdRegistry(track(tmpPath()));
    await r.load();
    expect(r.lookup("package", "never-seen")).toBeUndefined();
  });

  it("edge ids are distinct from node ids and idempotent", async () => {
    const r = new IdRegistry(track(tmpPath()));
    await r.load();
    const n = r.id("package", "a");
    const e = r.edgeId("DEPENDS_ON", "a", "b");
    expect(e).not.toBe(n);
    expect(r.edgeId("DEPENDS_ON", "a", "b")).toBe(e);
  });
});
