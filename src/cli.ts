#!/usr/bin/env node
import { program } from "commander";
import chalk from "chalk";
import ora from "ora";
import { closeConnection } from "./db/connection.js";
import { initSchema } from "./db/schema.js";
import { ingestPackage } from "./ingest/dependency-graph.js";
import { SEED_PACKAGES } from "./ingest/npm-registry.js";
import { analyzeBlastRadius } from "./analysis/blast-radius.js";
import { analyzeLateralMovement } from "./analysis/lateral-movement.js";
import { analyzeTemporalExposure } from "./analysis/temporal-exposure.js";
import { findTyposquats } from "./analysis/typosquat.js";

program
  .name("hyperdefense")
  .description(
    "Multi-graph supply chain blast radius engine built on HydraDB",
  )
  .version("0.1.0");

program
  .command("ingest")
  .description("Ingest npm packages into HydraDB")
  .option("-p, --packages <names...>", "specific packages to ingest")
  .option(
    "-c, --count <number>",
    "number of seed packages to ingest",
    "20",
  )
  .option("-d, --depth <number>", "max dependency depth", "3")
  .action(async (opts) => {
    const spinner = ora("Initializing schema...").start();
    await initSchema();

    const packages = opts.packages ?? SEED_PACKAGES.slice(0, Number(opts.count));
    const maxDepth = Number(opts.depth);
    const visited = new Set<string>();

    spinner.text = `Ingesting ${packages.length} packages (depth ${maxDepth})...`;

    let total = 0;
    for (const pkg of packages) {
      spinner.text = `Ingesting ${pkg}... (${total} nodes so far)`;
      total += await ingestPackage(pkg, visited, maxDepth);
    }

    spinner.succeed(
      `Ingested ${total} packages (${visited.size} unique nodes)`,
    );
    await closeConnection();
  });

program
  .command("blast <package>")
  .description("Analyze blast radius of a compromised package")
  .action(async (packageName) => {
    const spinner = ora(`Analyzing blast radius for ${packageName}...`).start();
    const result = await analyzeBlastRadius(packageName);
    spinner.stop();

    console.log(
      chalk.red.bold(`\n  BLAST RADIUS: ${packageName}\n`),
    );

    // Downstream
    console.log(chalk.yellow.bold("  Downstream dependencies:"));
    if (result.downstream.length === 0) {
      console.log(chalk.dim("    No downstream dependents found in graph"));
    }
    for (const d of result.downstream.slice(0, 20)) {
      const bar = chalk.red("█".repeat(Math.min(d.depth * 2, 20)));
      console.log(`    ${bar} ${d.package} (depth ${d.depth})`);
    }
    if (result.downstream.length > 20) {
      console.log(
        chalk.dim(`    ... and ${result.downstream.length - 20} more`),
      );
    }

    // Lateral movement
    console.log(chalk.magenta.bold("\n  Lateral movement risk (shared maintainers):"));
    if (result.lateralMovement.length === 0) {
      console.log(chalk.dim("    No shared maintainers found"));
    }
    for (const lm of result.lateralMovement) {
      console.log(
        chalk.magenta(`    @${lm.maintainer}`) +
          chalk.dim(` also publishes: `) +
          lm.atRiskPackages.join(", "),
      );
    }

    // Extended blast (through lateral movement)
    if (result.extendedBlast.length > 0) {
      console.log(
        chalk.red.bold("\n  Extended blast (via maintainer compromise):"),
      );
      for (const e of result.extendedBlast.slice(0, 10)) {
        console.log(
          `    ${e.package} ${chalk.dim(`(via ${e.entryPoint}, depth ${e.depth})`)}`,
        );
      }
      if (result.extendedBlast.length > 10) {
        console.log(
          chalk.dim(
            `    ... and ${result.extendedBlast.length - 10} more`,
          ),
        );
      }
    }

    console.log(
      chalk.red.bold(`\n  Total affected: ${result.totalAffected} packages\n`),
    );

    await closeConnection();
  });

program
  .command("lateral <package>")
  .description("Analyze maintainer overlap and lateral movement risk")
  .action(async (packageName) => {
    const spinner = ora("Analyzing maintainer overlap...").start();
    const risks = await analyzeLateralMovement(packageName);
    spinner.stop();

    console.log(
      chalk.magenta.bold(`\n  LATERAL MOVEMENT RISK: ${packageName}\n`),
    );

    if (risks.length === 0) {
      console.log(chalk.dim("  No shared maintainers found in graph"));
    }

    for (const r of risks) {
      const riskBar = chalk.red(
        "█".repeat(Math.round(r.riskScore * 20)),
      );
      const emptyBar = chalk.dim(
        "░".repeat(20 - Math.round(r.riskScore * 20)),
      );
      console.log(
        `  ${riskBar}${emptyBar} @${r.maintainer} (${r.packages.length} packages)`,
      );
      for (const p of r.packages) {
        console.log(chalk.dim(`      ${p}`));
      }
    }

    console.log();
    await closeConnection();
  });

program
  .command("exposure <package>")
  .description("Analyze temporal exposure window")
  .requiredOption(
    "--from <datetime>",
    "compromise timestamp (ISO 8601)",
  )
  .requiredOption("--to <datetime>", "detection timestamp (ISO 8601)")
  .action(async (packageName, opts) => {
    const spinner = ora("Analyzing temporal exposure...").start();
    const result = await analyzeTemporalExposure(
      packageName,
      opts.from,
      opts.to,
    );
    spinner.stop();

    console.log(
      chalk.cyan.bold(`\n  TEMPORAL EXPOSURE: ${packageName}\n`),
    );
    console.log(
      `  Window: ${result.compromisedAt} -> ${result.detectedAt}`,
    );
    console.log(
      chalk.cyan(`  Duration: ${result.windowDurationHours} hours\n`),
    );

    console.log(chalk.yellow("  Versions published in window:"));
    for (const v of result.versionsPublished) {
      console.log(`    ${v.version} (${v.publishedAt})`);
    }

    console.log(chalk.yellow(`\n  Consumers exposed: ${result.consumersExposed.length}`));
    for (const c of result.consumersExposed.slice(0, 20)) {
      console.log(`    ${c}`);
    }

    console.log();
    await closeConnection();
  });

program
  .command("typosquat <package>")
  .description("Find potential typosquat packages")
  .option("-d, --distance <number>", "max edit distance", "2")
  .action(async (packageName, opts) => {
    const spinner = ora("Scanning for typosquats...").start();
    const candidates = await findTyposquats(
      packageName,
      Number(opts.distance),
    );
    spinner.stop();

    console.log(
      chalk.yellow.bold(`\n  TYPOSQUAT CANDIDATES: ${packageName}\n`),
    );

    if (candidates.length === 0) {
      console.log(chalk.dim("  No typosquat candidates found in graph"));
    }

    for (const c of candidates) {
      const tag = chalk.dim(`[${c.type}]`);
      const dist = chalk.yellow(`d=${c.distance}`);
      console.log(`  ${tag} ${c.suspect} ${dist}`);
    }

    console.log();
    await closeConnection();
  });

program.parseAsync().catch((err) => {
  console.error(chalk.red(err.message));
  process.exit(1);
});
