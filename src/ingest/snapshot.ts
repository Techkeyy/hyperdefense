import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * What the crawler writes into. Both the live graph writer (IngestBuffer) and
 * the serializable collector (RawGraph) satisfy it, so the crawl code is
 * agnostic about whether its output goes to HydraDB or to a fixture file.
 */
export interface GraphSink {
  addPackage(name: string, description?: string, latestVersion?: string): number;
  addMaintainer(username: string, email?: string): number;
  addVersion(pkg: string, version: string, publishedAt: string): number;
  addDependency(fromPkg: string, toPkg: string): void;
  addPublishes(username: string, pkg: string): void;
  addHasVersion(pkg: string, versionKey: string): void;
}

export interface SnapshotMeta {
  /** Human label for the scenario. */
  name: string;
  /** What real incident this models, if any. */
  incident?: string;
  /** When the data was captured from npm. */
  capturedAt: string;
  /** Root packages the crawl started from. */
  roots: string[];
  /** How the data was obtained, stated plainly. */
  provenance: string;
}

export interface Snapshot {
  meta: SnapshotMeta;
  packages: Array<{ name: string; description: string; latestVersion: string }>;
  maintainers: Array<{ username: string; email: string }>;
  versions: Array<{ package: string; version: string; publishedAt: string }>;
  dependencies: Array<[string, string]>;
  publishes: Array<[string, string]>;
  hasVersion: Array<[string, string]>;
}

/**
 * Collects a crawl as plain, human-readable data. Serialised to a fixture this
 * gives a deterministic offline replay of real npm data: the demo and the tests
 * stop depending on the network, and the exact graph a result came from is
 * committed alongside the code.
 */
export class RawGraph implements GraphSink {
  private packages = new Map<
    string,
    { name: string; description: string; latestVersion: string }
  >();
  private maintainers = new Map<string, { username: string; email: string }>();
  private versions = new Map<
    string,
    { package: string; version: string; publishedAt: string }
  >();
  private dependencies: Array<[string, string]> = [];
  private publishesPairs: Array<[string, string]> = [];
  private hasVersionPairs: Array<[string, string]> = [];

  addPackage(name: string, description = "", latestVersion = ""): number {
    const existing = this.packages.get(name);
    if (!existing || description || latestVersion) {
      this.packages.set(name, {
        name,
        description: description || existing?.description || "",
        latestVersion: latestVersion || existing?.latestVersion || "",
      });
    }
    return 0; // ids are assigned at graph-write time, not here
  }

  addMaintainer(username: string, email = ""): number {
    this.maintainers.set(username, { username, email });
    return 0;
  }

  addVersion(pkg: string, version: string, publishedAt: string): number {
    this.versions.set(`${pkg}@${version}`, { package: pkg, version, publishedAt });
    return 0;
  }

  addDependency(fromPkg: string, toPkg: string): void {
    this.dependencies.push([fromPkg, toPkg]);
  }

  addPublishes(username: string, pkg: string): void {
    this.publishesPairs.push([username, pkg]);
  }

  addHasVersion(pkg: string, versionKey: string): void {
    this.hasVersionPairs.push([pkg, versionKey]);
  }

  toSnapshot(meta: SnapshotMeta): Snapshot {
    // Sorted so a re-captured fixture produces a reviewable diff rather than
    // reordered noise.
    const byName = <T extends Record<string, unknown>>(k: keyof T) =>
      (a: T, b: T) => String(a[k]).localeCompare(String(b[k]));

    return {
      meta,
      packages: [...this.packages.values()].sort(byName("name")),
      maintainers: [...this.maintainers.values()].sort(byName("username")),
      versions: [...this.versions.values()].sort(
        (a, b) =>
          a.package.localeCompare(b.package) ||
          a.version.localeCompare(b.version),
      ),
      dependencies: [...this.dependencies].sort(
        (a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]),
      ),
      publishes: [...this.publishesPairs].sort(
        (a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]),
      ),
      hasVersion: [...this.hasVersionPairs].sort(
        (a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]),
      ),
    };
  }

  counts() {
    return {
      packages: this.packages.size,
      maintainers: this.maintainers.size,
      versions: this.versions.size,
      dependencies: this.dependencies.length,
      publishes: this.publishesPairs.length,
    };
  }
}

/** Replay a captured snapshot into any sink, typically the live graph writer. */
export function replaySnapshot(snapshot: Snapshot, sink: GraphSink): void {
  for (const p of snapshot.packages) {
    sink.addPackage(p.name, p.description, p.latestVersion);
  }
  for (const m of snapshot.maintainers) {
    sink.addMaintainer(m.username, m.email);
  }
  for (const v of snapshot.versions) {
    sink.addVersion(v.package, v.version, v.publishedAt);
  }
  for (const [from, to] of snapshot.dependencies) {
    sink.addDependency(from, to);
  }
  for (const [user, pkg] of snapshot.publishes) {
    sink.addPublishes(user, pkg);
  }
  for (const [pkg, versionKey] of snapshot.hasVersion) {
    sink.addHasVersion(pkg, versionKey);
  }
}

export async function saveSnapshot(
  snapshot: Snapshot,
  path: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

export async function loadSnapshot(path: string): Promise<Snapshot> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as Snapshot;
}
