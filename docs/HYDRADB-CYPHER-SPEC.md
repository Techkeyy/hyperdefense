# HydraDB Cypher: the executable subset

Derived from HydraDB source, not from error messages or guesses:
[`src/query/opencypher.rs`](https://github.com/hydra-db/hydradb/blob/main/src/query/opencypher.rs),
[`src/query/path_procedure.rs`](https://github.com/hydra-db/hydradb/blob/main/src/query/path_procedure.rs),
and the correctness suite
[`examples/query_correctness.rs`](https://github.com/hydra-db/hydradb/blob/main/examples/query_correctness.rs).
This is the contract the query layer is written against.

Two of the source readings turned out to be wrong when run against a live
server. Rather than silently editing them, they are corrected in
[Corrections from live testing](#corrections-from-live-testing) at the end, with
the evidence. Where the two disagree, **the live result wins**.

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

### 1. Row engine: reads

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
- **Variable-length paths** work OUTBOUND only: `-[:T*1..N]->`, with the source
  node carrying a **literal** id. Straight from the correctness suite:
  `MATCH (u {id: 1})-[:E*1..N]->(v) RETURN v.id`. The inbound form
  `(c {id: N})<-[:T*1..N]-(x)` is rejected, and a `$param` id is rejected too.
  See "Corrections from live testing" (1); this reading was initially wrong and
  it changed the data model.
- `ORDER BY`, `SKIP`, `LIMIT` supported. `WITH` is pass-through identifiers only,
  no DISTINCT/WHERE/ORDER BY/SKIP/LIMIT on it.
- `UNION` supported for reads; no mixing UNION and UNION ALL.
- `OPTIONAL MATCH` supported for reads.
- Property predicate values: integer, float, boolean, string literals, or a
  parameter. A **list parameter cannot appear in a predicate** ("composite
  parameter is only supported as an UNWIND input"), so `WHERE x IN $list` is out;
  feed lists through UNWIND instead.

### 2. Mutation engine: writes

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

**c. UNWIND batches**, the bulk ingestion path, and the one HyperDefense uses.
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
  timestamp wins, directly useful for the temporal layer
- a **create-only marker** so a field is written once and never overwritten

Edge upsert (the relationship writer), one fixed type, no properties on the rel,
endpoints by id field:

```cypher
UNWIND $rows AS row
MERGE (a {id: row.src})-[:DEPENDS_ON]->(b {id: row.dst})
```

**This form did not execute.** The shape that actually works, taken from
HydraDB's own bolt client tests, matches both endpoints by label and id first,
then merges a relationship carrying its own integer id:

```cypher
UNWIND $rows AS row
MATCH (s:Package {id: row.src}), (d:Package {id: row.dst})
MERGE (s)-[:DEPENDS_ON {id: row.eid}]->(d)
```

Also available: UNWIND MATCH ... CREATE (edge), UNWIND MATCH ... DELETE. Every
UNWIND batch is one-hop only, directional (no undirected), batch input must be a
`$parameter`, node patterns carry no labels and only the `id` property.

## Native path procedures: NOT reachable over Bolt in practice

**Live result: all three work.** Verified over Bolt by `debug-write` steps 9a to
9d.

This document previously claimed they were unreachable. That claim was wrong,
and the test behind it was wrong: the probe used `MATCH ... CALL algo.MSpaths`.
The dispatch in `query/opencypher.rs` is:

```rust
pub(crate) fn classify_opencypher_query_access(query: &str) -> Result<...> {
    if super::path_procedure::is_native_path_procedure(query) {
        return Ok(OpenCypherQueryAccess::Read);   // short-circuit
    }
    ...
}
```

and `is_native_path_procedure` requires the **trimmed query to start with
`CALL`** followed by `algo.`. A `MATCH` prefix fails that test, so the statement
falls through to the generic clause walker, whose allowed set is
`CREATE | MERGE | DELETE | SET | REMOVE | UNWIND | MATCH | WITH | RETURN | UNION`.
`CALL` is not in it, hence "cannot authorize an unsupported Cypher clause". The
error was about clause authorization, never about the procedures being missing.

The lesson is worth keeping: the failing probe tested a form the source had
already documented as invalid, and a wrong conclusion was drawn from it rather
than the test being questioned.

Working form, from HydraDB's own `bolt_server_runs_native_path_procedure_calls`
test and confirmed here:

```cypher
CALL algo.MSpaths({sourceLabel: 'Package', sourceProperty: 'name',
  sourceValues: ['@tanstack/router-core', '@tanstack/history'],
  relTypes: ['DEPENDED_ON_BY'], maxLen: 5,
  relDirection: 'outgoing', resultLimit: 10000})
YIELD path RETURN path
```

Note `RETURN path` returns a whole path value, which the row engine forbids.
Path procedures are a separate engine with separate projection rules.

Source reading, retained for reference:
`CALL algo.SPpaths | algo.SSpaths | algo.MSpaths({...}) YIELD path RETURN path`.
A dedicated parser handles these and the statement must begin with `CALL`
(`MATCH ... CALL` is not accepted).

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
4. Blast radius traverses a materialised reverse edge OUTWARD:
   `MATCH (c {id: <literal>})-[:DEPENDED_ON_BY*1..N]->(x:Package) RETURN x.name`,
   with de-duplication in TypeScript (no DISTINCT aggregate).
   See "Corrections from live testing" below: the inbound form does not work.
5. Maintainer overlap: project `collect(other.name)` grouped per maintainer;
   dedupe client-side.
6. No `WHERE id IN $list`; drive multi-package queries through UNWIND, or issue
   one traversal per compromised package and merge client-side.
7. The `algo.*` path procedures DO work, provided the statement starts with
   `CALL algo.`. `algo.MSpaths` resolves many indexed sources in one call and is
   what serves the "N compromised packages at once" query.

---

## Corrections from live testing

Everything above this section was read from the HydraDB source. Running it
against a live server disproved two of those readings. These corrections are
verified by `npm run dev -- debug-write` against a real instance, and the probe
retains a case for each so a regression is visible.

### 1. Variable-length traversal is OUTBOUND only

The source reading said variable-length patterns work in either direction. They
do not. From `src/shard/query.rs:3976`:

```rust
let Some(src) = edge.src.id else {
    return Err(GraphError::UnsupportedQuery {
        feature: "variable-length MATCH requires a fixed source id",
    });
};
```

The edge's **source** node must carry a literal id. In an inbound pattern
`(c {id: 5})<-[:DEPENDS_ON*1..2]-(x)` the source is `x`, which has no id, so the
query is rejected no matter where the id is placed. A parameter is also rejected;
the id must be a literal in the query text.

Consequence: "who depends on X" cannot be answered by reversing the arrow. The
reverse edge has to exist in the graph. Ingestion writes `DEPENDED_ON_BY`
alongside every `DEPENDS_ON`, and blast radius walks it forward. Roughly double
the edge count, which is the price of the constraint.

Fixed-length patterns are unaffected and do accept `$id` parameters. The two-hop
maintainer-overlap query relies on that and works.

### 2. Node ids must be small, and writes need a writable store

Two separate things were conflated during debugging, so both are recorded:

- **Id size was NOT the problem.** Compact ids (9001) failed exactly like
  hash-based ids in the 2^53 range. Compact sequential ids are still what the
  project uses, because they are the honest model for a GraphBLAS-indexed
  vertex space, but they were not the fix.
- **The actual cause was filesystem permissions.** The image runs as UID 10001;
  Docker named volumes are created root-owned, so the process could not write
  `/data/store`. Every write failed on the first storage operation while reads
  succeeded. HydraDB's README documents this for bind mounts. The devcontainer
  now runs the service as root.

### 3. Write and read errors are deliberately suppressed

`src/client/bolt/values.rs:271` and `src/client/http.rs:433` map any unmatched
`GraphError` to the generic string `internal query execution error`, logging the
real cause server-side as `Bolt suppressed internal graph error`. Both transports
do this, so **the client can never see the real error**.

When a write fails opaquely, read the container log rather than guessing:

```bash
docker logs $(docker ps --filter name=hydradb --format '{{.Names}}' | head -1) --tail 60
```

The devcontainer includes the `docker-outside-of-docker` feature so this works
from inside the workspace.

### 4. Confirmed working against a live server

| Form | Status |
|------|--------|
| `UNWIND $rows AS row MERGE (n {id: row.id}) SET n:Label, n.p = row.p` | works |
| `UNWIND $rows MATCH (s:L {id: row.src}), (d:L {id: row.dst}) MERGE (s)-[:T {id: row.eid}]->(d)` | works |
| cross-label edge (`Maintainer` -> `Package`) | works |
| `MATCH (n:L {id: $id}) RETURN n.name` | works |
| `MATCH (c {id: <literal>})-[:T*1..2]->(x:L) RETURN x.name` | works |
| two-hop fixed-length with `collect()` and `$id` param | works |
| `MATCH (c {id: N})<-[:T*1..2]-(x)` | rejected, see 1 |

Empty-string properties are accepted, so absent npm metadata does not need a
null-handling path.
