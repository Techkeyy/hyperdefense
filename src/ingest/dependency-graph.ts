import neo4j from "neo4j-driver";
import { runQuery } from "../db/connection.js";
import { QUERIES } from "../db/queries.js";
import { IdRegistry } from "../db/id-registry.js";
import { fetchPackage, type NpmPackageData } from "./npm-registry.js";
import type { GraphSink } from "./snapshot.js";

/**
 * HydraDB requires an integer node id, and neo4j-driver encodes a bare JS
 * number as a Float. Every id must therefore be wrapped as a driver Integer or
 * the write is rejected with "node id property must be an integer".
 */
const int = neo4j.int;

/**
 * How many of a package's most recent versions to ingest. Enough to cover a
 * realistic compromise window and the releases either side of it, without
 * pulling the thousands of releases some popular packages carry.
 */
export const VERSION_HISTORY_LIMIT = 60;

/**
 * A single-row write is retried this many times before its failure is treated
 * as real. Sized for the observed case: the first edge stage failing right
 * after several thousand node rows, then succeeding unchanged.
 */
const SINGLE_ROW_RETRIES = 4;
const BACKOFF_MS = 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
export class IngestBuffer implements GraphSink {
  private packages = new Map<string, PackageRow>();
  private maintainers = new Map<string, MaintainerRow>();
  private versions = new Map<string, VersionRow>();
  private dependsOn: EdgeRow[] = [];
  private dependedOnBy: EdgeRow[] = [];
  /** (from, to) package-name pairs, kept for reporting only. */
  private dependencyPairs: Array<[string, string]> = [];
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
    this.dependencyPairs.push([fromPkg, toPkg]);
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

  /**
   * A package with the most incoming DEPENDS_ON edges, i.e. the one with the
   * widest blast radius in what was just ingested. Used to suggest a useful
   * `blast` target, since the crawl root itself has no dependents.
   */
  widestBlastTarget(): string | undefined {
    const incoming = new Map<string, number>();
    for (const [fromPkg, toPkg] of this.dependencyPairs) {
      void fromPkg;
      incoming.set(toPkg, (incoming.get(toPkg) ?? 0) + 1);
    }
    let best: string | undefined;
    let bestCount = 0;
    for (const [pkg, count] of incoming) {
      if (count > bestCount) {
        best = pkg;
        bestCount = count;
      }
    }
    return best;
  }

  counts() {
    return {
      packages: this.packages.size,
      maintainers: this.maintainers.size,
      versions: this.versions.size,
      dependencyEdges: this.dependsOn.length,
      reverseDependencyEdges: this.dependedOnBy.length,
      publishesEdges: this.publishes.length,
      hasVersionEdges: this.hasVersion.length,
    };
  }

  /** Flush all buffered rows to HydraDB. Nodes before edges, so MERGE-by-id on
   * an edge endpoint always finds a node that already carries its properties. */
  async flush(batchSize = 250): Promise<void> {
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
      await this.writeBatch(stage, query, rows.slice(i, i + batchSize), i);
    }
  }

  /**
   * Write one batch, retrying on failure and halving if size looks like the
   * problem.
   *
   * Two distinct failures live here, and conflating them produced a wrong
   * diagnosis:
   *
   *  - SIZE. A large ingest intermittently returns HTTP 500 partway through the
   *    biggest write. The server suppresses the real cause, so the size it will
   *    accept cannot be looked up, only discovered by splitting.
   *  - TRANSIENCE. A write fails and the identical write succeeds moments
   *    later, most often on the first edge stage right after several thousand
   *    node rows, when the server is presumably still busy with them. Observed
   *    failing on a SINGLE row at index 0 and then succeeding on a plain re-run
   *    of the same command.
   *
   * An earlier version treated reaching a single row as proof the row itself
   * was bad, and said so ("Not a batch-size problem") before giving up. That
   * was a confident wrong answer: the row was fine and a retry fixed it. So a
   * single row is now retried with backoff before any conclusion is drawn, and
   * the message no longer asserts a cause it has not established.
   *
   * Retrying is safe because every write is a MERGE keyed on a deterministic
   * id, so re-sending rows that already landed is a no-op.
   */
  private async writeBatch(
    stage: string,
    query: string,
    batch: unknown[],
    offset: number,
    attempt = 0,
  ): Promise<void> {
    if (batch.length === 0) return;

    try {
      await runQuery(query, { rows: batch });
      return;
    } catch (err: unknown) {
      if (batch.length === 1) {
        // Give the server time to settle before blaming the data.
        if (attempt < SINGLE_ROW_RETRIES) {
          await sleep(BACKOFF_MS * (attempt + 1));
          return this.writeBatch(stage, query, batch, offset, attempt + 1);
        }
        const e = err as { code?: string; message?: string };
        const sample = JSON.stringify(batch[0], (_k, v) =>
          typeof v === "object" && v && "toNumber" in v
            ? (v as { toNumber(): number }).toNumber()
            : v,
        );
        throw new Error(
          `flush failed at stage "${stage}", row index ${offset}, after ` +
            `${SINGLE_ROW_RETRIES + 1} attempts on that row alone. ` +
            `HydraDB code=${e.code ?? "?"} message=${e.message ?? "?"}. ` +
            `row=${sample}`,
        );
      }

      const mid = Math.ceil(batch.length / 2);
      await this.writeBatch(stage, query, batch.slice(0, mid), offset);
      await this.writeBatch(stage, query, batch.slice(mid), offset + mid);
    }
  }
}

/**
 * Crawl a package and its transitive dependencies into the buffer. Network and
 * parsing only; the graph write happens once in buffer.flush().
 */
export async function crawlPackage(
  name: string,
  buffer: GraphSink,
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

  // Ingest the version HISTORY, not just the latest release.
  //
  // The track asks "which version introduced the vulnerability" and "which
  // applications resolved the compromised version while it was live". Both are
  // questions about a timeline, and a single latest-version node cannot answer
  // either. npm already returns every version's publish time in `time`, so the
  // history costs no extra requests.
  //
  // Capped at the most recent VERSION_HISTORY_LIMIT: popular packages have
  // thousands of releases, and an uncapped crawl would bloat the graph and the
  // committed fixtures for no analytical gain during an incident window.
  const times = pkg.time ?? {};
  const versionTimes = Object.entries(times)
    // `created` and `modified` are metadata keys in the same map, not versions.
    .filter(([v]) => v !== "created" && v !== "modified")
    .sort((a, b) => a[1].localeCompare(b[1]));

  const recent = versionTimes.slice(-VERSION_HISTORY_LIMIT);
  for (const [version, publishedAt] of recent) {
    buffer.addVersion(pkg.name, version, publishedAt);
    buffer.addHasVersion(pkg.name, `${pkg.name}@${version}`);
  }

  const deps = latestVersion?.dependencies ?? {};
  for (const depName of Object.keys(deps)) {
    buffer.addPackage(depName);
    buffer.addDependency(pkg.name, depName);
    await crawlPackage(depName, buffer, visited, maxDepth, currentDepth + 1);
  }
}
