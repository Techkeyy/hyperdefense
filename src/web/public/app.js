/*
 * HyperDefense dashboard client.
 *
 * No framework and no build step on purpose: this is a second view of the same
 * engine, and it should not become a second project to maintain three days
 * before a deadline. Every number rendered here comes from an endpoint that
 * calls the same analysis function the CLI calls.
 */

const $ = (id) => document.getElementById(id);

/* nav: every link must actually go somewhere ---------------------------- */
document.querySelectorAll("[data-to]").forEach((el) => {
  el.addEventListener("click", () => {
    document.getElementById(el.dataset.to)?.scrollIntoView({ behavior: "smooth" });
  });
});

/*
 * Live API first, precomputed export second.
 *
 * The dashboard has to work in two places: against a running HydraDB, and as a
 * static deploy where a reader can look at it without installing anything. The
 * static path is not a lesser demo, it is the same query results captured by
 * `hyperdefense export`, so the page renders identically either way.
 */
let STATIC_MODE = false;

async function api(path) {
  if (!STATIC_MODE) {
    let res;
    try {
      res = await fetch(path);
    } catch {
      // No server at all.
      STATIC_MODE = true;
      return staticApi(path);
    }

    // Distinguish "our API answered, and the answer is no" from "there is no
    // API here". A static host returns 404 with an HTML body for /api/*, and
    // reading that as a real not-found answer is what kept the fallback from
    // ever engaging on a deploy. Only a JSON response is our API talking.
    const type = res.headers.get("content-type") || "";
    if (!type.includes("application/json")) {
      STATIC_MODE = true;
      return staticApi(path);
    }

    const body = await res.json().catch(() => null);
    if (body === null) {
      STATIC_MODE = true;
      return staticApi(path);
    }
    if (res.ok) return body;
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return staticApi(path);
}

async function staticFile(name) {
  // Relative, not absolute. A subpath deploy (GitHub Pages serves at
  // /<repo>/) would 404 on "/data/..." while working fine locally, which is
  // the kind of break that only shows up after publishing.
  const res = await fetch(`./data/${name}`);
  if (!res.ok) throw new Error(`no precomputed data for ${name}`);
  return res.json();
}

async function staticApi(path) {
  if (path === "/api/packages") {
    const m = await staticFile("manifest.json");
    markStatic(m.generatedAt);
    return { packages: m.featured };
  }
  if (path.startsWith("/api/graph/")) {
    const pkg = decodeURIComponent(path.slice("/api/graph/".length));
    return staticFile(`graph-${encodeURIComponent(pkg)}.json`);
  }
  if (path.startsWith("/api/paths")) {
    const u = new URL(path, location.origin);
    const from = u.searchParams.get("from");
    const to = u.searchParams.get("to");

    // A name that is not in the graph at all is a different answer from a pair
    // this deploy did not precompute. Reporting the second for the first reads
    // as "that pair exists, it just is not cached", which is wrong and sends
    // the reader looking for a local run that would not help either.
    const m = await staticFile("manifest.json");
    const known = new Set([...(m.packages ?? []), ...(m.featured ?? [])]);
    const unknown = [from, to].filter((n) => !known.has(n));
    if (unknown.length > 0) {
      throw new Error(
        `Not a package in this graph: ${unknown.join(", ")}. ` +
          `Pick a name from the suggestions in either field.`,
      );
    }

    const all = await staticFile("paths.json");
    // The first export wrote a flat from|to map. Read either shape so the page
    // keeps working against data exported before this change.
    const pairs = all.pairs ?? all;
    const exhausted = new Set(all.exhausted ?? []);
    const maxHops = all.maxHops ?? 6;

    const hit = pairs[`${from}|${to}`];
    if (hit) return hit;

    // If every target reachable from `from` was queried, then this pair having
    // no entry is the answer, not a hole in the export.
    if (exhausted.has(from)) {
      return { paths: [], undecodableRows: 0, maxHops };
    }

    throw new Error(
      `Both packages are in the graph, but this deploy has no precomputed ` +
        `paths out of ${from}. Run it locally against HydraDB to trace any pair.`,
    );
  }
  if (path.startsWith("/api/gate/")) return staticFile("gate.json");
  throw new Error("not available in the static build");
}

function markStatic(generatedAt) {
  const el = document.getElementById("mode-note");
  if (!el) return;
  const when = new Date(generatedAt).toISOString().slice(0, 10);
  el.textContent =
    `Precomputed from a live HydraDB on ${when}. Every number is a real query ` +
    `result. Run it locally to query the graph yourself.`;
  el.hidden = false;
}

/* ---------------------------------------------------------------- search */
let PACKAGES = [];

async function boot() {
  try {
    const { packages } = await api("/api/packages");
    PACKAGES = packages;
    // The path fields took free text with nothing to guide them, so a plausible
    // looking typo came back as a missing path rather than a bad name.
    const list = $("pkglist");
    if (list) {
      list.innerHTML = "";
      for (const name of packages) {
        const o = document.createElement("option");
        o.value = name;
        list.appendChild(o);
      }
    }
    syncTargetList();
    if (packages.length > 0) {
      $("explore-empty").hidden = true;
      // Prefer a package that actually shows the argument well.
      const preferred = ["body-parser", "@tanstack/router-core", packages[0]];
      const start = preferred.find((p) => packages.includes(p));
      if (start) select(start);
    }
  } catch (err) {
    // Leave the empty state in place. An unreachable API must not render as
    // an empty graph, which would look like a package with no exposure.
    $("explore-empty").textContent = STATIC_MODE
      ? `No precomputed data found. ${err.message}`
      : "Cannot reach the API. Is HydraDB running, and has a graph been ingested?";
  }
}

const q = $("q");
const suggest = $("suggest");

q.addEventListener("input", () => {
  const v = q.value.trim().toLowerCase();
  if (!v) { suggest.hidden = true; return; }
  const hits = PACKAGES.filter((p) => p.toLowerCase().includes(v)).slice(0, 12);
  if (hits.length === 0) { suggest.hidden = true; return; }
  suggest.innerHTML = "";
  for (const h of hits) {
    const d = document.createElement("div");
    d.textContent = h;
    d.addEventListener("click", () => { q.value = h; suggest.hidden = true; select(h); });
    suggest.appendChild(d);
  }
  suggest.hidden = false;
});

q.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    suggest.hidden = true;
    const v = q.value.trim();
    if (v) select(v);
  }
});

document.addEventListener("click", (e) => {
  if (!suggest.contains(e.target) && e.target !== q) suggest.hidden = true;
});

/* ---------------------------------------------------------------- select */
async function select(pkg) {
  q.value = pkg;
  $("p-from").value = pkg;
  try {
    const g = await api(`/api/graph/${encodeURIComponent(pkg)}`);
    $("explore-empty").hidden = true;
    $("explore-body").hidden = false;

    const lateral = g.stats.total - g.stats.dependencyOnly;
    $("m-down").textContent = g.stats.dependencyOnly;
    $("m-lateral").textContent = lateral;
    $("m-total").textContent = g.stats.total;
    $("m-accounts").textContent = g.stats.maintainers;

    // Keep the hero honest: it shows whatever is actually selected.
    $("hero-dep").textContent = g.stats.dependencyOnly;
    $("hero-total").textContent = g.stats.total;
    $("hero-note").textContent = `${pkg}, live from the graph`;

    const down = g.nodes.filter((n) => n.kind === "dependent").map((n) => n.id);
    const lat = g.nodes.filter((n) => n.kind === "lateral").map((n) => n.id);
    fillList("list-down", down);
    fillList("list-lateral", lat);

    draw(g);
  } catch (err) {
    $("explore-body").hidden = true;
    $("explore-empty").hidden = false;
    $("explore-empty").textContent = err.message;
  }
}

function fillList(id, items) {
  const ul = $(id);
  ul.innerHTML = "";
  if (items.length === 0) {
    const li = document.createElement("li");
    li.textContent = "none";
    li.style.color = "var(--text-3)";
    ul.appendChild(li);
    return;
  }
  for (const i of items.sort()) {
    const li = document.createElement("li");
    li.textContent = i;
    ul.appendChild(li);
  }
}

/* ----------------------------------------------------------- force graph */
const COLORS = {
  source: "#ff6b5a",
  dependent: "#e8a13a",
  maintainer: "#7aa2f7",
  lateral: "#565660",
};

let anim = null;

function draw(g) {
  const canvas = $("graph");
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Seeded start positions so the same package lays out the same way twice.
  // A layout that jumps on every render reads as noise rather than structure.
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  const nodes = g.nodes.map((n) => ({
    ...n,
    x: W / 2 + (rnd() - 0.5) * W * 0.65,
    y: H / 2 + (rnd() - 0.5) * H * 0.65,
    vx: 0, vy: 0,
    r: n.kind === "source" ? 9 : n.kind === "maintainer" ? 6.5 : 4.5,
  }));
  const index = new Map(nodes.map((n) => [n.id, n]));
  const links = g.links
    .map((l) => ({ s: index.get(l.source), t: index.get(l.target), kind: l.kind }))
    .filter((l) => l.s && l.t);

  if (anim) cancelAnimationFrame(anim);
  let tick = 0;

  function step() {
    tick++;
    // Repulsion, capped so a hub node cannot fling everything off-canvas.
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = rnd() - 0.5; dy = rnd() - 0.5; d2 = 1; }
        const f = Math.min(1600 / d2, 2.2);
        const d = Math.sqrt(d2);
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
      }
    }
    // Springs.
    for (const l of links) {
      const dx = l.t.x - l.s.x, dy = l.t.y - l.s.y;
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
      const f = (d - 90) * 0.012;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      l.s.vx += fx; l.s.vy += fy; l.t.vx -= fx; l.t.vy -= fy;
    }
    // Centre pull + damping, and the source is pinned to the middle so the
    // picture always reads outward from the compromised package.
    for (const n of nodes) {
      n.vx += (W / 2 - n.x) * 0.0016;
      n.vy += (H / 2 - n.y) * 0.0016;
      n.vx *= 0.86; n.vy *= 0.86;
      n.x += n.vx; n.y += n.vy;
      n.x = Math.max(n.r + 8, Math.min(W - n.r - 8, n.x));
      n.y = Math.max(n.r + 8, Math.min(H - n.r - 8, n.y));
    }
    const src = nodes.find((n) => n.kind === "source");
    if (src) { src.x += (W / 2 - src.x) * 0.2; src.y += (H / 2 - src.y) * 0.2; }

    render(ctx, W, H, nodes, links);
    if (tick < 420) anim = requestAnimationFrame(step);
  }
  step();
}

function render(ctx, W, H, nodes, links) {
  ctx.clearRect(0, 0, W, H);

  for (const l of links) {
    ctx.strokeStyle = l.kind === "publishes"
      ? "rgba(122,162,247,0.16)"
      : "rgba(232,161,58,0.16)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(l.s.x, l.s.y);
    ctx.lineTo(l.t.x, l.t.y);
    ctx.stroke();
  }

  for (const n of nodes) {
    if (n.kind === "source") {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r + 7, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,107,90,0.14)";
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    ctx.fillStyle = COLORS[n.kind];
    ctx.fill();
  }

  // Label only what a reader can act on: the source and the accounts. Labelling
  // every node turns the picture into a wall of text.
  ctx.font = "10px 'Space Grotesk', monospace";
  ctx.textAlign = "center";
  for (const n of nodes) {
    if (n.kind !== "source" && n.kind !== "maintainer") continue;
    ctx.fillStyle = n.kind === "source" ? "#ececee" : "#8a8a95";
    ctx.fillText(n.id, n.x, n.y - n.r - 7);
  }
}

/**
 * Escape text destined for innerHTML.
 *
 * The package names in these messages come straight from the input fields, so
 * interpolating them raw let a typed <img onerror=...> execute. Self-inflicted
 * only, and there is no session or backend to steal here, but a tool that
 * argues about supply chain safety should not render whatever it is handed.
 */
function esc(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/* ---------------------------------------------------------------- paths */

/**
 * The targets a source can actually reach, or null when that is unknown.
 *
 * Offering all 53 packages in the target field while a source like
 * body-parser reaches exactly one of them turns the feature into a guessing
 * game, where a correct "no path" answer arrives over and over and reads like
 * a broken page. Only the static export carries the full pair index; in server
 * mode the live query answers directly and there is nothing to narrow against.
 */
async function reachableFrom(from) {
  if (!STATIC_MODE || !from) return null;
  try {
    const all = await staticFile("paths.json");
    const pairs = all.pairs ?? all;
    if (!new Set(all.exhausted ?? []).has(from)) return null;
    const prefix = `${from}|`;
    return Object.keys(pairs)
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
      .sort();
  } catch {
    return null;
  }
}

// Narrow the target suggestions as soon as a source is chosen.
async function syncTargetList() {
  const list = $("tolist");
  if (!list) return;
  const reach = await reachableFrom($("p-from").value.trim());
  const names = reach ?? PACKAGES;
  list.innerHTML = "";
  for (const name of names) {
    const o = document.createElement("option");
    o.value = name;
    list.appendChild(o);
  }
  const hint = $("p-hint");
  const chips = $("p-reach");
  if (!hint || !chips) return;
  const from = $("p-from").value.trim();
  chips.innerHTML = "";

  if (reach && reach.length > 0) {
    hint.textContent =
      reach.length === 1
        ? `${from} reaches 1 package, click it to trace:`
        : `${from} reaches ${reach.length} packages, click one to trace:`;
    for (const name of reach) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "reach-chip";
      b.textContent = name;
      b.addEventListener("click", () => {
        $("p-to").value = name;
        runTrace(from, name);
      });
      chips.appendChild(b);
    }
  } else if (reach) {
    hint.textContent = `${from} reaches no package in this graph`;
  } else {
    hint.textContent = "";
  }
}
$("p-from").addEventListener("input", syncTargetList);
$("p-from").addEventListener("change", syncTargetList);

async function runTrace(from, to) {
  const out = $("path-out");
  if (!from || !to) {
    out.innerHTML = `<p class="num dim">Enter both a compromised package and a target.</p>`;
    return;
  }
  out.innerHTML = `<p class="num dim">Tracing...</p>`;
  try {
    const r = await api(`/api/paths?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    if (r.error) {
      out.innerHTML = `<p class="num" style="color:var(--accent)">The path query failed: ${esc(r.error)}</p>`;
      return;
    }
    if (r.undecodableRows > 0) {
      // Never present a decode failure as an absence of paths.
      out.innerHTML = `<p class="num" style="color:var(--accent)">${r.undecodableRows} rows returned but could not be decoded. This is a bug, not an absence of paths.</p>`;
      return;
    }
    if (r.paths.length === 0) {
      const hops = r.maxHops ?? 6;
      const reach = await reachableFrom(from);
      let extra = "";
      if (reach && reach.length > 0) {
        // The chips under the form already carry these names and are
        // clickable, so repeating them here would be noise.
        extra = $("p-reach").childElementCount > 0
          ? ` Pick one of the ${reach.length} it does reach, below.`
          : ` It reaches ${reach.slice(0, 8).join(", ")}.`;
      } else if (reach) {
        extra = ` It reaches no package in this graph.`;
      }
      out.innerHTML = `<p class="num dim">No attack path from ${esc(from)} to ${esc(to)} within ${hops} hops. HydraDB searched every package ${esc(from)} reaches.${esc(extra)}</p>`;
      return;
    }
    out.innerHTML = "";
    for (const p of r.paths.slice(0, 12)) {
      const div = document.createElement("div");
      div.className = "chain";
      p.chain.forEach((hop, i) => {
        const s = document.createElement("span");
        s.className = "hop" + (i === 0 ? " first" : i === p.chain.length - 1 ? " last" : "");
        s.textContent = hop;
        div.appendChild(s);
        if (i < p.chain.length - 1) {
          const sep = document.createElement("span");
          sep.className = "sep";
          sep.textContent = "->";
          div.appendChild(sep);
        }
      });
      const len = document.createElement("span");
      len.className = "len";
      len.textContent = `${p.hops} hop${p.hops === 1 ? "" : "s"}`;
      div.appendChild(len);
      out.appendChild(div);
    }
  } catch (err) {
    out.innerHTML = `<p class="num" style="color:var(--accent)">${esc(err.message)}</p>`;
  }
}

$("p-go").addEventListener("click", () =>
  runTrace($("p-from").value.trim(), $("p-to").value.trim()),
);

/* ----------------------------------------------------------------- gate */
$("g-go").addEventListener("click", async () => {
  const out = $("gate-out");
  const pkg = $("q").value.trim() || "@tanstack/router-core";
  out.innerHTML = `<p class="num dim">Running the gate...</p>`;
  try {
    const r = await api(`/api/gate/${encodeURIComponent(pkg)}`);
    out.innerHTML = "";

    // On a static deploy the gate result is precomputed for one package, so
    // asking about another returns that one regardless. Say which package the
    // result is actually for rather than letting it read as an answer about
    // whatever happens to be in the search box.
    const ranFor = r.package || pkg;
    if (ranFor !== pkg) {
      const note = document.createElement("p");
      note.className = "num dim";
      note.style.margin = "0 0 14px";
      note.textContent =
        `This deploy has one precomputed gate run, for ${ranFor}. ` +
        `Run it locally to gate ${pkg}.`;
      out.appendChild(note);
    }

    out.appendChild(gateCard(`Vulnerable application, gating ${ranFor}`, "fixtures/vulnerable-app-lock.json", r.vulnerable));
    out.appendChild(gateCard(`This repository, gating ${ranFor}`, "package-lock.json", r.own));
  } catch (err) {
    out.innerHTML = `<p class="num" style="color:var(--accent)">${esc(err.message)}</p>`;
  }
});

function gateCard(title, target, result) {
  const el = document.createElement("div");
  el.className = "gate-card " + (result.ok ? "pass" : "fail");
  const verdict = result.ok ? "Pass, exit 0" : "Blocked, exit 1";
  el.innerHTML = `
    <div class="gate-verdict">${verdict}</div>
    <div class="gate-target">${title} / ${target} / ${result.packagesScanned} resolved packages scanned</div>
  `;
  for (const v of (result.violations || []).slice(0, 6)) {
    const row = document.createElement("div");
    row.className = "gate-row";
    row.textContent = `${v.package}@${v.version}`;
    el.appendChild(row);
  }
  if (result.ok) {
    const row = document.createElement("div");
    row.className = "gate-row";
    row.textContent = "No blocked version resolved";
    el.appendChild(row);
  }
  return el;
}

boot();
