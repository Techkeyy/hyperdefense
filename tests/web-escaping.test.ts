import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The dashboard builds some messages with innerHTML and interpolates package
 * names taken straight from the input fields. Typing
 * `<img src=x onerror=...>` as a package name injected the element and ran the
 * handler. Self-inflicted, with no session or backend to compromise, but a
 * supply chain tool rendering whatever it is handed is the wrong look.
 *
 * These guard the fix at the source, because the browser behaviour it prevents
 * cannot be reproduced in this test environment.
 */
describe("dashboard escapes interpolated text", () => {
  const app = readFileSync("src/web/public/app.js", "utf8");

  it("defines an escaper covering the five dangerous characters", () => {
    expect(app).toMatch(/function esc\(/);
    for (const entity of ["&amp;", "&lt;", "&gt;", "&quot;", "&#39;"]) {
      expect(app).toContain(entity);
    }
  });

  it("never interpolates a package name or error into innerHTML unescaped", () => {
    const sinks = [...app.matchAll(/innerHTML = `([^`]*)`/g)].map((m) => m[1]);
    const risky = ["${from}", "${to}", "${err.message}", "${r.error}", "${extra}"];
    for (const sink of sinks) {
      for (const token of risky) {
        expect(
          sink.includes(token),
          `unescaped ${token} in innerHTML: ${sink.slice(0, 70)}`,
        ).toBe(false);
      }
    }
  });

  it("still renders those values, escaped, rather than dropping them", () => {
    expect(app).toContain("${esc(from)}");
    expect(app).toContain("${esc(err.message)}");
  });
});
