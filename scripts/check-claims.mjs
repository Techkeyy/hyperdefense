/**
 * Verifies the numbers the project states about itself against the project.
 *
 * The test count has now gone stale twice: the README claimed 42 when 96 were
 * passing, then 96 when 102 were. Nothing warns you, because a claim in prose
 * is not executed by anything. This executes it.
 *
 * Run: npm run check:claims
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const fail = [];

// Call vitest's own entry with this Node, rather than the npx shim: Windows
// refuses to spawn .cmd files from execFileSync (EINVAL).
const out = execFileSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", "--reporter=json"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64e6 },
);
const actual = JSON.parse(out.slice(out.indexOf("{"))).numTotalTests;

const claims = [
  ["README.md", /(\d+) tests currently pass/],
  ["src/web/public/index.html", /(\d+) passing tests/],
];
for (const [file, re] of claims) {
  const m = readFileSync(file, "utf8").match(re);
  if (!m) fail.push(`${file}: no test-count claim found (pattern moved?)`);
  else if (Number(m[1]) !== actual)
    fail.push(`${file}: claims ${m[1]} tests, ${actual} actually pass`);
}

if (fail.length > 0) {
  console.error("Claims do not match reality:\n  " + fail.join("\n  "));
  process.exit(1);
}
console.log(`Claims match: ${actual} tests pass, and both documents say so.`);
