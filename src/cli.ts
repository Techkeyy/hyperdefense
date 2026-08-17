#!/usr/bin/env node
import { program } from "commander";
import chalk from "chalk";
import ora from "ora";
import { closeConnection } from "./db/connection.js";
import { initSchema } from "./db/schema.js";
import { IngestBuffer, crawlPackage } from "./ingest/dependency-graph.js";
import { IdRegistry, defaultRegistryPath } from "./db/id-registry.js";
import {
  RawGraph,
  replaySnapshot,
  saveSnapshot,
  loadSnapshot,
} from "./ingest/snapshot.js";
import { SEED_PACKAGES } from "./ingest/npm-registry.js";
import { analyzeBlastRadius } from "./analysis/blast-radius.js";
import { analyzeLateralMovement } from "./analysis/lateral-movement.js";
import { analyzeTemporalExposure } from "./analysis/temporal-exposure.js";
import { findTyposquats } from "./analysis/typosquat.js";
import { findWorkingConnection, runProbes } from "./doctor/probe.js";
import { probeRegistry } from "./doctor/registry-probe.js";
import { writeCapabilityReport } from "./doctor/report.js";
import { runWriteProbe } from "./doctor/write-probe.js";

program
  .name("hyperdefense")
  .description(
    "Multi-graph supply chain blast radius engine built on HydraDB",
  )
  .version("0.1.0");

program
  .command("doctor")
  .description(
    "Probe HydraDB and the npm registry, and write the capability matrix",
  )
  .option("--skip-registry", "skip the npm registry payload check")
  .option(
    "-o, --out <path>",
    "where to write the matrix",
    "docs/CAPABILITIES.md",
  )
  .action(async (opts) => {
    console.log(chalk.bold("\n  HyperDefense doctor\n"));

    const spinner = ora("Finding a working connection...").start();
    const conn = await findWorkingConnection();

    if (!conn.ok) {
      spinner.fail("No connection succeeded");
      console.log(
        chalk.dim(
          "\n  Every uri scheme and auth strategy was tried. Attempts:\n",
        ),
      );
      for (const a of conn.attempts) {
        console.log(
          `    ${chalk.red("x")} ${a.uri}  auth=${a.auth}\n      ${chalk.dim(
            (a.error ?? "").split("\n")[0].slice(0, 120),
          )}`,
        );
      }
      console.log(
        chalk.yellow(
          "\n  Is HydraDB running? In a Codespace it starts with the devcontainer.\n",
        ),
      );
      process.exitCode = 1;
      return;
    }

    spinner.succeed(
      `Connected: ${conn.result.uri} (auth: ${conn.result.auth})`,
    );

    const probeSpinner = ora("Probing Cypher features...").start();
    const probes = await runProbes(
      conn.result,
      process.env.HYDRA_TOKEN ?? "local-development-token-32-bytes",
    );
    probeSpinner.stop();

    console.log(chalk.bold("\n  Cypher features\n"));
    for (const p of probes) {
      const mark =
        p.status === "supported"
          ? chalk.green("ok  ")
          : p.status === "wrong-result"
            ? chalk.yellow("warn")
            : chalk.red("fail");
      console.log(`    ${mark} ${p.label}`);
      if (p.detail && p.status !== "supported") {
        console.log(chalk.dim(`         ${p.detail.slice(0, 110)}`));
      }
    }

    let registry: Awaited<ReturnType<typeof probeRegistry>> = {
      ok: true,
      checks: [],
    };
    if (!opts.skipRegistry) {
      const rSpinner = ora("Checking npm registry payload shape...").start();
      registry = await probeRegistry();
      rSpinner.stop();

      console.log(chalk.bold("\n  npm registry payload\n"));
      if (registry.error) {
        console.log(chalk.red(`    fail ${registry.error}`));
      }
      for (const c of registry.checks) {
        const mark = c.present ? chalk.green("ok  ") : chalk.red("fail");
        console.log(
          `    ${mark} ${c.field} ${chalk.dim(c.sample ? `(${c.sample})` : "")}`,
        );
      }
    }

    await writeCapabilityReport(
      { connection: conn.result, probes, registry },
      opts.out,
    );

    const failed = probes.filter((p) => p.status !== "supported");
    console.log(
      chalk.bold(
        `\n  ${probes.length - failed.length}/${probes.length} features supported`,
      ),
    );
    console.log(chalk.dim(`  Matrix written to ${opts.out}\n`));

    if (failed.length > 0) {
      console.log(
        chalk.yellow(
          "  Unsupported features found. The query layer must route around them\n" +
            "  before any traversal code is trusted.\n",
        ),
      );
    }
  });

program
  .command("debug-write")
  .description(
    "Run each write/read form in isolation and print the real HydraDB error",
  )
  .action(async () => {
    console.log(chalk.bold("\n  HyperDefense write probe\n"));
    const results = await runWriteProbe();
    for (const r of results) {
      if (r.ok) {
        console.log(`  ${chalk.green("ok  ")} ${r.step}`);
      } else {
        console.log(`  ${chalk.red("FAIL")} ${r.step}`);
        console.log(chalk.dim(`       query: ${r.query.replace(/\s+/g, " ").trim()}`));
        console.log(chalk.red(`       code:  ${r.code ?? "(none)"}`));
        console.log(chalk.red(`       error: ${r.message ?? "(none)"}`));
      }
    }
    console.log();
    await closeConnection();
  });

program
  .command("snapshot")
  .description(
    "Crawl npm once and save a replayable fixture (no HydraDB needed)",
  )
  .requiredOption("-p, --packages <names...>", "root packages to crawl")
  .requiredOption("-o, --out <path>", "where to write the fixture JSON")
  .option("-d, --depth <number>", "max dependency depth", "2")
  .option("--name <label>", "scenario name", "npm snapshot")
  .option("--incident <text>", "real incident this models, if any")
  .action(async (opts) => {
    const spinner = ora("Crawling npm...").start();
    const raw = new RawGraph();
    const visited = new Set<string>();
    const maxDepth = Number(opts.depth);

    for (const pkg of opts.packages) {
      spinner.text = `Crawling ${pkg}... (${visited.size} packages seen)`;
      await crawlPackage(pkg, raw, visited, maxDepth);
    }

    const snapshot = raw.toSnapshot({
      name: opts.name,
      incident: opts.incident,
      capturedAt: new Date().toISOString(),
      roots: opts.packages,
      provenance:
        "Captured from the public npm registry API with `hyperdefense snapshot`. " +
        "Real registry data, not synthetic: package metadata, maintainer lists, " +
        "and publish timestamps are exactly as npm served them at capturedAt.",
    });
    await saveSnapshot(snapshot, opts.out);

    const c = raw.counts();
    spinner.succeed(
      `Captured ${c.packages} packages, ${c.maintainers} maintainers, ` +
        `${c.versions} versions, ${c.dependencies} dependency edges -> ${opts.out}`,
    );
    console.log(
      chalk.dim(
        `\n  Replay it offline with:\n` +
          chalk.cyan(`    npm run dev -- ingest --fixture ${opts.out}\n`),
      ),
    );
  });

program
  .command("ingest")
  .description("Ingest npm packages into HydraDB")
  .option("-p, --packages <names...>", "specific packages to ingest")
  .option(
    "-f, --fixture <path>",
    "replay a saved snapshot instead of hitting the network",
  )
  .option(
    "-c, --count <number>",
    "number of seed packages to ingest",
    "20",
  )
  .option("-d, --depth <number>", "max dependency depth", "3")
  .action(async (opts) => {
    const spinner = ora("Initializing schema...").start();
    await initSchema();

    // Fixture path: deterministic, offline, no npm calls.
    if (opts.fixture) {
      spinner.text = `Loading fixture ${opts.fixture}...`;
      const snapshot = await loadSnapshot(opts.fixture);
      const registry = new IdRegistry(defaultRegistryPath());
      await registry.load();
      const buffer = new IngestBuffer(registry);
      replaySnapshot(snapshot, buffer);

      const fc = buffer.counts();
      spinner.text = `Writing ${fc.packages} packages to HydraDB...`;
      await buffer.flush();
      await registry.save();

      spinner.succeed(
        `Replayed "${snapshot.meta.name}" (captured ${snapshot.meta.capturedAt}): ` +
          `${fc.packages} packages, ${fc.maintainers} maintainers, ` +
          `${fc.versions} versions | edges: ${fc.dependencyEdges} DEPENDS_ON, ` +
          `${fc.reverseDependencyEdges} DEPENDED_ON_BY, ${fc.publishesEdges} PUBLISHES`,
      );
      const hint = buffer.widestBlastTarget();
      if (hint) {
        console.log(
          chalk.dim(`\n  Most-depended-on package in this graph:\n`) +
            chalk.cyan(`    npm run dev -- blast ${hint}\n`),
        );
      }
      await closeConnection();
      return;
    }

    const packages = opts.packages ?? SEED_PACKAGES.slice(0, Number(opts.count));
    const maxDepth = Number(opts.depth);
    const visited = new Set<string>();

    // The id registry persists the name -> compact-integer-id map so later
    // analysis commands (separate processes) can resolve the same ids.
    const registry = new IdRegistry(defaultRegistryPath());
    await registry.load();
    const buffer = new IngestBuffer(registry);

    // Crawl (network) into the buffer, then flush (graph write) once.
    for (const pkg of packages) {
      spinner.text = `Crawling ${pkg}... (${visited.size} packages seen)`;
      await crawlPackage(pkg, buffer, visited, maxDepth);
    }

    const c = buffer.counts();
    spinner.text = `Writing ${c.packages} packages, ${c.maintainers} maintainers, ${c.dependencyEdges} dependency edges to HydraDB...`;
    await buffer.flush();
    await registry.save();

    spinner.succeed(
      `Ingested ${c.packages} packages, ${c.maintainers} maintainers, ` +
        `${c.versions} versions | edges: ${c.dependencyEdges} DEPENDS_ON, ` +
        `${c.reverseDependencyEdges} DEPENDED_ON_BY, ` +
        `${c.publishesEdges} PUBLISHES, ${c.hasVersionEdges} HAS_VERSION`,
    );
    // Blast radius answers "who depends on X", so the crawl root has no
    // dependents by construction. Point at the most-depended-on package
    // actually present in the graph.
    const suggestion = buffer.widestBlastTarget();
    if (suggestion) {
      console.log(
        chalk.dim(
          `\n  Blast radius answers "who depends on X", so the crawl root has\n` +
            `  no dependents. Most-depended-on package in this graph:\n`,
        ) + chalk.cyan(`    npm run dev -- blast ${suggestion}\n`),
      );
    }
    await closeConnection();
  });

program
  .command("blast <package>")
  .description("Analyze blast radius of a compromised package")
  .action(async (packageName) => {
    const spinner = ora(`Analyzing blast radius for ${packageName}...`).start();
    const registry = new IdRegistry(defaultRegistryPath());
    await registry.load();
    const result = await analyzeBlastRadius(registry, packageName);
    spinner.stop();

    if (!result.found) {
      console.log(
        chalk.yellow(
          `\n  "${packageName}" is not in the graph. Ingest it first:\n` +
            `    npm run dev -- ingest --packages ${packageName}\n`,
        ),
      );
      await closeConnection();
      return;
    }

    console.log(
      chalk.red.bold(`\n  BLAST RADIUS: ${packageName}\n`),
    );

    // Downstream dependency blast radius
    console.log(
      chalk.yellow.bold(
        `  Downstream dependents (${result.downstream.length}):`,
      ),
    );
    if (result.downstream.length === 0) {
      console.log(chalk.dim("    No downstream dependents found in graph"));
    }
    for (const d of result.downstream.slice(0, 30)) {
      console.log(`    ${chalk.red("•")} ${d.name}`);
    }
    if (result.downstream.length > 30) {
      console.log(
        chalk.dim(`    ... and ${result.downstream.length - 30} more`),
      );
    }

    // Lateral movement via shared maintainers
    console.log(
      chalk.magenta.bold("\n  Lateral movement risk (shared maintainers):"),
    );
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

    // The headline comparison: a conventional scanner walks require() graphs
    // and stops at the dependency count. Modelling maintainer accounts as graph
    // nodes is what surfaces the rest, and the gap between the two numbers is
    // the exposure every dependency-only tool misses.
    const depOnly = result.downstream.length;
    const withMaintainers = result.totalAffected;
    const missed = withMaintainers - depOnly;

    console.log(chalk.bold("\n  ─────────────────────────────────────────"));
    console.log(
      `  Dependency layer alone:   ${chalk.yellow(String(depOnly))} package${depOnly === 1 ? "" : "s"}`,
    );
    console.log(
      `  + maintainer layer:       ${chalk.red.bold(String(withMaintainers))} package${withMaintainers === 1 ? "" : "s"}`,
    );
    if (missed > 0) {
      const factor = depOnly > 0 ? (withMaintainers / depOnly).toFixed(1) : null;
      console.log(
        chalk.dim(
          `  ${missed} package${missed === 1 ? "" : "s"} a dependency-only scanner misses` +
            (factor ? ` (${factor}x)` : ""),
        ),
      );
    }
    console.log(chalk.bold("  ─────────────────────────────────────────\n"));

    await closeConnection();
  });

program
  .command("lateral <package>")
  .description("Analyze maintainer overlap and lateral movement risk")
  .action(async (packageName) => {
    const spinner = ora("Analyzing maintainer overlap...").start();
    const registry = new IdRegistry(defaultRegistryPath());
    await registry.load();
    const risks = await analyzeLateralMovement(registry, packageName);
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
    const registry = new IdRegistry(defaultRegistryPath());
    await registry.load();
    const result = await analyzeTemporalExposure(
      registry,
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
