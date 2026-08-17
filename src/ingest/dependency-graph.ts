import neo4j from "neo4j-driver";
import { runQuery } from "../db/connection.js";
import { QUERIES } from "../db/queries.js";
import { IdRegistry } from "../db/id-registry.js";
import { fetchPackage, type NpmPackageData } from "./npm-registry.js";

/**
 * HydraDB requires an integer node id, and neo4j-driver encodes a bare JS
 * number as a Float. Every id must therefore be wrapped as a driver Integer or
 * the write is rejected with "node id property must be an integer".
 */
const int = neo4j.int;

interface PackageRow {
  id: ReturnType<typeof int>;
  name: string;
  description: string;
  latestVersion: string;
}
interface MaintainerRow {
  id: ReturnType<typeof int>;
  username: string;
  email: string;
}
interface VersionRow {
  id: ReturnType<typeof int>;
  package: string;
  version: string;
  publishedAt: string;
}
interface EdgeRow {
  src: ReturnType<typeof int>;
  dst: ReturnType<typeof int>;
  eid: ReturnType<typeof int>;
}

/**
 * Accumulates rows during a crawl and flushes them to HydraDB in batches via
 * the UNWIND upsert queries. Batching is the ingestion path HydraDB actually
 * supports (per-row CREATE of a lone node is not executable), and it keeps the
 * round-trip count bounded regardless of graph size.
 */
export class IngestBuffer {
  private packages = new Map<string, PackageRow>();
  private maintainers = new Map<string, MaintainerRow>();
  private versions = new Map<string, VersionRow>();
  private dependsOn: EdgeRow[] = [];
  private dependedOnBy: EdgeRow[] = [];
  private publishes: EdgeRow[] = [];
  private hasVersion: EdgeRow[] = [];

  constructor(private readonly registry: IdRegistry) {}

  addPackage(name: string, description = "", latestVersion = ""): number {
    const id = this.registry.id("package", name);
    // Keep the richest record: a package first seen as a bare dependency may
    // later be fetched with full metadata.
    const existing = this.packages.get(name);
    if (!existing || description || latestVersion) {
      this.packages.set(name, {
        id: int(id),
        name,
        description: description || existing?.description || "",
        latestVersion: latestVersion || existing?.latestVersion || "",
      });
    }
    return id;
  }

  addMaintainer(username: string, email = ""): number {
    const id = this.registry.id("maintainer", username);
    this.maintainers.set(username, { id: int(id), username, email });
    return id;
  }

  addVersion(pkg: string, version: string, publishedAt: string): number {
    const key = `${pkg}@${version}`;
    const id = this.registry.id("version", key);
    this.versions.set(key, {
      id: int(id),
      package: pkg,
      version,
      publishedAt,
    });
    return id;
  }

  addDependency(fromPkg: string, toPkg: string): void {
    this.dependsOn.push({
      src: int(this.registry.id("package", fromPkg)),
      dst: int(this.registry.id("package", toPkg)),
      eid: int(this.registry.edgeId("DEPENDS_ON", fromPkg, toPkg)),
    });
    // Materialise the reverse edge as well: blast radius has to traverse
    // outward from the compromised package, and HydraDB's variable-length
    // MATCH cannot walk an inbound pattern (the source must hold the id).
    this.dependedOnBy.push({
      src: int(this.registry.id("package", toPkg)),
      dst: int(this.registry.id("package", fromPkg)),
      eid: int(this.registry.edgeId("DEPENDED_ON_BY", toPkg, fromPkg)),
    });
  }

  addPublishes(username: string, pkg: string): void {
    this.publishes.push({
      src: int(this.registry.id("maintainer", username)),
      dst: int(this.registry.id("package", pkg)),
      eid: int(this.registry.edgeId("PUBLISHES", username, pkg)),
    });
  }

  addHasVersion(pkg: string, versionKey: string): void {
    this.hasVersion.push({
      src: int(this.registry.id("package", pkg)),
      dst: int(this.registry.id("version", versionKey)),
      eid: int(this.registry.edgeId("HAS_VERSION", pkg, versionKey)),
    });
  }

  counts() {
    return {
      packages: this.packages.size,
      maintainers: this.maintainers.size,
      versions: this.versions.size,
      dependencyEdges: this.dependsOn.length,
      publishesEdges: this.publishes.length,
    };
  }

  /** Flush all buffered rows to HydraDB. Nodes before edges, so MERGE-by-id on
   * an edge endpoint always finds a node that already carries its properties. */
  async flush(batchSize = 500): Promise<void> {
    await this.flushRows("packages", QUERIES.upsertPackages, [...this.packages.values()], batchSize);
    await this.flushRows("maintainers", QUERIES.upsertMaintainers, [...this.maintainers.values()], batchSize);
    await this.flushRows("versions", QUERIES.upsertVersions, [...this.versions.values()], batchSize);
    await this.flushRows("dependency-edges", QUERIES.upsertDependencyEdges, this.dependsOn, batchSize);
    await this.flushRows("reverse-dependency-edges", QUERIES.upsertReverseDependencyEdges, this.dependedOnBy, batchSize);
    await this.flushRows("publishes-edges", QUERIES.upsertPublishesEdges, this.publishes, batchSize);
    await this.flushRows("has-version-edges", QUERIES.upsertHasVersionEdges, this.hasVersion, batchSize);
  }

  private async flushRows(
    stage: string,
    query: string,
    rows: unknown[],
    batchSize: number,
  ): Promise<void> {
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      try {
        await runQuery(query, { rows: batch });
      } catch (err: unknown) {
        const e = err as { code?: string; message?: string };
        // Annotate with which stage and a sample row so a failure names itself
        // instead of collapsing into HydraDB's generic wrapper message.
        const sample = JSON.stringify(batch[0], (_k, v) =>
          typeof v === "object" && v && "toNumber" in v
            ? (v as { toNumber(): number }).toNumber()
            : v,
        );
        throw new Error(
          `flush failed at stage "${stage}" (rows ${i}..${i + batch.length}). ` +
            `HydraDB code=${e.code ?? "?"} message=${e.message ?? "?"}. ` +
            `sample row=${sample}`,
        );
      }
    }
  }
}

/**
 * Crawl a package and its transitive dependencies into the buffer. Network and
 * parsing only; the graph write happens once in buffer.flush().
 */
export async function crawlPackage(
  name: string,
  buffer: IngestBuffer,
  visited: Set<string>,
  maxDepth: number,
  currentDepth = 0,
): Promise<void> {
  if (visited.has(name) || currentDepth > maxDepth) return;
  visited.add(name);

  let pkg: NpmPackageData;
  try {
    pkg = await fetchPackage(name);
  } catch {
    // Unreachable/renamed package: record the node so edges to it still resolve.
    buffer.addPackage(name);
    return;
  }

  const latestTag = pkg["dist-tags"]?.latest ?? "";
  const latestVersion = latestTag ? pkg.versions?.[latestTag] : undefined;

  buffer.addPackage(pkg.name, pkg.description ?? "", latestTag);

  if (pkg.maintainers) {
    for (const m of pkg.maintainers) {
      buffer.addMaintainer(m.name, m.email ?? "");
      buffer.addPublishes(m.name, pkg.name);
    }
  }

  if (latestTag && pkg.time?.[latestTag]) {
    buffer.addVersion(pkg.name, latestTag, pkg.time[latestTag]);
    buffer.addHasVersion(pkg.name, `${pkg.name}@${latestTag}`);
  }

  const deps = latestVersion?.dependencies ?? {};
  for (const depName of Object.keys(deps)) {
    buffer.addPackage(depName);
    buffer.addDependency(pkg.name, depName);
    await crawlPackage(depName, buffer, visited, maxDepth, currentDepth + 1);
  }
}
