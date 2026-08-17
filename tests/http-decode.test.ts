import { describe, it, expect } from "vitest";
import { decodePropertyValue, decodePath } from "../src/db/http-client.js";
import { pathChain } from "../src/analysis/multi-blast.js";

/**
 * Guards the HTTP transport's two serde shapes.
 *
 * HydraDB uses different serde taggings at different levels: row values are
 * adjacently tagged (`{"type":"string","value":"x"}`), while property values
 * inside a path are externally tagged (`{"String":"x"}`). Conflating them does
 * not throw. It returns undecoded objects, every name lookup misses, and
 * attack-path reports "0 paths" as though the graph simply had none, which is
 * a silent wrong answer in a security tool. These tests exist so that failure
 * mode is caught here instead.
 */

describe("decodePropertyValue (externally tagged)", () => {
  it("decodes a string property", () => {
    expect(decodePropertyValue({ String: "@tanstack/router-core" })).toBe(
      "@tanstack/router-core",
    );
  });

  it("decodes integer variants", () => {
    expect(decodePropertyValue({ Integer: 42 })).toBe(42);
    expect(decodePropertyValue({ SignedInteger: -7 })).toBe(-7);
  });

  it("decodes booleans, including false", () => {
    expect(decodePropertyValue({ Bool: true })).toBe(true);
    expect(decodePropertyValue({ Bool: false })).toBe(false);
  });

  it("decodes a float whether bare or newtype-wrapped", () => {
    expect(decodePropertyValue({ Float: 1.5 })).toBe(1.5);
    expect(decodePropertyValue({ Float: { 0: 2.25 } })).toBe(2.25);
  });

  it("still handles the adjacently tagged shape, in case it appears here", () => {
    expect(decodePropertyValue({ type: "string", value: "x" })).toBe("x");
  });

  it("passes plain values through untouched", () => {
    expect(decodePropertyValue("plain")).toBe("plain");
    expect(decodePropertyValue(5)).toBe(5);
    expect(decodePropertyValue(null)).toBeNull();
  });
});

describe("decodePath into a usable chain", () => {
  const node = (name: string) => ({
    id: 1,
    labels: ["Package"],
    properties: { name: { String: name } },
  });

  it("produces an ordered chain, which is the whole point of a path", () => {
    const decoded = decodePath({
      nodes: [
        node("@tanstack/history"),
        node("@tanstack/router-core"),
        node("@tanstack/react-router"),
      ],
      relationships: [],
    });
    expect(pathChain(decoded as never)).toEqual([
      "@tanstack/history",
      "@tanstack/router-core",
      "@tanstack/react-router",
    ]);
  });

  it("handles a single-hop path", () => {
    const decoded = decodePath({
      nodes: [node("a"), node("b")],
      relationships: [],
    });
    expect(pathChain(decoded as never)).toEqual(["a", "b"]);
  });

  it("yields an empty chain for an empty path rather than throwing", () => {
    expect(pathChain(decodePath({ nodes: [] }) as never)).toEqual([]);
  });

  it("regression: raw undecoded properties must NOT silently yield a chain", () => {
    // If the wrong decoder is ever used again, `name` stays an object rather
    // than a string, nameOf rejects it, and the chain is empty. Asserting that
    // explicitly documents the failure mode instead of leaving it to surprise.
    const rawNode = {
      id: 1,
      labels: ["Package"],
      properties: { name: { String: "a" } },
    };
    const wrong = {
      start: { properties: { name: rawNode.properties.name } },
      end: { properties: { name: rawNode.properties.name } },
      segments: [],
    };
    expect(pathChain(wrong as never)).toEqual([]);
  });
});
