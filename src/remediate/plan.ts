import type { BlastRadiusResult } from "../analysis/blast-radius.js";

/**
 * Why a package is in the plan. The distinction matters operationally: a
 * responder treats a confirmed compromise differently from a package that is
 * merely reachable through a shared maintainer account.
 */
export type Reason =
  /** The package named in the advisory. */
  | "compromised"
  /** Depends on the compromised package, so it resolves the bad code. */
  | "downstream"
  /**
   * Published by an account that also publishes the compromised package. Not
   * known-bad, but a worm that owns the account can republish it at will, which
   * is how the TanStack and Shai-Hulud campaigns actually spread.
   */
  | "shared-maintainer";

export interface PlanEntry {
  name: string;
  reason: Reason;
  /** Maintainer accounts that reach this package, for shared-maintainer entries. */
  via?: string[];
}

export interface RemediationPlan {
  compromised: string;
  /** Versions explicitly named as malicious, if the caller supplied any. */
  blockedVersions: string[];
  entries: PlanEntry[];
  counts: { compromised: number; downstream: number; sharedMaintainer: number };
  generatedAt: string;
}

/**
 * Turns a blast radius into an ordered, deduplicated remediation plan.
 *
 * Deterministic by construction: same graph and same inputs produce a
 * byte-identical plan. No model is consulted, so the output is reviewable,
 * diffable, and safe to gate a pipeline on.
 */
export function buildPlan(
  compromised: string,
  blast: BlastRadiusResult,
  blockedVersions: string[] = [],
): RemediationPlan {
  const entries: PlanEntry[] = [
    { name: compromised, reason: "compromised" },
  ];
  const seen = new Set<string>([compromised]);

  // Downstream first: these definitely resolve the compromised code.
  for (const d of [...blast.downstream].sort((a, b) => a.name.localeCompare(b.name))) {
    if (seen.has(d.name)) continue;
    seen.add(d.name);
    entries.push({ name: d.name, reason: "downstream" });
  }

  // Then shared-maintainer reach, collapsing the maintainers that lead to each
  // package so the operator can see who to contact.
  const viaByPackage = new Map<string, Set<string>>();
  for (const lm of blast.lateralMovement) {
    for (const pkg of lm.atRiskPackages) {
      const set = viaByPackage.get(pkg) ?? new Set<string>();
      set.add(lm.maintainer);
      viaByPackage.set(pkg, set);
    }
  }
  for (const pkg of [...viaByPackage.keys()].sort()) {
    if (seen.has(pkg)) continue;
    seen.add(pkg);
    entries.push({
      name: pkg,
      reason: "shared-maintainer",
      via: [...(viaByPackage.get(pkg) ?? [])].sort(),
    });
  }

  return {
    compromised,
    blockedVersions: [...blockedVersions].sort(),
    entries,
    counts: {
      compromised: 1,
      downstream: entries.filter((e) => e.reason === "downstream").length,
      sharedMaintainer: entries.filter((e) => e.reason === "shared-maintainer")
        .length,
    },
    generatedAt: new Date().toISOString(),
  };
}

export interface Blocklist {
  $schema: "hyperdefense/blocklist@1";
  generatedAt: string;
  compromised: string;
  /** package -> versions to reject. An empty array means "any version". */
  blocked: Record<string, string[]>;
  /** Packages to review but not hard-block, with the accounts that reach them. */
  review: Record<string, { reason: Reason; via?: string[] }>;
}

/**
 * The machine-readable artifact `verify` consumes in CI.
 *
 * Only the compromised package is hard-blocked. Shared-maintainer packages go
 * to `review`: blocking a maintainer's entire portfolio on suspicion would
 * break builds for packages that were never touched, and a gate that cries wolf
 * gets switched off. That judgement is deliberate.
 */
export function toBlocklist(plan: RemediationPlan): Blocklist {
  const blocked: Record<string, string[]> = {
    [plan.compromised]: plan.blockedVersions,
  };
  const review: Record<string, { reason: Reason; via?: string[] }> = {};

  for (const e of plan.entries) {
    if (e.reason === "compromised") continue;
    review[e.name] = e.via
      ? { reason: e.reason, via: e.via }
      : { reason: e.reason };
  }

  return {
    $schema: "hyperdefense/blocklist@1",
    generatedAt: plan.generatedAt,
    compromised: plan.compromised,
    blocked,
    review,
  };
}
