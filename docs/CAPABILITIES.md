# HydraDB capability matrix (measured)

Recorded output of `npm run dev -- debug-write` against a live HydraDB in the
project dev container, 2026-08-17. Every row below was executed against a real
server; nothing here is inferred from documentation.

Regenerate the fuller matrix, including the npm registry payload checks, with:

```bash
npm run doctor          # writes this file
npm run dev -- debug-write   # per-form write/read probe, printed
```

## Connection

| Property | Value |
|----------|-------|
| uri | `bolt://hydradb:7687` (direct; bypasses routing) |
| auth | `bearer` (also works: `basic("neo4j", token)`) |
| rejected auth | `basic("", token)` and no-auth, both "invalid credentials" |

The health check must be a valid row query with a labelled anchor, e.g.
`MATCH (n:__HDConnCheck) RETURN count(*) AS c`. `RETURN 1`, `RETURN n`, and a
bare `MATCH (n)` are all rejected.

## Writes

| Form | Result |
|------|--------|
| `UNWIND $rows MERGE (n {id: row.id}) SET n:Label, n.p = row.p` | works |
| same, with an empty-string property value | works |
| second labelled node type (`Maintainer`) | works |
| `UNWIND $rows MATCH (s:L {id}), (d:L {id}) MERGE (s)-[:T {id}]->(d)` | works |
| cross-label edge (`Maintainer` -> `Package`) | works |
| reverse edge write (`DEPENDED_ON_BY`) | works |

Bulk node writes must go through the UNWIND vertex-upsert form. A per-row
`CREATE` of a lone node is not executable.

## Reads and traversal

| Form | Result |
|------|--------|
| `MATCH (n:L {id: $id}) RETURN n.name` | works |
| `MATCH (c {id: <literal>})-[:T*1..N]->(x:L) RETURN x.name` (outbound) | works |
| `MATCH (c {id: N})<-[:T*1..2]-(x)` (inbound) | **rejected** |
| two-hop fixed-length with `collect()` and an `$id` parameter | works |

Inbound variable-length traversal is rejected with "variable-length MATCH
requires a fixed source id": the edge's SOURCE node must carry a literal id, and
in an inbound pattern the source is the far, unidentified node. This is why
ingestion materialises a `DEPENDED_ON_BY` edge and blast radius walks it
outward. Fixed-length patterns accept `$id` parameters normally.

## Native path procedures

| Procedure | Result |
|-----------|--------|
| `CALL algo.SSpaths({sourceNode: <id>, ...}) YIELD path` | works |
| `CALL algo.SPpaths({sourceNode, targetNode, ...}) YIELD path` | works |
| `CALL algo.MSpaths({sourceLabel, sourceProperty, sourceValues, ...})` | works |
| `MATCH ... CALL algo.MSpaths(...)` | **rejected** |

The statement must **start** with `CALL algo.`. A `MATCH` prefix fails
`is_native_path_procedure`, falls through to a generic clause walker whose
allowed set is `CREATE | MERGE | DELETE | SET | REMOVE | UNWIND | MATCH | WITH |
RETURN | UNION`, and is rejected as "cannot authorize an unsupported Cypher
clause".

`pathCount` defaults to `1`. These are **shortest-path** procedures, so they are
used here only for `attack-path` (how a compromise reaches a given service) and
deliberately not for reachability; see the README for the measurement that
settled that.

## Operational constraints

- **No concurrent queries.** Two in flight on one Bolt connection intermittently
  corrupt the decode, surfacing as `The value of 'offset' is out of range ...
  Received N` from inside the driver. Every query path in this project is
  sequential.
- **The container must be able to write its store.** The image runs as UID
  10001; Docker named volumes are created root-owned, so every write fails while
  reads succeed. The dev container runs the service as root.
- **Errors are suppressed by design.** Both Bolt and HTTP map unmatched internal
  errors to the string "internal query execution error" and log the real cause
  server-side. When a write fails opaquely, read the container log rather than
  guessing:

  ```bash
  docker logs $(docker ps --filter name=hydradb --format '{{.Names}}' | head -1) --tail 60
  ```

## npm registry payload

Verified live against `express@5.2.1`: `name`, `dist-tags.latest`,
`versions[latest]`, a non-empty `dependencies` map (28 entries), `maintainers`
(3 accounts), and `time[latest]` are all present and populated.

Note that npm omits the `dependencies` key entirely for a dependency-free
package, so a shape check must assert a non-empty map against a package known to
have dependencies, or it cannot tell a working parser from one returning nothing.
