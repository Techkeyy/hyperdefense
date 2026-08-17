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
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildPlan, toBlocklist } from "./remediate/plan.js";
import {
  renderOverrides,
  renderWorkflow,
  renderSummary,
} from "./remediate/artifacts.js";
import { verifyLockfile } from "./remediate/verify.js";
import { SEED_PACKAGES } from "./ingest/npm-registry.js";
import { analyzeBlastRadius } from "./analysis/blast-radius.js";
import { attackPaths } from "./analysis/multi-blast.js";
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
  .command("blast-many <packages...>")
  .description("Combined blast radius for several compromised packages")
  .option("-d, --depth <number>", "max traversal depth", "5")
  .action(async (packageNames: string[], opts) => {
    const registry = new IdRegistry(defaultRegistryPath());
    await registry.load();
    const depth = Number(opts.depth);

    const spinner = ora(`Traversing ${packageNames.length} sources...`).start();
    // Union of per-package traversals, NOT algo.MSpaths. The procedure returns
    // shortest paths per pair, which under-counts the reachable set: measured
    // here it reported 4 affected where the true answer was 5. An under-count
    // in a security tool is the worst kind of wrong, so correctness wins.
    const affected = new Set<string>();
    const found: string[] = [];
    for (const pkg of packageNames) {
      const single = await analyzeBlastRadius(registry, pkg, depth);
      if (!single.found) continue;
      found.push(pkg);
      for (const d of single.downstream) affected.add(d.name);
      for (const lm of single.lateralMovement) {
        for (const p of lm.atRiskPackages) affected.add(p);
      }
    }
    spinner.stop();

    if (found.length === 0) {
      console.log(
        chalk.yellow(
          "\n  None of those packages are in the graph. Ingest them first.\n",
        ),
      );
      await closeConnection();
      return;
    }

    // Sources are compromised by definition, not "affected by" the incident.
    for (const s of found) affected.delete(s);

    console.log(
      chalk.red.bold(
        `\n  COMBINED BLAST RADIUS (${found.length} compromised packages)\n`,
      ),
    );
    console.log(chalk.dim(`  sources: ${found.join(", ")}\n`));
    console.log(
      `  ${chalk.red.bold(String(affected.size))} distinct packages exposed`,
    );
    for (const name of [...affected].sort().slice(0, 40)) {
      console.log(`    ${chalk.red("•")} ${name}`);
    }
    if (affected.size > 40) {
      console.log(chalk.dim(`    ... and ${affected.size - 40} more`));
    }
    console.log();
    await closeConnection();
  });

program
  .command("attack-path <compromised...>")
  .description(
    "How a compromise reaches a service: concrete chains via algo.MSpaths",
  )
  .requiredOption("--to <targets...>", "the package(s) you care about")
  .option("-d, --depth <number>", "max path length", "6")
  .option("-n, --paths <number>", "max paths per source-target pair", "5")
  .action(async (compromised: string[], opts) => {
    const registry = new IdRegistry(defaultRegistryPath());
    await registry.load();

    const spinner = ora("algo.MSpaths...").start();
    const t0 = Date.now();
    const { paths, native } = await attackPaths(
      registry,
      compromised,
      opts.to,
      Number(opts.depth),
      Number(opts.paths),
    );
    const ms = Date.now() - t0;
    spinner.stop();

    console.log(chalk.red.bold(`\n  ATTACK PATHS\n`));
    if (!native) {
      console.log(chalk.yellow("  algo.MSpaths unavailable here.\n"));
      await closeConnection();
      return;
    }
    if (paths.length === 0) {
      console.log(
        chalk.green(
          `  No path from ${compromised.join(", ")} to ${opts.to.join(", ")} ` +
            `within ${opts.depth} hops.\n`,
        ),
      );
      await closeConnection();
      return;
    }

    console.log(
      chalk.dim(`  ${paths.length} path(s), ${ms}ms, one native call\n`),
    );
    for (const p of paths.slice(0, 20)) {
      const chain = p.chain
        .map((n, i) =>
          i === 0
            ? chalk.red.bold(n)
            : i === p.chain.length - 1
              ? chalk.yellow.bold(n)
              : n,
        )
        .join(chalk.dim(" -> "));
      console.log(`  ${chalk.dim(`${p.hops} hops:`)} ${chain}`);
    }
    if (paths.length > 20) {
      console.log(chalk.dim(`  ... and ${paths.length - 20} more`));
    }
    console.log(
      chalk.dim(
        `\n  Each chain names the intermediate package that pulls in the bad\n` +
          `  code, which is where the link can be cut.\n`,
      ),
    );
    await closeConnection();
  });

program
  .command("demo")
  .description(
    "Run the whole story on committed fixtures: offline and deterministic",
  )
  .action(async () => {
    const step = (n: number, title: string) =>
      console.log(
        chalk.bold.cyan(`\n${"═".repeat(64)}\n  ${n}. ${title}\n${"═".repeat(64)}`),
      );

    const registry = new IdRegistry(defaultRegistryPath());
    await registry.load();

    // 1. Offline ingest from the real-npm fixture.
    step(1, "Ingest the TanStack compromise graph (real npm data, offline)");
    const snapshot = await loadSnapshot("fixtures/tanstack.json");
    const buffer = new IngestBuffer(registry);
    replaySnapshot(snapshot, buffer);
    await buffer.flush();
    await registry.save();
    const c = buffer.counts();
    console.log(
      `  captured ${snapshot.meta.capturedAt}\n` +
        `  ${c.packages} packages, ${c.maintainers} maintainers, ${c.versions} versions\n` +
        `  ${c.dependencyEdges} DEPENDS_ON, ${c.reverseDependencyEdges} DEPENDED_ON_BY, ` +
        `${c.publishesEdges} PUBLISHES`,
    );

    const target = "@tanstack/router-core";

    // 2. The comparison that is the whole point.
    step(2, `Blast radius: ${target}`);
    const blast = await analyzeBlastRadius(registry, target);
    console.log(
      `  Dependency layer alone: ${chalk.yellow(String(blast.downstream.length))}`,
    );
    for (const d of blast.downstream) console.log(`    - ${d.name}`);
    console.log(
      `\n  Reachable via shared maintainer accounts: ${chalk.red.bold(
        String(blast.totalAffected - blast.downstream.length),
      )} more`,
    );
    for (const lm of blast.lateralMovement.slice(0, 3)) {
      console.log(
        `    @${lm.maintainer} owns ${lm.atRiskPackages.length} other packages`,
      );
    }
    console.log(
      chalk.red.bold(
        `\n  ${blast.totalAffected} packages exposed, vs ${blast.downstream.length} ` +
          `a dependency-only scanner reports`,
      ),
    );

    // 3. The native multi-source query. Real incidents hit dozens of packages
    // at once, and this is the one HydraDB primitive that answers that shape
    // directly rather than looping.
    step(3, "How does it reach me? (native algo.MSpaths)");
    const tPaths = Date.now();
    const { paths } = await attackPaths(
      registry,
      ["@tanstack/router-core", "@tanstack/history"],
      ["@tanstack/react-router"],
      6,
      5,
    );
    const pathsMs = Date.now() - tPaths;
    console.log(
      chalk.dim(
        `  "blast" says WHAT is exposed. This says HOW the code arrives,\n` +
          `  which is where a responder can actually cut the link.\n`,
      ),
    );
    console.log(
      `  ${paths.length} path(s) into @tanstack/react-router ` +
        chalk.dim(`(${pathsMs}ms, one native call)`),
    );
    for (const p of paths.slice(0, 5)) {
      const chain = p.chain
        .map((n, i) =>
          i === 0
            ? chalk.red.bold(n)
            : i === p.chain.length - 1
              ? chalk.yellow.bold(n)
              : n,
        )
        .join(chalk.dim(" -> "));
      console.log(`    ${chalk.dim(`${p.hops} hops:`)} ${chain}`);
    }

    // Reset the connection after the path-procedure query. See blast-many:
    // a query following one that returned Bolt Path values was failing to
    // decode, and a fresh driver avoids it.
    await closeConnection();

    // 4. Temporal layer.
    step(4, "Temporal exposure window");
    const exposure = await analyzeTemporalExposure(
      registry,
      target,
      "2026-05-01T00:00:00Z",
      "2026-12-31T00:00:00Z",
    );
    console.log(
      `  window ${exposure.windowDurationHours}h, ` +
        `${exposure.versionsPublished.length} version(s) published inside it, ` +
        `${exposure.consumersExposed.length} consumer(s) could have resolved them`,
    );
    for (const v of exposure.versionsPublished) {
      console.log(`    ${v.version} at ${v.publishedAt}`);
    }

    // 4. Generate the fix.
    step(5, "Generate remediation artifacts");
    const plan = buildPlan(target, blast, ["1.0.1"]);
    const blocklist = toBlocklist(plan);
    await mkdir(".hyperdefense", { recursive: true });
    await writeFile(
      ".hyperdefense/blocklist.json",
      `${JSON.stringify(blocklist, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      ".hyperdefense/supply-chain-gate.yml",
      renderWorkflow(plan),
      "utf8",
    );
    console.log(
      `  blocked outright: ${Object.keys(blocklist.blocked).join(", ")}\n` +
        `  flagged for review: ${Object.keys(blocklist.review).length} packages\n` +
        `  wrote .hyperdefense/blocklist.json and supply-chain-gate.yml`,
    );

    // 5. The gate, both outcomes. A gate only trusted if it can fail.
    step(6, "Enforce it in CI (both outcomes)");
    const vuln = await verifyLockfile(
      ".hyperdefense/blocklist.json",
      "fixtures/vulnerable-app-lock.json",
    );
    console.log(
      chalk.red.bold(`  FAIL  vulnerable app (synthetic fixture)`) +
        chalk.dim(`  exit 1, merge blocked`),
    );
    for (const v of vuln.violations) {
      console.log(chalk.red(`    ${v.package}@${v.version}`) + chalk.dim(` (${v.path})`));
    }
    const own = await verifyLockfile(
      ".hyperdefense/blocklist.json",
      "package-lock.json",
    );
    console.log(
      chalk.green.bold(
        `\n  PASS  this repo (${own.packagesScanned} resolved packages scanned)`,
      ) + chalk.dim("  exit 0"),
    );

    // 6. Typosquat, on the fixture built to exercise it.
    step(7, "Typosquat detection");
    const tsSnap = await loadSnapshot("fixtures/typosquat-demo.json");
    const tsBuffer = new IngestBuffer(registry);
    replaySnapshot(tsSnap, tsBuffer);
    await tsBuffer.flush();
    await registry.save();
    console.log(chalk.dim(`  ${tsSnap.meta.provenance.split(".")[0]}.\n`));
    const squats = await findTyposquats("express", 2);
    console.log(`  near-misses for "express": ${squats.length}`);
    for (const s of squats.slice(0, 6)) {
      console.log(`    ${s.suspect}  ${chalk.dim(`[${s.type}] distance ${s.distance}`)}`);
    }

    console.log(
      chalk.bold.cyan(`\n${"═".repeat(64)}`) +
        chalk.dim(
          `\n  Every number above came from HydraDB traversals over committed\n` +
            `  fixtures. No network, fully reproducible.\n`,
        ),
    );
    await closeConnection();
  });

program
  .command("remediate <package>")
  .description(
    "Generate the fix: blocklist, npm overrides, and a CI gate workflow",
  )
  .option(
    "--bad-versions <versions...>",
    "versions named as malicious (blocked outright)",
  )
  .option(
    "--safe-version <version>",
    "known-good version to pin to; without it no override is generated",
  )
  .option("-o, --out <dir>", "write artifacts to this directory")
  .action(async (packageName, opts) => {
    const spinner = ora(`Building remediation for ${packageName}...`).start();
    const registry = new IdRegistry(defaultRegistryPath());
    await registry.load();
    const blast = await analyzeBlastRadius(registry, packageName);
    spinner.stop();

    if (!blast.found) {
      console.log(
        chalk.yellow(
          `\n  "${packageName}" is not in the graph. Ingest it first.\n`,
        ),
      );
      await closeConnection();
      return;
    }

    const plan = buildPlan(packageName, blast, opts.badVersions ?? []);
    const blocklist = toBlocklist(plan);
    const overrides = renderOverrides(plan, opts.safeVersion);
    const workflow = renderWorkflow(plan);

    console.log(chalk.red.bold(`\n  REMEDIATION: ${packageName}\n`));
    console.log(renderSummary(plan));

    if (opts.out) {
      const dir = opts.out as string;
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "blocklist.json"),
        `${JSON.stringify(blocklist, null, 2)}\n`,
        "utf8",
      );
      await writeFile(join(dir, "supply-chain-gate.yml"), workflow, "utf8");
      const written = ["blocklist.json", "supply-chain-gate.yml"];
      if (overrides.applicable) {
        await writeFile(join(dir, "overrides.json"), overrides.content, "utf8");
        written.push("overrides.json");
      }
      console.log(chalk.green(`  Wrote ${written.join(", ")} to ${dir}\n`));
    } else {
      console.log(chalk.bold("  blocklist.json"));
      console.log(chalk.dim(JSON.stringify(blocklist, null, 2)));
      console.log(chalk.bold("\n  CI gate (supply-chain-gate.yml)"));
      console.log(chalk.dim(workflow));
    }

    console.log(
      overrides.applicable
        ? chalk.bold("  npm overrides\n") +
            chalk.dim(overrides.content) +
            chalk.dim(`  ${overrides.note}\n`)
        : chalk.yellow(`  ${overrides.note}\n`),
    );

    if (!opts.out) {
      console.log(
        chalk.dim(
          `  Write these to disk with:\n` +
            chalk.cyan(
              `    npm run dev -- remediate ${packageName} --out .hyperdefense\n`,
            ),
        ),
      );
    }

    await closeConnection();
  });

program
  .command("verify")
  .description(
    "CI gate: fail the build if a blocked package version is in the lockfile",
  )
  .requiredOption("-b, --blocklist <path>", "blocklist.json from remediate")
  .option("-l, --lockfile <path>", "path to package-lock.json", "package-lock.json")
  .action(async (opts) => {
    let result;
    try {
      result = await verifyLockfile(opts.blocklist, opts.lockfile);
    } catch (err) {
      console.error(
        chalk.red(
          `  verify could not run: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      process.exit(2); // distinct from a policy failure
    }

    console.log(
      chalk.dim(
        `\n  Scanned ${result.packagesScanned} resolved packages in ${opts.lockfile}\n`,
      ),
    );

    if (result.reviewHits.length > 0) {
      console.log(
        chalk.yellow(
          `  ${result.reviewHits.length} package(s) flagged for review (not blocking):`,
        ),
      );
      for (const r of result.reviewHits.slice(0, 15)) {
        const via = r.via?.length ? chalk.dim(` via @${r.via.join(", @")}`) : "";
        console.log(`    ${r.package}@${r.version}${via}`);
      }
      if (result.reviewHits.length > 15) {
        console.log(chalk.dim(`    ... and ${result.reviewHits.length - 15} more`));
      }
      console.log();
    }

    if (result.ok) {
      console.log(chalk.green.bold("  PASS  no blocked versions resolved\n"));
      return;
    }

    console.log(
      chalk.red.bold(`  FAIL  ${result.violations.length} blocked version(s) resolved:\n`),
    );
    for (const v of result.violations) {
      console.log(chalk.red(`    ${v.package}@${v.version}`) + chalk.dim(`  (${v.path})`));
    }
    console.log();
    process.exit(1); // fails the CI check
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

    console.log(
      chalk.dim(`  ${result.versionsKnown} versions known for this package\n`),
    );

    // Directly answers the track's "which version introduced the vulnerability"
    // and gives the responder the version to pin back to.
    if (result.firstSuspectVersion) {
      console.log(
        chalk.red.bold(`  First suspect version: `) +
          chalk.red(
            `${result.firstSuspectVersion.version} (${result.firstSuspectVersion.publishedAt})`,
          ),
      );
    }
    if (result.lastCleanVersion) {
      console.log(
        chalk.green.bold(`  Last clean version:    `) +
          chalk.green(
            `${result.lastCleanVersion.version} (${result.lastCleanVersion.publishedAt})`,
          ),
      );
      console.log(
        chalk.dim(
          `  Pin to ${result.lastCleanVersion.version}: ` +
            `npm run dev -- remediate ${packageName} --safe-version ${result.lastCleanVersion.version}`,
        ),
      );
    }

    console.log(
      chalk.yellow(
        `\n  Versions published in window (${result.versionsPublished.length}):`,
      ),
    );
    for (const v of result.versionsPublished.slice(0, 25)) {
      console.log(`    ${v.version} (${v.publishedAt})`);
    }
    if (result.versionsPublished.length > 25) {
      console.log(
        chalk.dim(`    ... and ${result.versionsPublished.length - 25} more`),
      );
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
