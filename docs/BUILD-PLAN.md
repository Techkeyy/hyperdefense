# HyperDefense build plan

Drafted 2026-08-14. Submission closes 2026-08-20, 11:59 PM PT. Six days.

Method follows the `build-process` skill: prove the risky part first, test pure
logic as it is written, keep the core deterministic, make it reproducible from
the first commit, and verify every external interface against reality instead of
assuming.

---

## Phase 0: pipeline map and the load-bearing module

Six stages, one job each, each independently testable.

| # | Stage | Job | Talks to | Certainty |
|---|-------|-----|----------|-----------|
| 1 | `fetch` | pull package, version, maintainer, timestamp data | npm registry | high, public documented API |
| 2 | `load` | write nodes and edges into the graph | HydraDB | **low** |
| 3 | `traverse` | the three graph queries that produce blast radius | HydraDB | **lowest** |
| 4 | `score` | rank risk from traversal output | pure logic | high, deterministic |
| 5 | `remediate` | emit lockfile patch and CI block rule | pure logic | high, deterministic |
| 6 | `report` | CLI render, JSON, PR comment | stdout, GitHub | medium |

**Load-bearing module: stage 3, `traverse`.**

Everything the project claims rests on HydraDB answering three traversal shapes:
transitive dependency closure, maintainer overlap, and a time-bounded version
window. If its OpenCypher subset cannot express those, the product does not
exist, and no amount of polish on stages 1, 4, 5, 6 saves it.

### Honest statement of current risk

The queries already written in `src/db/queries.ts` are **unverified guesses**.
They were authored against the README, not against a running server. Specific
things assumed and not yet checked:

- `MERGE` is supported. README advertises "batched UNWIND writes" and does not
  name MERGE.
- Variable-length patterns to depth 10 (`<-[:DEPENDS_ON*1..10]-`). README says
  "bounded variable-length paths" without stating the bound.
- `length(path)` and named path binding (`MATCH path = ...`).
- `collect(DISTINCT x)` inside aggregation.
- `WHERE x IN $list` with a parameter list.
- Bolt authentication via `neo4j.auth.bearer(token)`. The README documents
  `Authorization: Bearer` for the HTTP API; the Bolt equivalent is inferred.
- `CREATE CONSTRAINT` syntax. Already guarded with try/catch, which was the
  right instinct, and the same defensiveness now needs to extend to the rest.

One further signal from the README that likely changes the design: HydraDB ships
**native path procedures** (`algo.SPpaths`, `algo.SSpaths`, `algo.MSpaths`)
explicitly to "avoid client-side query fan-out." Hand-written variable-length
Cypher may be the wrong idiom here. `algo.MSpaths`, which resolves many
source-target pairs in one call, is both the likely-correct mechanism for
"42 compromised packages to all consumers" and the stronger Best Use of HydraDB
story. The probe must test both and the implementation should prefer the native
procedures where they work.

---

## Phase 1: build the risky core first and prove it

Nothing else proceeds until this is green.

**Deliverable: `hyperdefense doctor`**, a capability probe that connects to a
live HydraDB and prints a support matrix.

It runs each assumed feature as an isolated statement against a throwaway
subgraph, catches per-feature failures, and reports supported / unsupported /
degraded. It is simultaneously the Phase 1 proof and the Phase 6 self-check, so
it earns its place twice.

Probe list, in dependency order:

1. connect over Bolt, authenticate, run `RETURN 1`
2. create a node, read it back
3. `MERGE` a node twice, confirm one node exists (not two)
4. create a typed relationship, traverse it one hop
5. fixed-depth traversal `-[:R*2]-`
6. bounded variable-length `-[:R*1..5]-`, find the real ceiling
7. named path plus `length(path)`
8. `collect(DISTINCT ...)`, `count(DISTINCT ...)`
9. `UNWIND $list`, `WHERE x IN $list`
10. `algo.SPpaths`, `algo.SSpaths`, `algo.MSpaths` presence and signature

Proof standard: a printed matrix from a real connection. "It compiles" is not
proof. The matrix is committed as `docs/CAPABILITIES.md` so the design record
shows what was measured rather than assumed.

**Fork in the road.** The probe result decides the traversal design:

- All Cypher features supported: keep current queries, add native procedures as
  a fast path.
- Variable-length limited or absent: move traversal onto `algo.*` procedures.
- Neither available: fall back to iterative breadth-first expansion driven from
  the client, one hop per round trip. Slower, still correct, still graph-native.
  This is the floor, and it means the project survives the worst probe outcome.

Because a fallback exists at every branch, the load-bearing bet is survivable.
That is deliberate.

---

## Phase 2: test pure logic as it is written

Pure logic stays separate from I/O so it runs with no network and no server.

Already done: Levenshtein and typosquat classification, 7 tests passing.

To write alongside the code, not after:

- semver range matching, does version X satisfy range Y (off-by-one prone)
- exposure window boundary arithmetic, inclusive vs exclusive at both ends
- maintainer risk scoring, monotonic and clamped to 0..1
- blast radius de-duplication across the three layers, a package reachable by
  both dependency and maintainer paths must count once
- lockfile patch generation, output must be valid JSON and minimal

Each of these is a place a bug hides silently and a test finds instantly.

---

## Phase 3: deterministic core, optional intelligence

The scoring and remediation layers are **rules, not a model**. Same input, same
output, every run, with no API key required.

If an LLM appears at all it narrates and never decides: it may write the prose
summary of a blast radius, and it may not choose what is in one. A judge trusts
a deterministic merge gate; a model's verdict is a mood. This also keeps the
demo runnable offline.

---

## Phase 4: environment

Local Windows plus Docker Desktop is the write-and-run environment for now. The
documented HydraDB run command uses `$(id -u):$(id -g)`, which is Unix-only, so
the compose file already drops that and will need a real run to confirm volume
permissions behave.

Trigger to relocate: if bringing HydraDB up locally costs more than roughly two
hours, stop repairing the box and move the runtime to a clean container or cloud
VM, keeping editing local. Repairing a non-reproducible machine produces zero
project value. The replacement should double as the deliverable so that "where
the demo runs" and "how judges reproduce it" are answered by the same artifact.

---

## Phase 5: reproducibility from the first commit

Required, and scored directly by the judges.

- **One-command bring-up.** `docker compose up` plus a documented auth-token
  step. Every setup step gets written down as it is actually run, not
  remembered afterward. A step done once by hand and never recorded is a step a
  new user will hit and fail on.
- **Seed fixture.** A committed snapshot of the TanStack May 2026 compromise:
  42 packages, their maintainers, their dependents, real publish timestamps.
  This is both the demo scenario and the test corpus.
- **Offline path.** `--fixture` flag loads the seed from disk with no npm calls,
  so the tool is demoable and testable without the live registry. A judge with a
  flaky network still sees it work.

The fixture matters more than it looks: it makes the 3 minute demo video
deterministic and rehearsable, and removes live-network risk from the one
recording that gets judged.

---

## Phase 6: verify against reality

`hyperdefense doctor` extends to cover every external integration, not just the
database:

- **HydraDB**: the capability matrix from Phase 1.
- **npm registry**: fetch one known package, assert the real payload shape
  matches the parser, confirm `maintainers` and `time` are actually present and
  populated rather than assumed.

Two specific failure modes to defend against, both of which pass every
self-referential test while being completely broken:

1. an endpoint that echoes any well-formed request back as success, so an
   existence check always passes and the tool silently operates on nothing
2. a payload whose real shape differs from the docs, so the parser returns empty
   or junk while the code reports success

Rule for the whole build: if it was not run or fetched, it is not known, and the
README and the demo must not claim it.

---

## Phase 7: additive, honest, defensive

- Native `algo.*` procedures land as an **added** fast path with the working
  traversal kept as default until the new one is proven. The demo never breaks
  to chase an upgrade.
- Every external call is guarded so a failure degrades instead of crashing:
  npm rate limits, absent maintainer data, an optional GitHub write-back.
- Where HydraDB's exact behaviour is undocumented, read its capabilities at
  runtime and adapt, rather than hard-coding a guess.
- Verify side effects rather than exit codes. Note the known local hazard: git
  pushes on this machine stall behind the credential manager, so pushes run in
  the background with a long timeout and get confirmed with `ls-remote` rather
  than trusted because the command returned.

---

## Six-day allocation

| Day | Date | Focus | Done when |
|-----|------|-------|-----------|
| 1 | Aug 14 | HydraDB up locally, `doctor` probe written and run, capability matrix committed, traversal design chosen from the result | matrix exists from a real connection |
| 2 | Aug 15 | Rewrite the query layer against measured capability. Ingest working end to end on 10 packages. First real blast radius from live data | a true answer from a real graph |
| 3 | Aug 16 | Maintainer layer and temporal layer. TanStack fixture built and committed. Tests alongside | `--fixture` demo runs offline |
| 4 | Aug 17 | Scoring and remediation: lockfile patch, CI block rule. This is the "generates the fix" winner pattern | patch applies cleanly |
| 5 | Aug 18 | Report layer and one workflow surface (GitHub Action or PR comment). README with real run output | a stranger can follow the README |
| 6 | Aug 19 | Record demo video, final reproducibility pass from a clean clone, submit | submitted with a day of slack |

Aug 20 is held as buffer, not planned work. A plan that consumes its own
deadline has no room for the one thing that always goes wrong.

---

## Definition of done

- `docker compose up` then `npm run doctor` succeeds from a clean clone
- blast radius answers correctly on the committed TanStack fixture with no
  network
- all three graph layers demonstrably contribute to the answer, since one layer
  alone is the obvious project every other team ships
- remediation output is a real artifact a user can apply, not a warning
- tests green, README matches actual observed behaviour
- every claim in the README and the video traces to something that was run

## Explicitly out of scope

PyPI (npm only, done well), a web UI (CLI plus one workflow surface is enough
and is the adoption-tested shape), full-registry ingestion (seeded subgraph is
the honest scope for six days), and live worm detection (this analyses a known
compromise rather than discovering new ones).
