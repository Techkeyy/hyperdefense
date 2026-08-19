# Submission kit

Everything needed for the Hack Hydra form and the 3 minute video. Numbers here
are the ones the committed fixtures actually produce, so nothing in the video
has to be trusted on faith.

Deadline: **2026-08-20, 11:59 PM PT**. Anything past 3:00 in the video may not
be reviewed, so the script below is built to land at about 2:50.

---

## Before recording

Run once so the take starts from a known state and the numbers are identical
every time:

```bash
npm run demo -- --reset
```

Terminal set-up that makes the recording readable:

- Font size up. Judges may watch on a laptop.
- Window at roughly 100 columns. The demo's dividers are 64 wide and the PR
  comment table needs the room.
- Clear scrollback first (`clear`) so step 1 starts at the top.

---

## Video script (target 2:50)

### 0:00 to 0:25, the problem

> On May 11th 2026, attackers pushed 84 malicious versions across 42 TanStack
> packages in six minutes. The worm did not stop at those packages. It asked npm
> which other packages those maintainers owned, and republished those too.
>
> Every scanner you can buy answers "what depends on this". None of them answer
> "whose account can reach this". That second question is how these attacks
> actually spread.

### 0:25 to 0:40, what it is

> HyperDefense models npm as three graphs in HydraDB at once: dependencies,
> maintainer accounts, and the publish timeline. Everything you are about to see
> runs offline against committed real npm data.

Start the run:

```bash
npm run demo -- --reset
```

### 0:40 to 1:05, the number that matters (demo step 2)

Let step 1 scroll. Stop on step 2.

> Sixty two packages, two thousand versions, all real npm data.
>
> `@tanstack/router-core` is compromised. The dependency graph says three
> packages are affected. That is the answer a conventional scanner gives.
>
> But three maintainer accounts each publish ten more packages. Ten exposed, not
> three. Those seven extra are invisible to anything that only walks
> `require()`.

### 1:05 to 1:25, how it arrives (step 3)

> Knowing what is exposed is not the same as knowing what to do. This is
> HydraDB's native `algo.MSpaths` procedure, one call, returning the actual
> chains.
>
> `@babel/code-frame` reaches `@babel/core` five different ways. One is direct.
> The others run through `template`, through `traverse`, through `helpers`.
> Those middle packages are where you cut the link, and there is more than one
> link to cut. A set of names cannot tell you that; a path can.

On screen, type `@babel/code-frame` and `@babel/core` into the attack path
fields. This pair is verified against the committed export: five chains, one to
three hops. Do not use `history` to `react-router`, which an earlier draft of
this script called for. `history` is not a source in the export, so it returns
the not computed message, and the `router-core` to `react-router` pair is a
single direct edge that shows no intermediate at all, which is the one thing
this beat exists to demonstrate.

### 1:25 to 1:45, which version (step 4)

> Sixty versions of this package are in the graph. Given the compromise window,
> the last clean release was 1.169.2 and the first suspect one is 1.169.5,
> published nineteen hours into the incident. A second, 1.169.8, followed six
> minutes later.
>
> That is the version to pin back to, and it is derived, not guessed.

### 1:45 to 2:15, the fix and the gate (steps 5 and 6)

> It generates the fix, not just a warning: a blocklist, an npm overrides block,
> and a CI workflow.
>
> Then it enforces it. Against a vulnerable app's lockfile the gate exits one
> and blocks the merge, catching the nested transitive copy as well as the top
> level one. Against this repo's own 134 packages it passes.
>
> A gate you have never seen fail is not a gate. This one shows both.

### 2:15 to 2:40, where it lives

Cut to the PR comment (have it rendered and ready):

```bash
npm run dev -- pr-comment @tanstack/router-core \
  --blocklist .hyperdefense/blocklist.json \
  --lockfile fixtures/vulnerable-app-lock.json \
  --safe-version 1.0.0
```

> The finding lands on the pull request: the blast radius, the chains, and the
> pin to apply. It posts before the gate fails, because a blocked merge with no
> explanation is worse than no gate.
>
> And it closes the loop. `watch` checks all 137 packages in the graph against
> the OSV advisory feed and turns a published advisory straight into a blast
> radius.

### 2:40 to 2:50, why HydraDB

> This is a graph problem, not a similarity problem. No embedding encodes a
> transitive reverse dependency closure or a shared maintainer account.
> HydraDB's traversals and its native path procedures are doing the work, and
> the whole thing is reproducible from a clean clone.

---

## Recording notes

- **Do not narrate the whole of step 4.** Nine version lines scroll; say the two
  numbers that matter and move on.
- **`--reset` matters.** Without it the graph accumulates across runs and the
  counts drift from the script.
- If a step errors, stop and re-record. Do not talk over a failure.

---

## Form answers

**Project name**

HyperDefense

**Short description**

A multi-graph supply chain blast radius engine on HydraDB. It models npm as
dependency, maintainer, and temporal graphs at once, so a compromise can be
traced to everything it reaches, including the packages a shared maintainer
account puts at risk, then generates and enforces the fix.

**Problem being addressed**

Supply chain attacks stopped being isolated bad packages and became
self propagating worms. In the May 2026 TanStack compromise, 84 malicious
versions were published across 42 packages in six minutes, and the worm spread
by querying npm for other packages owned by the compromised maintainers and
republishing those.

Existing scanners answer "what depends on this package". They do not model
maintainer accounts as part of the attack surface, so the propagation mechanism
these campaigns actually use is invisible to them. On real npm data the gap is
large: for `body-parser` a dependency only view reports 1 affected package,
while including maintainer reach gives 31.

**What was built**

A CLI and CI gate over three graph layers in HydraDB:

- dependency graph for transitive blast radius
- maintainer graph, so packages reachable through a shared publisher account are
  surfaced, which is the differentiator
- temporal graph of the publish timeline, which identifies the first version
  inside a compromise window and the last clean release to pin back to

On top of that: `attack-path` uses HydraDB's native `algo.MSpaths` to return the
concrete chain by which a compromise reaches a given service; `remediate`
generates a blocklist, an npm overrides block, and a CI workflow; `verify` is
the gate, reading the lockfile rather than package.json because a compromise is
about the version that actually resolved; `pr-comment` puts the finding on the
pull request; and `watch` polls the OSV advisory feed and turns a new advisory
into a blast radius.

All analysis is rule based. No model is consulted, so results are identical run
to run and safe to gate a pipeline on.

**Deployed project link**

https://hyperdefense.vercel.app

A live dashboard, no backend required: it serves query results captured from a
real HydraDB instance, so every number on it is one the engine produced. Search
a package to see its blast radius, pick a compromised package and click any of
the packages it reaches to trace the route, and run the CI gate against a
committed lockfile.

Mirror: https://techkeyy.github.io/hyperdefense

The CLI is the primary interface and the gate is what a team would actually run
in a pipeline. A judge can run the whole thing from a Codespace with
`npm run demo`, offline, against committed real npm data.

**How the project uses the HydraDB Open Source Repo**

HydraDB is the graph store and the traversal engine; there is no product
without it.

- Ingestion writes nodes and edges through HydraDB's UNWIND batch mutations,
  which is the only supported path for bulk node writes.
- Blast radius is a bounded variable length traversal over a materialised
  reverse edge.
- Lateral movement is a two hop traversal through a shared maintainer node with
  `collect()`.
- Attack paths use the native `algo.MSpaths` path procedure.

The query layer was written against HydraDB's real executable Cypher subset,
which we mapped from the engine source and then corrected against a live server.
That work is documented in `docs/HYDRADB-CYPHER-SPEC.md` and the measured
capability matrix in `docs/CAPABILITIES.md`, including several findings that
changed the data model: variable length traversal is outbound only and requires
a literal source id, which is why the reverse edge is materialised; and
`algo.MSpaths` returns shortest paths per pair rather than a reachable set, so
it is used for attack paths and deliberately not for reachability.

Three findings from that work are filed upstream, each with a reproduction and
the source line: [#107](https://github.com/hydra-db/hydradb/issues/107) (query
errors suppressed on both transports, now being fixed in
[PR #110](https://github.com/hydra-db/hydradb/pull/110)),
[#108](https://github.com/hydra-db/hydradb/issues/108) (UID 10001 against Docker
named volumes), and [#109](https://github.com/hydra-db/hydradb/issues/109)
(variable-length MATCH source id constraint, documentation).

**Tech stack**

TypeScript, Node 22, HydraDB (Bolt and its HTTP query API), the public npm
registry API, OSV for advisories, Vitest, and a dev container that brings
HydraDB up as a sibling service.

**Team members and individual contributions**

Techkeyy: sole contributor. Research and idea selection, data model, HydraDB
query layer, ingestion, all three analysis layers, remediation and CI gate, PR
comment and advisory surfaces, tests, and documentation.

**GitHub repository**

https://github.com/Techkeyy/hyperdefense

**Demo video**

(paste the unlisted link once recorded, and open it in a private window first to
confirm it plays without a sign in)

---

## Final checks before submitting

- [ ] Video is 3:00 or under
- [ ] Video link opens in a private window without asking for access
- [ ] Repo is public
- [ ] `npm run demo -- --reset` runs clean end to end
- [ ] Form submitted before 2026-08-20 11:59 PM PT
