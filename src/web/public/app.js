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

async function api(path) {
  const res = await fetch(path);
  const body = await res.json().catch(() => ({ error: "bad response" }));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/* ---------------------------------------------------------------- search */
let PACKAGES = [];

async function boot() {
  try {
    const { packages } = await api("/api/packages");
    PACKAGES = packages;
    if (packages.length > 0) {
      $("explore-empty").hidden = true;
      // Prefer a package that actually shows the argument well.
      const preferred = ["body-parser", "@tanstack/router-core", packages[0]];
      const start = preferred.find((p) => packages.includes(p));
      if (start) select(start);
    }
  } catch {
    // Leave the empty state in place. An unreachable API must not render as
    // an empty graph, which would look like a package with no exposure.
    $("explore-empty").textContent =
      "Cannot reach the API. Is HydraDB running, and has a graph been ingested?";
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

/* ---------------------------------------------------------------- paths */
$("p-go").addEventListener("click", async () => {
  const from = $("p-from").value.trim();
  const to = $("p-to").value.trim();
  const out = $("path-out");
  if (!from || !to) {
    out.innerHTML = `<p class="num dim">Enter both a compromised package and a target.</p>`;
    return;
  }
  out.innerHTML = `<p class="num dim">Tracing...</p>`;
  try {
    const r = await api(`/api/paths?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    if (r.error) {
      out.innerHTML = `<p class="num" style="color:var(--accent)">The path query failed: ${r.error}</p>`;
      return;
    }
    if (r.undecodableRows > 0) {
      // Never present a decode failure as an absence of paths.
      out.innerHTML = `<p class="num" style="color:var(--accent)">${r.undecodableRows} rows returned but could not be decoded. This is a bug, not an absence of paths.</p>`;
      return;
    }
    if (r.paths.length === 0) {
      out.innerHTML = `<p class="num dim">No path from ${from} to ${to} within 6 hops.</p>`;
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
    out.innerHTML = `<p class="num" style="color:var(--accent)">${err.message}</p>`;
  }
});

/* ----------------------------------------------------------------- gate */
$("g-go").addEventListener("click", async () => {
  const out = $("gate-out");
  const pkg = $("q").value.trim() || "@tanstack/router-core";
  out.innerHTML = `<p class="num dim">Running the gate...</p>`;
  try {
    const r = await api(`/api/gate/${encodeURIComponent(pkg)}`);
    out.innerHTML = "";
    out.appendChild(gateCard("Vulnerable application", "fixtures/vulnerable-app-lock.json", r.vulnerable));
    out.appendChild(gateCard("This repository", "package-lock.json", r.own));
  } catch (err) {
    out.innerHTML = `<p class="num" style="color:var(--accent)">${err.message}</p>`;
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
