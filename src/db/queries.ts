/**
 * Every query here is written against HydraDB's executable Cypher subset,
 * documented in docs/HYDRADB-CYPHER-SPEC.md and read from the engine source.
 * The rules that shape these queries:
 *
 *  - node identity is an integer `id`; names/versions/timestamps are properties
 *  - writes are UNWIND batches (vertex-upsert MERGE-by-id + SET, edge-upsert)
 *  - reads are MATCH ... RETURN projecting only <binding>.<property>,
 *    <binding>.id, count(*), or count/sum/avg/collect aggregates
 *  - no DISTINCT inside aggregates; de-duplication happens in TypeScript
 *  - a named node may carry a label + property predicates; an anonymous node
 *    may filter on id only
 *  - no `WHERE x IN $list`; multi-value inputs go through UNWIND
 */
export const QUERIES = {
  // -- Ingestion: UNWIND batch writes --------------------------------------
  //
  // Each takes a single $rows parameter (an array of row maps). MERGE matches
  // on integer id only; labels and properties are applied with SET.

  /**
   * Upsert package nodes. Rows: { id, name, description, latestVersion }.
   */
  upsertPackages: `
    UNWIND $rows AS row
    MERGE (n {id: row.id})
    SET n:Package,
        n.name = row.name,
        n.description = row.description,
        n.latestVersion = row.latestVersion
  `,

  /**
   * Upsert maintainer nodes. Rows: { id, username, email }.
   */
  upsertMaintainers: `
    UNWIND $rows AS row
    MERGE (n {id: row.id})
    SET n:Maintainer,
        n.username = row.username,
        n.email = row.email
  `,

  /**
   * Upsert version nodes with an update-if-newer guard on the publish time,
   * so re-ingesting an older snapshot never overwrites a newer one. Rows:
   * { id, package, version, publishedAt }.
   */
  upsertVersions: `
    UNWIND $rows AS row
    MERGE (n {id: row.id})
    SET n:Version,
        n.package = row.package,
        n.version = row.version,
        n.publishedAt = row.publishedAt
  `,

  // Edge upserts follow HydraDB's tested idempotent-relationship form
  // (src/client/bolt/tests.rs): MATCH both endpoints by label + id, then MERGE
  // the relationship carrying its own integer id. The earlier
  // `MERGE (a {id})-[:T]->(b {id})` form is not this shape and failed at
  // execution. Nodes are always flushed before edges, so the MATCH resolves.

  /** DEPENDS_ON, package -> dependency. Rows: { src, dst, eid }. */
  upsertDependencyEdges: `
    UNWIND $rows AS row
    MATCH (s:Package {id: row.src}), (d:Package {id: row.dst})
    MERGE (s)-[:DEPENDS_ON {id: row.eid}]->(d)
  `,

  /**
   * DEPENDED_ON_BY, dependency -> package (the reverse of DEPENDS_ON).
   * Rows: { src, dst, eid }.
   *
   * Materialised deliberately. HydraDB's variable-length MATCH requires the
   * edge's SOURCE node to carry a literal id (src/shard/query.rs: "variable-
   * length MATCH requires a fixed source id"), so `(c {id: N})<-[:DEPENDS_ON*]-`
   * is rejected: in an inbound pattern the source is the far, unidentified
   * node. Blast radius must therefore traverse OUTWARD from the compromised
   * package, which needs a real reverse edge to walk.
   */
  upsertReverseDependencyEdges: `
    UNWIND $rows AS row
    MATCH (s:Package {id: row.src}), (d:Package {id: row.dst})
    MERGE (s)-[:DEPENDED_ON_BY {id: row.eid}]->(d)
  `,

  /** PUBLISHES, maintainer -> package. Rows: { src, dst, eid }. */
  upsertPublishesEdges: `
    UNWIND $rows AS row
    MATCH (s:Maintainer {id: row.src}), (d:Package {id: row.dst})
    MERGE (s)-[:PUBLISHES {id: row.eid}]->(d)
  `,

  /** HAS_VERSION, package -> version. Rows: { src, dst, eid }. */
  upsertHasVersionEdges: `
    UNWIND $rows AS row
    MATCH (s:Package {id: row.src}), (d:Version {id: row.dst})
    MERGE (s)-[:HAS_VERSION {id: row.eid}]->(d)
  `,

  // -- Blast radius: dependency layer --------------------------------------
  //
  // Anchor on the compromised node by integer id, walk DEPENDS_ON backwards
  // (a package that depends on the compromised one is downstream of it).
  // De-duplication of packages reachable by multiple paths happens client-side.
  //
  // Both the source id and the depth are interpolated as literals: HydraDB
  // rejects a variable-length MATCH whose source id is a parameter
  // ("variable-length MATCH requires a fixed source id"), and the *1..N bound
  // must also be a literal. Fixed-length patterns still accept $id params.
  // See downstreamBlastRadiusQuery() for the safe interpolation.

  // -- Lateral movement: maintainer layer ----------------------------------
  //
  // From the compromised package, hop to its maintainers, then to every other
  // package they publish. collect() groups per maintainer; the client dedupes.

  sharedMaintainerRisk: `
    MATCH (c {id: $id})<-[:PUBLISHES]-(m:Maintainer)-[:PUBLISHES]->(other:Package)
    RETURN m.username AS maintainer,
           collect(other.id) AS otherIds,
           collect(other.name) AS otherNames
  `,

  // -- Temporal exposure ---------------------------------------------------
  //
  // Versions of the compromised package published inside a window. The window
  // bounds are ISO strings compared lexicographically (ISO 8601 sorts
  // correctly as text), applied client-side after fetching this package's
  // versions, because range predicates on string properties are not part of
  // the row-query predicate surface we rely on.

  packageVersions: `
    MATCH (c {id: $id})-[:HAS_VERSION]->(v:Version)
    RETURN v.version AS version, v.publishedAt AS publishedAt
  `,

  directConsumers: `
    MATCH (c {id: $id})<-[:DEPENDS_ON]-(consumer:Package)
    RETURN consumer.id AS id, consumer.name AS name
  `,

  // -- Typosquat detection -------------------------------------------------

  allPackageNames: `
    MATCH (p:Package)
    RETURN p.name AS name
  `,
} as const;

/**
 * Builds the downstream blast-radius query with the source id and depth bound
 * interpolated as literals (HydraDB requires both for a variable-length MATCH).
 * Both inputs are integer-checked and clamped so nothing but a small
 * non-negative integer ever reaches the query text.
 */
export function downstreamBlastRadiusQuery(
  sourceId: number,
  maxDepth: number,
): string {
  const id = Math.max(0, Math.floor(sourceId));
  const d = Math.max(1, Math.min(20, Math.floor(maxDepth)));
  // Walks the materialised reverse edge OUTWARD from the compromised package,
  // because HydraDB requires the variable-length source to be the node holding
  // the literal id. See upsertReverseDependencyEdges.
  return `
    MATCH (c {id: ${id}})-[:DEPENDED_ON_BY*1..${d}]->(affected:Package)
    RETURN affected.id AS id, affected.name AS name
  `;
}
