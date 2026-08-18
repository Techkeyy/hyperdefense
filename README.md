# HyperDefense

A multi-graph supply chain blast radius engine built on
[HydraDB](https://github.com/hydra-db/hydradb).

**[Live dashboard](https://hyperdefense.vercel.app)** &middot;
[mirror](https://techkeyy.github.io/hyperdefense) &middot;
[how I tried to break it](#how-i-tried-to-break-it) &middot;
[limitations](#project-status)

The dashboard runs with no backend: it serves query results captured from a real
HydraDB instance, so the numbers on it are the ones the engine produced.

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

Reproduce that number yourself, offline, from committed real npm data:

```bash
npm run dev -- ingest --fixture fixtures/express.json
npm run dev -- blast body-parser
```

The TanStack compromise fixture shows the same shape with the numbers side by
side:

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

# Render the finding as a PR comment (markdown, ready for `gh pr comment`)
npm run dev -- pr-comment body-parser \
  --blocklist .hyperdefense/blocklist.json --out pr.md

# Check every package in the graph against the OSV advisory feed
npm run dev -- watch

# Serve the dashboard: search the graph, see it, run the gate in a browser
npm run web
```

### The dashboard

`npm run web` serves a read-only view of the same engine on port 5173 (open the
forwarded port in a Codespace). It is a second view, not a second engine: every
endpoint calls the same analysis function the CLI calls, so a number in the
browser is the number the CLI prints.

It shows the dependency-versus-maintainer contrast for any package in the graph,
renders the two layers as a force-directed graph (the compromised package
pinned centre, maintainer accounts labelled, because those are the nodes a
responder acts on), traces attack paths, and runs the real CI gate against both
committed lockfiles so a pass and a fail are visible side by side.

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
byte-identical run to run and safe to gate a pipeline on. That is a deliberate
choice, not a gap: a security gate whose verdict depends on a model's mood is
not a gate, and the composition that matters here (a `GraphSink` the crawler
writes to, independent analysis stages, a deterministic plan builder) is
structural rather than agentic.

### Closing the loop

Two surfaces make this something a team would actually run, rather than a tool
someone remembers to open.

**A comment on the pull request.** `pr-comment` renders the finding as markdown:
the gate result, the dependency-versus-maintainer contrast, the attack chains,
and the pin to apply. The generated workflow posts it with `--edit-last`, so a
long PR gets one updated comment rather than a new one per push, and it posts
*before* the gate runs so a blocked merge always arrives with its reason
attached. A blocked merge with no explanation is a worse experience than no gate
at all.

**An advisory feed.** `watch` queries [OSV](https://osv.dev) for every package in
the graph and turns "an advisory was published" into "here is the blast radius",
which is the half a scanner normally leaves to a human. Verified live: of five
sampled packages, `lodash` has 10 advisories, `express` 5, and
`@tanstack/router-core` 2. OSV's batch endpoint is used because the graph holds
thousands of packages, with details fetched only for the ones that matter.

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
| dashboard | `src/web/*` | read-only HTTP view of the same analysis, plus the graph visualisation |

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

102 tests currently pass, covering the id registry's persistence round trip,
snapshot replay fidelity, remediation classification, HTTP value decoding, the
CI gate against nested transitive resolutions, scoped names and lockfile v1/v3,
and 24 adversarial cases described under
[How I tried to break it](#how-i-tried-to-break-it).

## How I tried to break it

A tool that outputs "blocked" or "clear" is only worth trusting if the author
tried to make it say the wrong thing. Every row below is exercised by a test in
[`tests/adversarial.test.ts`](tests/adversarial.test.ts), not checked by hand.

| Input | Result |
|---|---|
| `--depth abc` (non-numeric flag) | Clamped to the default. Previously emitted the literal text `NaN` into a Cypher query |
| `--depth 9999` | Clamped to 16, HydraDB's `max_traversal_hops`. Previously produced a rejected query reported as "feature unavailable" |
| `--depth -99`, `0`, `3.7` | Clamped to a valid integer, never a negative or fractional bound |
| Corrupt `package-lock.json` | **Throws.** A gate that cannot parse its input must never report a pass |
| Missing blocklist file | Throws, exit 2, distinct from a policy failure (exit 1) |
| Empty lockfile | Zero packages scanned, reported as zero rather than as a clean pass over data |
| A directory named `my-node_modules-helper` | Not mistaken for a package. No false violation |
| Dependency cycle (`a -> b -> a`) | Terminates, no duplicate edges |
| Package depending on itself | Handled, no infinite walk |
| `router` vs `@tanstack/router` | Kept distinct. Scoped and unscoped names never collide |
| Corrupt or wrong-shaped id map | Starts fresh rather than assigning `NaN` ids |
| Blast radius of 800 packages | Output stays under 20KB, no `undefined` or `NaN` in the rendered comment |
| Unknown HTTP value shapes | Decoded or passed through, never throws |
| Large ingest (2,235 edges, fresh graph) | Server returns HTTP 500 partway; the writer halves the batch and retries until it lands |

**The invariant that matters: an error is never reported as a clean result.**
Three separate bugs during the build presented as confident wrong answers
because a `catch` swallowed the cause: a decode failure that read as "0 attack
paths", a targeting bug that silently dropped a whole report section, and a
depth above the server's limit that read as "this feature is unavailable". Each
is now surfaced with the server's actual message, and `attackPaths` explicitly
separates "no path exists" from "rows could not be decoded".

**Trust architecture:** every verdict is rule-based. No model is consulted, so
the same graph and inputs produce byte-identical output on every run.

**Known limits, stated rather than discovered:** npm only, no PyPI. The graph is
a seeded subgraph, not the full registry. It analyses a known compromise rather
than discovering new ones. Shared CI infrastructure is not modelled, because npm
does not publish it. Typosquat detection returns nothing on a clean graph, which
is correct but undemonstrative, so a clearly-labelled synthetic fixture exists to
exercise it.

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

### Two constraints worth knowing

**Queries go over HTTP, not Bolt.** `neo4j-driver`'s Bolt decode is unreliable
against HydraDB: it throws `The value of 'offset' is out of range ... Received N`
from a Node buffer read, triggered both by concurrent queries and, separately,
by larger responses. It therefore got worse as the graph grew, and the failure
appeared to wander between commands, which made it hard to place. HydraDB also
exposes a plain JSON query API with cursor pagination and no such decoder, so
that is the default transport here (`src/db/http-client.ts`).
`HYDRA_TRANSPORT=bolt` forces the Bolt path; `doctor` uses it deliberately to
probe the Bolt surface. Queries are also issued sequentially.

**HydraDB uses two different serde taggings, and mixing them fails silently.**
Row values are adjacently tagged (`{"type":"string","value":"x"}`), while a
`VertexPropertyValue` nested inside a path is externally tagged
(`{"String":"x"}`). Using the wrong decoder throws nothing: it returns raw
objects, every name lookup misses, and `attack-path` reports "0 paths" as though
the graph had none. In a security tool that reads as "you are safe", so
`attackPaths` now counts rows it could not decode and reports them as a bug
rather than an absence of paths.

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

## HydraDB: what worked, and what I fed back

HydraDB is used through three surfaces: the Bolt protocol (for `doctor`, which
probes that surface deliberately), the HTTP JSON query API with cursor
pagination (the default transport for everything else), and the native
`algo.MSpaths` path procedure. Ingestion goes through UNWIND batch mutations.

Four findings from building on it, each reproducible and each documented in
[`docs/HYDRADB-CYPHER-SPEC.md`](docs/HYDRADB-CYPHER-SPEC.md) with the source
line that explains it. They are reported here as observations, not complaints:

1. **The Bolt decode is unreliable for this driver pairing.** `neo4j-driver`
   throws `The value of "offset" is out of range ... Received N` from a Node
   buffer read. Triggered both by concurrent queries and, independently, by
   larger responses, so it worsens as a graph grows and the failure appears to
   move between commands. The HTTP API has no such problem, which is why it is
   the default here.

2. **Internal errors are suppressed on both transports.**
   `src/client/bolt/values.rs:271` and `src/client/http.rs:433` map any
   unmatched `GraphError` to the string `internal query execution error` and log
   the real cause server-side. The client can never see it. Debugging a failed
   write means reading the container log, which is worth stating in the docs
   because the alternative is guessing at Cypher syntax, as I did for several
   hours.

3. **Variable-length traversal is outbound only.** `src/shard/query.rs:3976`
   requires `edge.src.id`, so an inbound pattern (whose source is the far,
   unidentified node) is always rejected, and a `$param` id is rejected too.
   This is a real modelling constraint: answering "who depends on X" requires
   materialising a reverse edge, roughly doubling edge count.

4. **Large UNWIND writes fail partway with HTTP 500.** Observed at ~1,500 rows
   of a 2,235-row edge batch against a fresh graph. Since the accepted size is
   not discoverable from the API, this project halves the batch and retries.

**A note on the image:** it runs as UID 10001, so Docker named volumes (created
root-owned) leave it unable to write its store. Every write fails while reads
succeed, and the suppressed error makes this look like a query problem. The
README documents this for bind mounts; named volumes reproduce it identically.
The devcontainer here runs the service as root.

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
  [npm registry API](https://registry.npmjs.org/). `fixtures/tanstack.json` and
  `fixtures/express.json` are real registry data captured with
  `hyperdefense snapshot`; each records its own capture time and provenance.
  `fixtures/typosquat-demo.json` and `fixtures/vulnerable-app-lock.json` are
  hand-authored and say so in their own provenance fields, because a clean
  registry subset contains no typosquats and no compromised lockfile to catch.
- Advisory data from [OSV](https://osv.dev).
- Incident details referenced in comments and docs come from public reporting on
  the September 2025 Shai-Hulud worm and the May 2026 TanStack compromise.

## License

[MIT](LICENSE).
