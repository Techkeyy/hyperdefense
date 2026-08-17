# HydraDB Cypher: the executable subset

Derived from HydraDB source, not from error messages or guesses:
[`src/query/opencypher.rs`](https://github.com/hydra-db/hydradb/blob/main/src/query/opencypher.rs),
[`src/query/path_procedure.rs`](https://github.com/hydra-db/hydradb/blob/main/src/query/path_procedure.rs),
and the correctness suite
[`examples/query_correctness.rs`](https://github.com/hydra-db/hydradb/blob/main/examples/query_correctness.rs).
This is the contract the query layer is written against.

## The one fact that reshapes everything

**Node identity is a non-negative integer `id`, not a string, and not a label.**
`node id property must be an integer`; `node id cannot be negative`. Labels and
other properties are decoration you attach with SET, never identity.

Consequence for HyperDefense: a package is not identified by its name. Each
package, maintainer, and version gets a stable integer id (a hash or a counter),
and `name` becomes a settable string property. The name-to-id mapping is the
ingester's job and must be deterministic so re-ingestion is idempotent.

## Two execution engines, chosen by statement shape

The parser routes each statement to one of two engines. A statement that fits
neither is rejected. This is why single-statement Cypher that "should work" does
not: it has to match one of these shapes exactly.

### 1. Row engine — reads

Shape: `MATCH ... [WITH ...] RETURN ...`. Rules, each verified in source:

- **RETURN projects only**: `count(*)`, `binding.id`, `binding.property`, or an
  aggregate over those. `RETURN *` and `RETURN n` (whole node) are rejected
  ("RETURN currently supports <binding>.<property> or count(*)").
- **Aggregates**: `count`, `sum`, `avg`, `collect`. No `min`/`max`. **No
  `DISTINCT` inside any aggregate** ("DISTINCT aggregate arguments are not
  executable"). De-duplication is the client's job.
- **Anonymous nodes may filter on `id` only.** A label or any non-id property
  forces a named node: `node labels and non-id properties require a named node`.
  So `MATCH ({id: 5})-...` is fine, `MATCH (:Package)-...` is not,
  `MATCH (p:Package)-...` is.
- **Variable-length paths** work: `-[:T*1..N]->`, both directions. This is the
  blast-radius primitive, straight from the correctness suite:
  `MATCH (u {id: 1})-[:E*1..N]->(v) RETURN v.id`.
- `ORDER BY`, `SKIP`, `LIMIT` supported. `WITH` is pass-through identifiers only,
  no DISTINCT/WHERE/ORDER BY/SKIP/LIMIT on it.
- `UNION` supported for reads; no mixing UNION and UNION ALL.
- `OPTIONAL MATCH` supported for reads.
- Property predicate values: integer, float, boolean, string literals, or a
  parameter. A **list parameter cannot appear in a predicate** ("composite
  parameter is only supported as an UNWIND input"), so `WHERE x IN $list` is out;
  feed lists through UNWIND instead.

### 2. Mutation engine — writes

A write statement is exactly one of these, with no trailing clauses:

**a. Single one-hop edge CREATE/MERGE** (the README's canonical form):

```cypher
CREATE (a {id: 1})-[:FOLLOWS]->(b {id: 2})
```

`only one-hop edge patterns are executable`. Endpoints identified by integer id.
Bare single-node `CREATE (n:Label {...})` is NOT accepted here; a lone node is
created via the UNWIND vertex-upsert form below.

**b. `MATCH ... SET/DELETE/REMOVE`** for updates on already-matched nodes/edges.
No OPTIONAL MATCH, no hints, cannot continue with RETURN/WITH after the write.

**c. UNWIND batches** — the bulk ingestion path, and the one HyperDefense uses.
Four accepted forms:

Vertex upsert (the node writer). MERGE matches on id only; labels and properties
are applied with SET:

```cypher
UNWIND $rows AS row
MERGE (n {id: row.id})
SET n:Package, n.name = row.name, n.publishedAt = row.publishedAt
```

The engine has two built-in merge policies usable here:
- an **update-if-newer guard** (a reserved SET marker) so a later publish
  timestamp wins — directly useful for the temporal layer
- a **create-only marker** so a field is written once and never overwritten

Edge upsert (the relationship writer), one fixed type, no properties on the rel,
endpoints by id field:

```cypher
UNWIND $rows AS row
MERGE (a {id: row.src})-[:DEPENDS_ON]->(b {id: row.dst})
```

Also available: UNWIND MATCH ... CREATE (edge), UNWIND MATCH ... DELETE. Every
UNWIND batch is one-hop only, directional (no undirected), batch input must be a
`$parameter`, node patterns carry no labels and only the `id` property.

## Native path procedures — reachable, but statement must START with CALL

`CALL algo.SPpaths | algo.SSpaths | algo.MSpaths({...}) YIELD path RETURN path`.
A dedicated parser handles these; the statement must begin with `CALL` (you
cannot prefix `MATCH ... CALL`, which is what "query transport cannot authorize
an unsupported Cypher clause" meant on the first probe).

Selectors are **indexed values, not bound nodes**:

- `SPpaths`: `sourceNode` + `targetNode` (integer ids).
- `SSpaths`: `sourceNode` only.
- `MSpaths`: `sourceLabel` + `sourceProperty` + `sourceValues` (and optional
  target*), `pairwise`. Rejects `sourceNode`/`targetNode` ("use indexed
  selectors"). This is the "42 compromised packages at once" primitive.

Common options: `relTypes` (required, non-empty), `relDirection`
(incoming/outgoing/both), `maxLen` (<= server max traversal hops), `pathCount`,
`resultLimit`, `weightProp`/`costProp`/`maxCost`,
`fairRelationshipVariants` (pairwise MSpaths only).

## Connection and auth (measured, three live runs)

- Bearer auth works. `neo4j.auth.basic("neo4j", token)` also clears the planner.
  `basic("", token)` and no-auth return "invalid credentials".
- `bolt://` direct and `neo4j://` routed both connect in the devcontainer.
- Connection health check must be a valid row query, e.g.
  `MATCH (n:__HDConnCheck) RETURN count(*) AS c` (labelled anchor, count(*)
  projection). `RETURN 1`, `RETURN n`, and `MATCH (n)` are all rejected.

## What this means for the HyperDefense rewrite

1. Introduce an integer id for every node; keep a deterministic name->id map in
   the ingester. Names, versions, timestamps become properties.
2. Ingestion is UNWIND vertex-upsert (nodes) + UNWIND edge-upsert (edges), in
   batches, not per-row CREATE.
3. Use the update-if-newer SET guard for version/timestamp so re-ingest is
   idempotent and temporally correct.
4. Blast radius is `MATCH (c {id: $id})<-[:DEPENDS_ON*1..N]-(x) RETURN x.id`,
   with de-duplication in TypeScript (no DISTINCT aggregate).
5. Maintainer overlap: project `collect(other.name)` grouped per maintainer;
   dedupe client-side.
6. No `WHERE id IN $list`; drive multi-package queries through UNWIND or the
   MSpaths selector form.
7. algo.MSpaths is available for the "many compromised packages at once" query
   and is the strongest HydraDB-native story, if an index on the selector
   property exists.
