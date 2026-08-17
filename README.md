# HyperDefense

A multi-graph supply chain blast radius engine built on
[HydraDB](https://github.com/hydra-db/hydradb).

When a package is compromised, the urgent question is not "is this one bad" but
"what does it reach". HyperDefense answers that across three graph layers at
once:

- **Dependency graph**: which packages transitively depend on the compromised
  one. The downstream blast radius.
- **Maintainer graph**: which *other* packages share a maintainer account with
  it, and are therefore the worm's next hop. This is the layer commercial
  scanners do not model, and it is the difference between "what is already hit"
  and "what is about to be".
- **Temporal graph**: the full publish timeline per package (the committed
  TanStack fixture carries 2,235 version nodes, up to 60 per package). That is
  what makes it possible to name the **first suspect version**, the one that
  shipped inside the compromise window, and the **last clean version** to pin
  back to.

This is a graph traversal problem, not a vector similarity problem. No embedding
captures a transitive reverse-dependency closure or a shared-maintainer edge.

Built for [Hack Hydra](https://hackhydra.hydradb.com/) (Aug 12 to 20, 2026),
Track 2 Option A.

## The result that makes the case

Real npm data, `body-parser` treated as compromised:

```
  BLAST RADIUS: body-parser

  Downstream dependents (1):
    - express

  Lateral movement risk (shared maintainers):
    @dougwilson also publishes: accepts, bytes, content-disposition,
      content-type, cookie, cookie-signature, depd, encodeurl, escape-html,
      etag, finalhandler, forwarded, fresh, http-errors, media-typer,
      mime-types, negotiator, on-finished, parseurl, path-to-regexp,
      proxy-addr, range-parser, raw-body, router, send, serve-static,
      statuses, type-is, vary
    @wesleytodd also publishes: accepts, content-disposition, express,
      finalhandler, iconv-lite, mime-types, negotiator, router, send,
      serve-static, type-is
    ...

  Total affected: 31 packages
```

A dependency-only scanner reports **1** affected package. Modelling maintainer
accounts as graph nodes reveals **31**. One compromised maintainer account is all
it takes, which is exactly how the Shai-Hulud and TanStack campaigns propagated:
the worm queried npm for everything a compromised account published, then
republished it.

The offline TanStack fixture shows the same shape with the numbers side by side:

```
  ─────────────────────────────────────────
  Dependency layer alone:   3 packages
  + maintainer layer:       10 packages
  7 packages a dependency-only scanner misses (3.3x)
  ─────────────────────────────────────────
```

## The track's questions, and where each is answered

Track 2 Option A poses six questions. Mapped honestly, including the limits:

| Question | Command | Status |
|----------|---------|--------|
| Which internal services are transitively exposed? | `blast`, `blast-many` | full |
| What is the complete blast radius? | `blast` | full, across dependency and maintainer layers |
| Which other packages share maintainers with it? | `lateral`, `blast` | full |
| Which version introduced the vulnerability? | `exposure` | names the first version published inside the window, and the last clean version to pin to, from a real per-package timeline |
| Which applications resolved the compromised version while it was live? | `verify` | resolves against a real lockfile, which records what actually installed. Not correlated to the time window: an app's lockfile has no timestamp, so "while it was live" is answered for the package timeline, not per application |
| Are there likely typosquat packages nearby? | `typosquat` | edit-distance over names in the graph, classified by technique |

The track also mentions shared *infrastructure* alongside shared maintainers.
Only the maintainer relationship is modelled; CI and build infrastructure are
not, because npm does not publish it.

## Quick start

The whole stack runs in a dev container, so HydraDB comes up as a sibling
service with nothing to install locally.

### GitHub Codespaces (recommended)

1. **Code > Codespaces > Create codespace on main.** The dev container starts
   HydraDB and runs `npm install` automatically.
2. Confirm the stack is live:

   ```bash
   npm run doctor
   ```

   This probes the running HydraDB and the npm registry, then writes a measured
   capability matrix to `docs/CAPABILITIES.md`.

3. Run the whole story in one command, offline and deterministic:

   ```bash
   npm run demo
   ```

   That ingests the committed TanStack graph, computes the blast radius across
   all three layers, generates the remediation artifacts, then runs the CI gate
   twice: failing against a vulnerable app's lockfile and passing against this
   repo's own. A gate is only worth trusting if you have seen it fail.

### Local (VS Code Dev Containers)

Requires Docker and the Dev Containers extension. Open the folder, "Reopen in
Container", then `npm run doctor`. Definition is in
[`.devcontainer/`](.devcontainer).

## Usage

```bash
# Health check: probe HydraDB + npm, write the capability matrix
npm run doctor

# Per-form write/read probe with HydraDB's real error per step
npm run dev -- debug-write

# Capture npm once into a replayable fixture (no HydraDB required)
npm run dev -- snapshot --packages @tanstack/react-router --depth 2 \
  --out fixtures/my-scenario.json

# Load a graph: live from npm, or offline from a fixture
npm run dev -- ingest --packages express --depth 2
npm run dev -- ingest --fixture fixtures/tanstack.json

# Blast radius across the dependency and maintainer layers
npm run dev -- blast body-parser

# Combined blast radius for several compromised packages
npm run dev -- blast-many @tanstack/router-core @tanstack/history

# HOW a compromise reaches a service you care about, as concrete chains
npm run dev -- attack-path @tanstack/router-core --to @tanstack/react-router

# Maintainer overlap and lateral-movement risk, scored
npm run dev -- lateral body-parser

# Temporal exposure window
npm run dev -- exposure body-parser \
  --from 2026-05-11T09:00:00Z --to 2026-05-12T14:00:00Z

# Typosquat candidates
npm run dev -- typosquat express

# Generate the fix: blocklist, npm overrides, CI gate workflow
npm run dev -- remediate body-parser --bad-versions 1.20.3 --out .hyperdefense

# Enforce it. Exits 1 if a blocked version resolved, failing the CI check
npm run dev -- verify --blocklist .hyperdefense/blocklist.json
```

### Generating the fix, not just the warning

`remediate` turns a blast radius into artifacts you can apply:

- `blocklist.json`, the machine-readable policy `verify` enforces
- an npm `overrides` block to pin a safe version
- `supply-chain-gate.yml`, a GitHub Actions job that fails the build

`verify` reads the **lockfile**, not `package.json`, because a compromise is
about the version that actually resolved, not the declared range. It exits 1 on
a violation so the PR check fails, and exit 2 for "could not run" so a broken
gate is never mistaken for a pass.

Two deliberate judgements:

- Shared-maintainer packages go to `review`, not `blocked`. Hard-blocking a
  maintainer's entire portfolio on suspicion would break builds for packages
  nobody touched, and a gate that cries wolf gets switched off.
- No safe version is ever invented. Without `--safe-version` the override is
  skipped and the gap stated. A pin that looks authoritative but is not would
  get applied without being read.

Everything here is rule-based. No model is consulted, so output is
byte-identical run to run and safe to gate a pipeline on.

## How HydraDB is used

HydraDB is the graph store and the traversal engine. There is no product without
it: the entire value is graph-native reachability that a vector or relational
store cannot answer.

| Question | HydraDB traversal |
|----------|-------------------|
| Downstream blast radius | `MATCH (c {id: <id>})-[:DEPENDED_ON_BY*1..N]->(x:Package) RETURN x.name` |
| **How a compromise reaches a given service** | **`CALL algo.MSpaths({sourceLabel:'Package', sourceProperty:'name', sourceValues:[...], targetValues:[...], relTypes:['DEPENDED_ON_BY'], ...}) YIELD path`** |
| Lateral movement | two-hop through a shared `Maintainer` node, with `collect()` |
| Temporal exposure | `MATCH (c {id: $id})-[:HAS_VERSION]->(v:Version) RETURN v.version, v.publishedAt` |

The second row answers a different question from the first, and it is the one
`algo.MSpaths` is genuinely right for. `blast` tells you **what** is exposed and
returns a set. `attack-path` tells you **how** the bad code arrives and returns
the chain, naming the intermediate package that pulls it in, which is where a
responder can cut the link:

```
2 hops: @tanstack/router-core -> @tanstack/router-plugin -> @tanstack/react-router
```

### A measurement that changed the design

`MSpaths` was originally used for the reachability query itself, on the
reasoning that resolving many sources in one engine-side call must beat a loop.
Measured against the traversal on the same graph, it reported **4 affected
packages where the correct answer was 5**, and took 184ms against the loop's
100ms.

The cause is semantic, not a tuning problem: `MSpaths` enumerates *shortest
paths per source-target pair*, and a set of shortest paths is not the set of
reachable nodes. No `pathCount` fixes that. (`pathCount` also defaults to `1`,
which under-reported further until it was set explicitly.)

An under-count in a security tool is worse than a slow answer, because it is a
confident wrong answer. So reachability (`blast`, `blast-many`) uses traversal,
and the procedure is used only for `attack-path`, where path semantics are
exactly what is wanted. The deprecated function is kept in
`src/analysis/multi-blast.ts` with the measurement recorded next to it.

Ingestion writes nodes and edges through HydraDB's UNWIND batch mutations, which
is the only supported path for bulk node writes.

The query layer is written against HydraDB's real executable Cypher subset,
documented in [docs/HYDRADB-CYPHER-SPEC.md](docs/HYDRADB-CYPHER-SPEC.md). That
document was read from the engine source and then **corrected by live testing**,
which disproved two of the source readings. Notably:

- Variable-length traversal is **outbound only**, and the source node must carry
  a literal id. `(c {id: N})<-[:DEPENDS_ON*1..N]-(x)` is always rejected, because
  in an inbound pattern the source is the far, unidentified node. Answering "who
  depends on X" therefore requires a **materialised reverse edge**, so ingestion
  writes `DEPENDED_ON_BY` alongside every `DEPENDS_ON`. This changed the data
  model.
- The native `algo.*` path procedures **do work**, but only when the statement
  **starts** with `CALL algo.`. A `MATCH ... CALL` prefix fails HydraDB's
  `is_native_path_procedure` check, falls through to a generic clause walker
  that does not allow `CALL`, and is rejected as an "unsupported Cypher clause".
  An earlier draft of this README concluded the procedures were unavailable;
  that was a wrong inference from a badly-formed test, and it is corrected here
  rather than quietly dropped.

## Architecture

```
 npm registry ──► crawl ──► GraphSink ──► HydraDB (3 layers) ──► analysis ──► CLI
                              │            dependency                          │
                              └─► fixture  maintainer                          └─► remediation
                                  (offline) temporal                               artifacts + CI gate
```

| Stage | Location | Job |
|-------|----------|-----|
| fetch | `src/ingest/npm-registry.ts` | pull package, version, maintainer, timestamp data |
| capture | `src/ingest/snapshot.ts` | collect a crawl as a replayable fixture |
| load | `src/ingest/dependency-graph.ts` | UNWIND-batch nodes and edges into HydraDB |
| identity | `src/db/id-registry.ts` | compact integer node ids, persisted so separate processes agree |
| traverse | `src/db/queries.ts` | the graph-layer queries |
| analyze | `src/analysis/*` | blast radius, lateral movement, exposure windows, typosquats |
| remediate | `src/remediate/*` | plan, artifacts, lockfile gate |
| probe | `src/doctor/*` | capability matrix and per-form write probe |

The crawler writes to a `GraphSink` interface, so the same code path feeds either
HydraDB or a fixture file. There is one graph-write path, not two.

## Development

```bash
npm run lint    # type-check
npm test        # unit tests
npm run build   # compile to dist/
```

Pure logic (scoring, distance metrics, plan building, lockfile parsing) is kept
separate from I/O so it is unit-testable with no database and no network.

42 tests currently pass, covering the id registry's persistence round trip,
snapshot replay fidelity, remediation classification, and the CI gate against
nested transitive resolutions, scoped names, and lockfile v1 and v3.

## Project status

`npm run demo` runs all seven steps end to end against a live HydraDB, offline,
on committed fixtures.

Verified working against a live HydraDB:

- Dev container brings up HydraDB; `doctor` connects over Bolt and measures the
  executable Cypher subset.
- All write forms: UNWIND vertex upsert, same-label and cross-label edge upsert.
- Ingest from live npm and from a committed fixture.
- Dependency-layer blast radius via the materialised reverse edge.
- Maintainer-layer lateral movement, demonstrated on real npm data.
- Remediation artifacts and the lockfile gate, run against this repo's own
  lockfile (134 resolved packages scanned).
- `attack-path`, using the native `algo.MSpaths` procedure, returning real
  multi-hop chains such as
  `@tanstack/history -> @tanstack/router-core -> @tanstack/react-router`.

### One operational constraint worth knowing

**Queries must not run concurrently.** Two in flight on a single Bolt connection
intermittently corrupt the decode and surface as
`The value of 'offset' is out of range ... Received N` from inside the driver's
buffer read. It is timing and data dependent, so the failure appears to wander
between commands as the graph grows, which is what made it hard to place: two
plausible-but-wrong explanations were tried before noticing that the only
operations ever affected were the only two using `Promise.all`. Every query path
here is sequential.

- Temporal exposure. Verified on the TanStack graph: correctly identified the
  version published inside a given window and the three consumers that could
  have resolved it.
- Typosquat detection, verified against `fixtures/typosquat-demo.json`.

All three graph layers are therefore exercised against a live HydraDB.

One caveat stated plainly: on a clean graph, typosquat detection correctly
returns **nothing**, because a legitimate registry subset contains no
near-misses. Demonstrating it needs a graph that actually holds some, which is
what `fixtures/typosquat-demo.json` provides. That fixture is hand-authored and
labelled as such, in contrast to `fixtures/tanstack.json`, which is real npm
data.

Known scope limits:

- npm only. PyPI is out of scope.
- The graph is a seeded subgraph, not the full registry.
- Analyses a known compromise; it does not discover new ones.

## Attribution

- [HydraDB](https://github.com/hydra-db/hydradb), the graph database this is
  built on (AGPL-3.0).
- [neo4j-driver](https://www.npmjs.com/package/neo4j-driver) for Bolt
  connectivity, since HydraDB is Bolt-compatible.
- [commander](https://www.npmjs.com/package/commander),
  [chalk](https://www.npmjs.com/package/chalk),
  [ora](https://www.npmjs.com/package/ora) for the CLI.
- [vitest](https://vitest.dev/), [tsx](https://tsx.is/),
  [typescript](https://www.typescriptlang.org/) for development.
- Package data from the public
  [npm registry API](https://registry.npmjs.org/). `fixtures/tanstack.json` is
  real registry data captured with `hyperdefense snapshot`; it records its own
  capture time and provenance.
- Incident details referenced in comments and docs come from public reporting on
  the September 2025 Shai-Hulud worm and the May 2026 TanStack compromise.

## License

[MIT](LICENSE).
