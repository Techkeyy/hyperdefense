import type { VerifyResult } from "../remediate/verify.js";
import type { BlastRadiusResult } from "../analysis/blast-radius.js";
import type { AttackPath } from "../analysis/multi-blast.js";

/**
 * Renders the finding as a pull request comment.
 *
 * This is the surface that decides whether the tool gets used. A report someone
 * has to remember to open is not a control; a comment on the diff, next to the
 * dependency change that caused it, is read by the person who can act on it.
 * The CI gate blocks the merge, and this explains why in the place the merge is
 * happening.
 *
 * Markdown only, no API calls: the workflow posts it. That keeps this pure and
 * testable, and means the same text can go to a PR, an issue, a Slack message,
 * or a terminal without change.
 */

export interface PrCommentInput {
  /** Package named in the advisory. */
  compromised: string;
  /** Gate result against the PR's lockfile. */
  verify: VerifyResult;
  /** Graph analysis, when the package is in the graph. */
  blast?: BlastRadiusResult;
  /** Concrete chains into whatever the repo actually depends on. */
  paths?: AttackPath[];
  /** Version to pin to, when a clean one is known. */
  safeVersion?: string;
  /** First release inside the compromise window. */
  firstSuspectVersion?: string;
}

const MARKER = "<!-- hyperdefense-report -->";

/** Identifies our own comment so a workflow can update rather than duplicate. */
export const COMMENT_MARKER = MARKER;

export function renderPrComment(input: PrCommentInput): string {
  const { compromised, verify, blast, paths, safeVersion, firstSuspectVersion } =
    input;
  const blocked = verify.violations.length > 0;

  const out: string[] = [MARKER, ""];

  out.push(
    blocked
      ? `## Supply chain gate: **blocked**`
      : `## Supply chain gate: passed`,
    "",
  );

  if (blocked) {
    out.push(
      `This branch resolves a version of \`${compromised}\` that is on the blocklist.`,
      "",
      "| package | version | resolved at |",
      "|---------|---------|-------------|",
    );
    for (const v of verify.violations.slice(0, 20)) {
      out.push(`| \`${v.package}\` | \`${v.version}\` | \`${v.path}\` |`);
    }
    if (verify.violations.length > 20) {
      out.push(`| ... | ${verify.violations.length - 20} more | |`);
    }
    out.push("");
  } else {
    out.push(
      `No blocked version of \`${compromised}\` resolved in this branch's ` +
        `lockfile (${verify.packagesScanned} packages scanned).`,
      "",
    );
  }

  // The differentiator, stated as a contrast rather than a raw number.
  if (blast?.found) {
    const depOnly = blast.downstream.length;
    const total = blast.totalAffected;
    out.push(
      `### Blast radius`,
      "",
      `A dependency-only scanner reports **${depOnly}** affected package${depOnly === 1 ? "" : "s"}. ` +
        `Including packages reachable through shared maintainer accounts, ` +
        `**${total}** need review.`,
      "",
    );

    if (blast.lateralMovement.length > 0) {
      out.push(
        `<details><summary>Maintainer accounts that reach further (${blast.lateralMovement.length})</summary>`,
        "",
      );
      for (const lm of blast.lateralMovement.slice(0, 10)) {
        out.push(
          `- **@${lm.maintainer}** also publishes ${lm.atRiskPackages.length} ` +
            `other package${lm.atRiskPackages.length === 1 ? "" : "s"}: ` +
            lm.atRiskPackages
              .slice(0, 12)
              .map((p) => `\`${p}\``)
              .join(", ") +
            (lm.atRiskPackages.length > 12 ? ", ..." : ""),
        );
      }
      out.push(
        "",
        `A worm that compromises one of these accounts can republish every ` +
          `package it owns. That is how the Shai-Hulud and TanStack campaigns ` +
          `spread.`,
        "",
        "</details>",
        "",
      );
    }
  }

  // The chain is what tells a reviewer where to cut.
  if (paths && paths.length > 0) {
    out.push(`### How it reaches this repo`, "");
    for (const p of paths.slice(0, 8)) {
      out.push(`- \`${p.chain.join("` -> `")}\` (${p.hops} hops)`);
    }
    out.push(
      "",
      `The middle of each chain is the dependency to change; cutting it there ` +
        `removes the path.`,
      "",
    );
  }

  out.push(`### What to do`, "");
  if (blocked) {
    if (safeVersion) {
      out.push(
        "Pin to the last release published before the compromise window:",
        "",
        "```json",
        JSON.stringify({ overrides: { [compromised]: safeVersion } }, null, 2),
        "```",
        "",
        `Add that to \`package.json\` and reinstall.`,
        "",
      );
    } else {
      out.push(
        `No clean version has been identified yet, so no pin is suggested. ` +
          `HyperDefense will not guess one: a pin that looks authoritative and ` +
          `is wrong gets applied without being read.`,
        "",
      );
    }
    if (firstSuspectVersion) {
      out.push(
        `First release inside the compromise window: \`${firstSuspectVersion}\`.`,
        "",
      );
    }
  } else {
    out.push(
      "Nothing to do for this branch. The packages listed for review above are " +
        "not blocked, they are flagged because they share a maintainer account " +
        "with the compromised package.",
      "",
    );
  }

  if (verify.reviewHits.length > 0) {
    out.push(
      `<details><summary>Present in this branch and worth reviewing (${verify.reviewHits.length})</summary>`,
      "",
    );
    for (const r of verify.reviewHits.slice(0, 25)) {
      const via = r.via?.length ? ` via @${r.via.join(", @")}` : "";
      out.push(`- \`${r.package}@${r.version}\`${via}`);
    }
    out.push("", "</details>", "");
  }

  out.push(
    "---",
    "",
    `<sub>[HyperDefense](https://github.com/Techkeyy/hyperdefense): ` +
      `graph analysis on HydraDB. Re-run locally with ` +
      `\`npx hyperdefense blast ${compromised}\`</sub>`,
  );

  return out.join("\n");
}
