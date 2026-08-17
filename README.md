# HyperDefense

A multi-graph supply chain blast radius engine built on
[HydraDB](https://github.com/hydra-db/hydradb).

When a package is compromised, the urgent question is not "is this one bad" but
"what does it reach". HyperDefense answers that across three graph layers at
once:

- **Dependency graph** — which packages transitively depend on the compromised
  one (the downstream blast radius).
- **Maintainer graph** — which *other* packages share a maintainer with it, and
  are therefore the worm's next hop. This is the layer the commercial scanners
  do not model, and it is the difference between "what is already hit" and
  "what is about to be".
- **Temporal graph** — which versions were published inside the compromise
  window, and which consumers resolved them while they were live.

The insight is that this is a graph traversal problem, not a vector similarity
problem. No embedding captures a transitive reverse-dependency closure or a
shared-maintainer edge. It needs a graph, and HydraDB is a graph database that
scales to a registry-sized graph on object storage.

> Status: built for [Hack Hydra](https://hackhydra.hydradb.com/) (Aug 12–20,
> 2026), Track 2A. See [Project status](#project-status) for exactly what is
> working today versus in progress. This README does not claim more than the
> code does.

## Why HydraDB, specifically

HyperDefense is not a graph library bolted onto a relational store. Every core
question is a HydraDB traversal:

- Downstream blast radius is a bounded reverse variable-length path:
  `MATCH (c {id: $id})<-[:DEPENDS_ON*1..N]-(x) RETURN x.id`.
- Lateral movement is a two-hop traversal through a shared maintainer node.
- The "many compromised packages at once" query maps onto HydraDB's native
  `algo.MSpaths` path procedure, which resolves many indexed sources in one
  call instead of fanning out from the client.

The query layer is written against HydraDB's real executable Cypher subset,
documented in [docs/HYDRADB-CYPHER-SPEC.md](docs/HYDRADB-CYPHER-SPEC.md) — read
from the engine source, not assumed from the Cypher standard.

## Architecture

```
 npm registry ──► ingest ──► HydraDB (3 graph layers) ──► analysis ──► CLI / report
                  (fetch)     dependency │ maintainer │ temporal
```

| Stage | Location | Job |
|-------|----------|-----|
| fetch | `src/ingest/npm-registry.ts` | pull package, version, maintainer, timestamp data from the public npm registry |
| load  | `src/ingest/dependency-graph.ts` | UNWIND-batch nodes and edges into HydraDB |
| traverse | `src/db/queries.ts` | the three graph-layer queries |
| analyze | `src/analysis/*` | rank blast radius, score lateral movement, compute exposure windows, find typosquats |
| report | `src/cli.ts` | render results, write the capability matrix |

## Quick start

The whole stack runs in a dev container, so HydraDB comes up as a sibling
service with no local install.

### GitHub Codespaces (recommended)

1. **Code ▸ Codespaces ▸ Create codespace on main.** The dev container starts
   HydraDB and runs `npm install` automatically.
2. In the terminal:

   ```bash
   npm run doctor
   ```

   This probes the live HydraDB and the npm registry and writes a measured
   capability matrix to `docs/CAPABILITIES.md`. It is both the health check and
   the proof the graph engine is reachable.

### Local (VS Code Dev Containers)

Requires Docker and the Dev Containers extension. Open the folder, "Reopen in
Container", then `npm run doctor`. The dev container definition is in
[`.devcontainer/`](.devcontainer).

## Usage

```bash
# Verify the stack (HydraDB + npm registry) and write the capability matrix
npm run doctor

# Ingest packages and their transitive dependencies into HydraDB
npm run dev -- ingest --packages express react --depth 3

# Blast radius of a compromised package across all three graph layers
npm run dev -- blast @tanstack/router

# Maintainer overlap and lateral-movement risk
npm run dev -- lateral @tanstack/router

# Temporal exposure window
npm run dev -- exposure @tanstack/router --from 2026-05-11T09:00:00Z --to 2026-05-12T14:00:00Z

# Typosquat candidates
npm run dev -- typosquat express
```

## Development

```bash
npm run lint    # type-check
npm test        # unit tests (pure logic: typosquat distance, payload shape)
npm run build   # compile to dist/
```

Pure logic (distance metrics, payload parsing, scoring) is kept separate from
I/O so it is unit-testable without a database or a network.

## Project status

Honest state, updated as the build progresses.

**Working and verified:**

- Dev container brings up HydraDB; `doctor` connects over Bolt and confirms the
  executable Cypher subset live.
- npm registry ingestion path verified against the live registry (payload shape
  asserted against `express`: dependencies, maintainers, publish timestamps all
  present).
- Pure-logic analysis (typosquat distance, payload validation) with passing
  tests.
- HydraDB Cypher subset fully mapped from engine source
  ([spec](docs/HYDRADB-CYPHER-SPEC.md)).

**In progress:**

- Rewriting the graph load and traversal layer against the verified spec. The
  first draft of `src/db/queries.ts` was written before the engine's real
  constraints were known (integer node identity, no `DISTINCT` aggregates,
  UNWIND-only batch writes) and is being rebuilt.
- TanStack compromise fixture for an offline, deterministic demo.
- Remediation output (lockfile patch, CI block rule) and a GitHub Action
  surface.

## How HydraDB is used

HydraDB is the graph store and traversal engine. Ingestion writes nodes and
edges through HydraDB's UNWIND batch mutations; every analytical question is a
Cypher traversal or a native `algo.*` path procedure against a HydraDB snapshot.
Remove HydraDB and there is no product: the whole value is graph-native
reachability that a vector or relational store cannot answer.

## License

[MIT](LICENSE).
