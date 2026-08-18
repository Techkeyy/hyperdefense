import { writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runQuery } from "../db/connection.js";
import { QUERIES } from "../db/queries.js";
import { IdRegistry, defaultRegistryPath } from "../db/id-registry.js";
import { analyzeBlastRadius } from "../analysis/blast-radius.js";
import { attackPaths } from "../analysis/multi-blast.js";
import { verifyLockfile } from "../remediate/verify.js";
import { buildPlan, toBlocklist } from "../remediate/plan.js";

/**
 * Pre-compute the dashboard's data into static JSON.
 *
 * The dashboard normally queries a live HydraDB, which means it only runs
 * where someone has started a container. A judge with five minutes has neither,
 * so without this the visualisation is effectively unreachable and the project
 * is judged on its README alone.
 *
 * This runs every query ONCE against a real HydraDB and writes the answers to
 * disk, so the same page can be served as a static site with no backend. The
 * numbers are therefore genuine query results, not hand-written fixtures, and
 * each file records when it was generated so a stale export is visible rather
 * than silently wrong.
 *
 * Queries run sequentially, for the reason documented in blast-radius.ts.
 */

export interface ExportManifest {
  generatedAt: string;
  packages: string[];
  /** Packages that have a precomputed blast radius, in display order. */
  featured: string[];
  note: string;
}

/** Enough packages to explore, capped so the export stays a reasonable size. */
const MAX_PACKAGES = 60;

/**
 * Names that exist only in a hand-authored fixture.
 *
 * Read from the fixture itself rather than hard-coded, so adding a near-miss to
 * the typosquat scenario cannot silently leak it into a public deploy. Only the
 * packages attributed to the fabricated account are excluded: that fixture also
 * contains real names (express, lodash, chalk) which are legitimate graph
 * members.
 */
async function syntheticNames(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const raw = await readFile("fixtures/typosquat-demo.json", "utf8");
    const snap = JSON.parse(raw) as {
      publishes?: Array<[string, string]>;
    };
    for (const [account, pkg] of snap.publishes ?? []) {
      if (account === "suspicious-actor") out.add(pkg);
    }
  } catch {
    // No fixture, nothing to exclude.
  }
  return out;
}

export async function exportStatic(
  outDir: string,
  featuredHint: string[] = [],
): Promise<{ packages: number; featured: string[] }> {
  await mkdir(outDir, { recursive: true });
  const registry = new IdRegistry(defaultRegistryPath());
  await registry.load();

  const rows = await runQuery<{ name: string }>(QUERIES.allPackageNames);
  const synthetic = await syntheticNames();
  const all = [
    ...new Set(rows.map((r) => String(r.name ?? "")).filter(Boolean)),
  ]
    // The demo ingests the typosquat fixture into the same graph, so invented
    // names like "aixos" and "debgu" sit beside real ones. Shipping those in a
    // public deploy would present fabricated packages as real npm data, with
    // nothing on screen to distinguish them. They are excluded here rather than
    // labelled, because the deploy is a shop window and the typosquat feature
    // is demonstrated by its own command against its own fixture.
    .filter((n) => !synthetic.has(n))
    .sort();

  if (all.length === 0) {
    throw new Error(
      "The graph is empty. Ingest a fixture before exporting, e.g. " +
        "npm run dev -- ingest --fixture fixtures/express.json",
    );
  }

  // Feature the packages that actually demonstrate the argument, then fill up
  // with whatever else is in the graph.
  const featured = [
    ...new Set([
      ...featuredHint.filter((p) => all.includes(p)),
      ...all.filter((p) => !featuredHint.includes(p)),
    ]),
  ].slice(0, MAX_PACKAGES);

  const done: string[] = [];
  for (const pkg of featured) {
    const blast = await analyzeBlastRadius(registry, pkg);
    if (!blast.found) continue;

    // Same shape the /api/graph endpoint returns, so the client needs no
    // second code path for rendering.
    const nodes = new Map<string, { id: string; kind: string }>();
    const links: Array<{ source: string; target: string; kind: string }> = [];
    nodes.set(pkg, { id: pkg, kind: "source" });

    for (const d of blast.downstream.slice(0, 40)) {
      nodes.set(d.name, { id: d.name, kind: "dependent" });
      links.push({ source: d.name, target: pkg, kind: "depends" });
    }
    for (const lm of blast.lateralMovement) {
      const m = `@${lm.maintainer}`;
      nodes.set(m, { id: m, kind: "maintainer" });
      links.push({ source: m, target: pkg, kind: "publishes" });
      for (const other of lm.atRiskPackages.slice(0, 40)) {
        if (!nodes.has(other)) nodes.set(other, { id: other, kind: "lateral" });
        links.push({ source: m, target: other, kind: "publishes" });
      }
    }

    await writeFile(
      join(outDir, `graph-${encodeURIComponent(pkg)}.json`),
      JSON.stringify({
        nodes: [...nodes.values()],
        links,
        stats: {
          dependencyOnly: blast.downstream.length,
          total: blast.totalAffected,
          maintainers: blast.lateralMovement.length,
        },
      }),
      "utf8",
    );
    done.push(pkg);
  }

  // A couple of representative attack paths, keyed by from|to.
  const pathPairs: Array<[string, string]> = [
    ["@tanstack/router-core", "@tanstack/react-router"],
    ["body-parser", "express"],
  ];
  const paths: Record<string, unknown> = {};
  for (const [from, to] of pathPairs) {
    if (!all.includes(from) || !all.includes(to)) continue;
    const r = await attackPaths(registry, [from], [to]);
    paths[`${from}|${to}`] = {
      paths: r.paths,
      undecodableRows: r.undecodableRows,
      error: r.native ? undefined : r.error,
    };
  }
  await writeFile(join(outDir, "paths.json"), JSON.stringify(paths), "utf8");

  // The gate, run for real against both committed lockfiles.
  const gateFor = done.includes("@tanstack/router-core")
    ? "@tanstack/router-core"
    : done[0];
  if (gateFor) {
    const blast = await analyzeBlastRadius(registry, gateFor);
    const blocklist = toBlocklist(buildPlan(gateFor, blast, ["1.0.1"]));
    const tmp = join(outDir, "_blocklist.json");
    await writeFile(tmp, JSON.stringify(blocklist), "utf8");
    const vulnerable = await verifyLockfile(
      tmp,
      "fixtures/vulnerable-app-lock.json",
    );
    const own = await verifyLockfile(tmp, "package-lock.json");
    await writeFile(
      join(outDir, "gate.json"),
      JSON.stringify({ package: gateFor, vulnerable, own }),
      "utf8",
    );
    // Scratch input for the gate, not part of the published surface.
    await rm(tmp, { force: true });
  }

  const manifest: ExportManifest = {
    generatedAt: new Date().toISOString(),
    packages: all,
    featured: done,
    note:
      "Precomputed by `hyperdefense export` from a live HydraDB. Every number " +
      "here is a real query result, captured at generatedAt, so the dashboard " +
      "can be served statically without a database.",
  };
  await writeFile(
    join(outDir, "manifest.json"),
    JSON.stringify(manifest),
    "utf8",
  );

  return { packages: all.length, featured: done };
}
