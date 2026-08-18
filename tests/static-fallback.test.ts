import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Guards the dashboard's static fallback.
 *
 * The deployed page showed "Cannot reach the API" instead of its precomputed
 * data. The client treated a 404 as "our API says this package does not exist",
 * a legitimate answer worth rethrowing, when on a static host a 404 with an HTML
 * body means there is no API at all and the fallback should engage.
 *
 * The client is plain browser JS with no exports, so it is evaluated here with a
 * stubbed fetch. That is deliberate: this bug lived in the branch between two
 * transports, which no amount of testing either transport alone would catch.
 */

function loadClient(fetchImpl: typeof fetch) {
  const src = readFileSync("src/web/public/app.js", "utf8");
  const calls: string[] = [];
  const els = new Map<string, Record<string, unknown>>();
  const el = (id: string) => {
    if (!els.has(id))
      els.set(id, {
        textContent: "",
        hidden: false,
        value: "",
        innerHTML: "",
        appendChild() {},
        addEventListener() {},
        querySelectorAll: () => [],
        contains: () => false,
        getContext: () => null,
        clientWidth: 800,
        clientHeight: 400,
        style: {},
      });
    return els.get(id)!;
  };
  const doc = {
    getElementById: (id: string) => el(id),
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => el("tmp"),
  };
  const ctx = {
    document: doc,
    fetch: (p: string) => {
      calls.push(p);
      return fetchImpl(p as never);
    },
    location: { origin: "https://example.test" },
    URL,
    Set,
    Map,
    Math,
    JSON,
    Date,
    Number,
    console,
    window: { devicePixelRatio: 1 },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    setTimeout,
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(...Object.keys(ctx), src);
  fn(...Object.values(ctx));
  return { calls, els };
}

afterEach(() => vi.restoreAllMocks());

const htmlNotFound = () =>
  new Response("<!doctype html>not found", {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

const jsonOk = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("static fallback", () => {
  it("falls back to precomputed data when /api returns an HTML 404", async () => {
    // Exactly what GitHub Pages and Vercel serve for an unknown path.
    const impl = vi.fn(async (p: string) => {
      if (p.startsWith("/api/")) return htmlNotFound();
      if (p.endsWith("manifest.json"))
        return jsonOk({
          generatedAt: "2026-08-18T00:00:00.000Z",
          featured: ["body-parser"],
          packages: ["body-parser"],
        });
      return jsonOk({ nodes: [], links: [], stats: {} });
    }) as unknown as typeof fetch;

    const { calls } = loadClient(impl);
    await new Promise((r) => setTimeout(r, 30));

    // It must have gone on to ask for the precomputed manifest.
    expect(calls.some((c) => c.includes("manifest.json"))).toBe(true);
  });

  it("still reaches for the live API first when one is present", async () => {
    const impl = vi.fn(async (p: string) => {
      if (p === "/api/packages") return jsonOk({ packages: ["express"] });
      return jsonOk({ nodes: [], links: [], stats: {} });
    }) as unknown as typeof fetch;

    const { calls } = loadClient(impl);
    await new Promise((r) => setTimeout(r, 30));

    expect(calls[0]).toBe("/api/packages");
    expect(calls.some((c) => c.includes("manifest.json"))).toBe(false);
  });

  it("falls back when there is no server at all", async () => {
    const impl = vi.fn(async (p: string) => {
      if (p.startsWith("/api/")) throw new TypeError("Failed to fetch");
      return jsonOk({
        generatedAt: "2026-08-18T00:00:00.000Z",
        featured: [],
        packages: [],
      });
    }) as unknown as typeof fetch;

    const { calls } = loadClient(impl);
    await new Promise((r) => setTimeout(r, 30));

    expect(calls.some((c) => c.includes("manifest.json"))).toBe(true);
  });
});
