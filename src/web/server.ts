import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { runQuery, closeConnection } from "../db/connection.js";
import { QUERIES } from "../db/queries.js";
import { IdRegistry, defaultRegistryPath } from "../db/id-registry.js";
import { analyzeBlastRadius } from "../analysis/blast-radius.js";
import { attackPaths } from "../analysis/multi-blast.js";
import { analyzeTemporalExposure } from "../analysis/temporal-exposure.js";
import { verifyLockfile } from "../remediate/verify.js";
import { buildPlan, toBlocklist } from "../remediate/plan.js";
import { safeInt } from "../util/num.js";

/**
 * Read-only HTTP surface over the same analysis the CLI uses.
 *
 * Deliberately thin: every endpoint delegates to the existing analysis
 * functions rather than re-implementing a query. The dashboard is a second view
 * of one engine, not a second engine, so a number shown in the browser is the
 * same number the CLI prints.
 *
 * Queries run sequentially throughout, for the reason documented in
 * blast-radius.ts: concurrent queries corrupt the HydraDB decode.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

let registry: IdRegistry | null = null;
async function getRegistry(): Promise<IdRegistry> {
  if (!registry) {
    registry = new IdRegistry(defaultRegistryPath());
    await registry.load();
  }
  return registry;
}

function json(res: import("node:http").ServerResponse, code: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

/** Every package name in the graph, for search. */
async function allPackages(): Promise<string[]> {
  const rows = await runQuery<{ name: string }>(QUERIES.allPackageNames);
  return [
    ...new Set(rows.map((r) => String(r.name ?? "")).filter(Boolean)),
  ].sort();
}

/**
 * Nodes and edges for the visualisation, capped so a hub package cannot render
 * ten thousand nodes into a canvas and freeze the tab.
 */
async function graphFor(pkg: string, limit: number) {
  const reg = await getRegistry();
  const blast = await analyzeBlastRadius(reg, pkg);
  if (!blast.found) return null;

  type Node = { id: string; kind: "source" | "dependent" | "maintainer" | "lateral" };
  const nodes = new Map<string, Node>();
  const links: Array<{ source: string; target: string; kind: "depends" | "publishes" }> = [];

  nodes.set(pkg, { id: pkg, kind: "source" });

  for (const d of blast.downstream.slice(0, limit)) {
    nodes.set(d.name, { id: d.name, kind: "dependent" });
    links.push({ source: d.name, target: pkg, kind: "depends" });
  }

  for (const lm of blast.lateralMovement) {
    const m = `@${lm.maintainer}`;
    nodes.set(m, { id: m, kind: "maintainer" });
    links.push({ source: m, target: pkg, kind: "publishes" });
    for (const other of lm.atRiskPackages.slice(0, limit)) {
      if (!nodes.has(other)) nodes.set(other, { id: other, kind: "lateral" });
      links.push({ source: m, target: other, kind: "publishes" });
    }
  }

  return {
    nodes: [...nodes.values()],
    links,
    stats: {
      dependencyOnly: blast.downstream.length,
      total: blast.totalAffected,
      maintainers: blast.lateralMovement.length,
    },
  };
}

export async function startServer(port: number): Promise<void> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    try {
      // --- API -----------------------------------------------------------
      if (path === "/api/stats") {
        const names = await allPackages();
        return json(res, 200, { packages: names.length });
      }

      if (path === "/api/packages") {
        return json(res, 200, { packages: await allPackages() });
      }

      if (path.startsWith("/api/blast/")) {
        const pkg = decodeURIComponent(path.slice("/api/blast/".length));
        const reg = await getRegistry();
        const depth = safeInt(url.searchParams.get("depth"), 10, 1, 16);
        const blast = await analyzeBlastRadius(reg, pkg, depth);
        if (!blast.found) {
          return json(res, 404, { error: `"${pkg}" is not in the graph` });
        }
        return json(res, 200, blast);
      }

      if (path.startsWith("/api/graph/")) {
        const pkg = decodeURIComponent(path.slice("/api/graph/".length));
        const limit = safeInt(url.searchParams.get("limit"), 40, 1, 200);
        const g = await graphFor(pkg, limit);
        if (!g) return json(res, 404, { error: `"${pkg}" is not in the graph` });
        return json(res, 200, g);
      }

      if (path === "/api/paths") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        if (!from || !to) {
          return json(res, 400, { error: "from and to are required" });
        }
        const reg = await getRegistry();
        const r = await attackPaths(reg, [from], [to]);
        // Surface a decode failure rather than presenting it as "no paths".
        return json(res, 200, {
          paths: r.paths,
          undecodableRows: r.undecodableRows,
          error: r.native ? undefined : r.error,
        });
      }

      if (path.startsWith("/api/exposure/")) {
        const pkg = decodeURIComponent(path.slice("/api/exposure/".length));
        const from = url.searchParams.get("from") ?? "2026-05-11T00:00:00Z";
        const to = url.searchParams.get("to") ?? "2026-05-12T00:00:00Z";
        const reg = await getRegistry();
        return json(res, 200, await analyzeTemporalExposure(reg, pkg, from, to));
      }

      if (path.startsWith("/api/gate/")) {
        // Runs the real gate against the two committed lockfiles, so the
        // dashboard shows a genuine pass and a genuine fail.
        const pkg = decodeURIComponent(path.slice("/api/gate/".length));
        const reg = await getRegistry();
        const blast = await analyzeBlastRadius(reg, pkg);
        if (!blast.found) return json(res, 404, { error: "not in graph" });
        const plan = buildPlan(pkg, blast, ["1.0.1"]);
        const blocklist = toBlocklist(plan);

        const tmp = join(PUBLIC, "..", ".gate-blocklist.json");
        const { writeFile } = await import("node:fs/promises");
        await writeFile(tmp, JSON.stringify(blocklist), "utf8");

        const vulnerable = await verifyLockfile(
          tmp,
          "fixtures/vulnerable-app-lock.json",
        );
        const own = await verifyLockfile(tmp, "package-lock.json");
        return json(res, 200, { vulnerable, own });
      }

      // --- static --------------------------------------------------------
      const file = path === "/" ? "index.html" : path.replace(/^\/+/, "");
      // Contain path traversal: resolve and confirm it stayed under PUBLIC.
      const resolved = join(PUBLIC, file);
      if (!resolved.startsWith(PUBLIC)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      const body = await readFile(resolved);
      res.writeHead(200, {
        "Content-Type": MIME[extname(resolved)] ?? "application/octet-stream",
      });
      res.end(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (path.startsWith("/api/")) {
        // Never let an API failure look like an empty result.
        return json(res, 500, { error: message });
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));

  process.on("SIGINT", async () => {
    server.close();
    await closeConnection();
    process.exit(0);
  });
}
