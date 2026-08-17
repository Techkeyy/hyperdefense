import { readFile } from "node:fs/promises";
import type { Blocklist } from "./plan.js";

export interface Violation {
  package: string;
  version: string;
  /** Where in the lockfile it was found, for a actionable message. */
  path: string;
}

export interface VerifyResult {
  ok: boolean;
  violations: Violation[];
  reviewHits: Array<{ package: string; version: string; via?: string[] }>;
  packagesScanned: number;
}

/**
 * npm lockfile v2/v3 shape. `packages` is keyed by install path
 * ("node_modules/foo", "node_modules/a/node_modules/b"), which is what makes
 * transitive resolutions visible: the same package can appear at several paths
 * with different versions, and a gate has to catch every one.
 */
interface NpmLockfile {
  lockfileVersion?: number;
  packages?: Record<string, { version?: string }>;
  dependencies?: Record<string, { version?: string }>;
}

/** Extract the package name from a lockfile path key, scoped names included. */
function nameFromPath(path: string): string | undefined {
  const idx = path.lastIndexOf("node_modules/");
  if (idx === -1) return undefined;
  const name = path.slice(idx + "node_modules/".length);
  return name.length > 0 ? name : undefined;
}

/**
 * Checks a lockfile against a blocklist.
 *
 * Reads the lockfile rather than package.json on purpose: package.json declares
 * ranges, the lockfile records what actually resolved. A compromise is about the
 * version that landed, so the range is not the thing to check.
 */
export async function verifyLockfile(
  blocklistPath: string,
  lockfilePath: string,
): Promise<VerifyResult> {
  const blocklist = JSON.parse(
    await readFile(blocklistPath, "utf8"),
  ) as Blocklist;
  const lock = JSON.parse(await readFile(lockfilePath, "utf8")) as NpmLockfile;

  const violations: Violation[] = [];
  const reviewHits: Array<{ package: string; version: string; via?: string[] }> =
    [];
  let scanned = 0;

  const check = (name: string, version: string, path: string) => {
    scanned++;
    const blockedVersions = blocklist.blocked[name];
    if (blockedVersions) {
      // Empty array means every version of this package is rejected.
      if (blockedVersions.length === 0 || blockedVersions.includes(version)) {
        violations.push({ package: name, version, path });
      }
    }
    const review = blocklist.review?.[name];
    if (review) {
      reviewHits.push({ package: name, version, via: review.via });
    }
  };

  // Lockfile v2/v3
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    const name = nameFromPath(path);
    if (!name || !entry?.version) continue;
    check(name, entry.version, path);
  }

  // Lockfile v1 fallback
  for (const [name, entry] of Object.entries(lock.dependencies ?? {})) {
    if (!entry?.version) continue;
    check(name, entry.version, `dependencies/${name}`);
  }

  return {
    ok: violations.length === 0,
    violations,
    reviewHits,
    packagesScanned: scanned,
  };
}
