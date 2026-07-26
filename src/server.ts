// HTTP layer. Node's built-in http server, no framework: the routing surface is
// four paths and a dependency that has to be patched on someone else's schedule
// is a poor trade for that.

import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { determine, money, type ProjectInput, type Determination } from "./domain/permits.js";
import { migrate, seed, loadJurisdictions, loadProjectTypes, recordDetermination, recentDeterminations, pool } from "./db.js";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "web", "base.css"), "utf8");

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const DISCIPLINE_COLOR: Record<string, string> = {
  planning: "var(--violet)", historic: "#c98a4b", building: "var(--accent)", row: "var(--blue)",
  electrical: "var(--amber)", plumbing: "#6fc3e8", mechanical: "#b9c4cc", fire: "var(--rose)",
};

const CHECKBOXES: Array<[keyof ProjectInput, string]> = [
  ["changesFootprint", "Changes building footprint"],
  ["changeOfOccupancy", "Change of occupancy"],
  ["historicDistrict", "In a historic district"],
  ["rowWork", "Work in the public right of way"],
  ["electricalWork", "Electrical work"],
  ["plumbingWork", "Plumbing work"],
  ["mechanicalWork", "Mechanical / HVAC work"],
  ["structuralRoofWork", "Structural roof work"],
];

function scopeFromQuery(q: URLSearchParams): ProjectInput {
  const on = (k: string) => q.get(k) === "1";
  const first = q.get("type") ?? "adu";
  const val = q.get("valuation");
  return {
    type: first,
    valuation: val ? Number(val) : null,
    changesFootprint: q.has("submitted") ? on("changesFootprint") : true,
    changeOfOccupancy: q.has("submitted") ? on("changeOfOccupancy") : false,
    historicDistrict: q.has("submitted") ? on("historicDistrict") : false,
    rowWork: q.has("submitted") ? on("rowWork") : true,
    electricalWork: q.has("submitted") ? on("electricalWork") : true,
    plumbingWork: q.has("submitted") ? on("plumbingWork") : true,
    mechanicalWork: q.has("submitted") ? on("mechanicalWork") : true,
    structuralRoofWork: q.has("submitted") ? on("structuralRoofWork") : false,
  };
}

function renderPage(
  d: Determination, scope: ProjectInput, jurisdictions: Record<string, any>,
  types: Record<string, any>, comparison: Array<{ key: string; name: string; days: number; permits: number }>,
  recent: any[],
): string {
  const q = (over: Record<string, string>) => {
    const p = new URLSearchParams({ submitted: "1", type: scope.type, jurisdiction: d.jurisdiction.key });
    if (scope.valuation) p.set("valuation", String(scope.valuation));
    for (const [k] of CHECKBOXES) if ((scope as any)[k]) p.set(k, "1");
    for (const [k, v] of Object.entries(over)) v === "" ? p.delete(k) : p.set(k, v);
    return "/?" + p.toString();
  };

  const toggle = (k: string) => {
    const p = new URLSearchParams({ submitted: "1", type: scope.type, jurisdiction: d.jurisdiction.key });
    if (scope.valuation) p.set("valuation", String(scope.valuation));
    for (const [kk] of CHECKBOXES) if ((scope as any)[kk]) p.set(kk, "1");
    (scope as any)[k] ? p.delete(k) : p.set(k, "1");
    return "/?" + p.toString();
  };

  const maxDays = Math.max(...d.schedule.map((s) => s.cumulative), 1);
  const worst = Math.max(...comparison.map((c) => c.days));

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sequence — what a construction project actually has to file</title>
<meta name="description" content="A permit requirement engine: per-jurisdiction rules from Postgres, a topologically ordered review sequence, expected correction cycles, and the escalations that cause the most rejections.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📋</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;550;650&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
<style>${css}</style></head><body>
<header class="top"><div class="top-inner">
  <div class="brand"><h1>Sequence</h1><span class="tag">permit requirements</span></div>
  <div class="top-spacer"></div>
  <nav class="nav"><a href="/">Determine</a><a href="/api/determine?${new URLSearchParams({ type: scope.type, jurisdiction: d.jurisdiction.key })}" target="_blank" rel="noopener">API</a></nav>
</div></header>
<div class="wrap">
<p class="lede">The expensive failure in construction permitting is order, not rejection. Reviews form a partial
order rather than a queue, and a package filed before its prerequisite clears loses weeks that no amount of
expediting recovers. This determines which permits a scope triggers in a given jurisdiction, sorts them into
stages that can be filed in parallel, and prices the wait including the correction rounds everyone forgets.</p>

<div class="panel"><h2>Project</h2><div class="pad">
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px">
    <label class="fld">Jurisdiction<select onchange="location=this.value">
      ${Object.values(jurisdictions).map((j: any) => `<option value="${esc(q({ jurisdiction: j.key }))}" ${j.key === d.jurisdiction.key ? "selected" : ""}>${esc(j.name)}</option>`).join("")}
    </select></label>
    <label class="fld">Project type<select onchange="location=this.value">
      ${Object.values(types).map((t: any) => `<option value="${esc(q({ type: t.key, valuation: "" }))}" ${t.key === scope.type ? "selected" : ""}>${esc(t.label)}</option>`).join("")}
    </select></label>
    <label class="fld">Valuation
      <form method="get" style="display:flex;gap:6px">
        <input type="hidden" name="submitted" value="1"><input type="hidden" name="type" value="${esc(scope.type)}">
        <input type="hidden" name="jurisdiction" value="${esc(d.jurisdiction.key)}">
        ${CHECKBOXES.filter(([k]) => (scope as any)[k]).map(([k]) => `<input type="hidden" name="${k}" value="1">`).join("")}
        <input type="number" name="valuation" value="${d.project.valuation}" step="5000" style="flex:1">
        <button class="primary" type="submit">Set</button>
      </form>
    </label>
  </div>
  <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:14px">
    ${CHECKBOXES.map(([k, label]) => `<a href="${esc(toggle(k as string))}" style="text-decoration:none">
      <span class="chip ${(scope as any)[k] ? "ok" : "mute"}" style="font-size:11px;padding:5px 10px">${(scope as any)[k] ? "✓" : "○"} ${esc(label)}</span></a>`).join("")}
  </div>
</div></div>

<div class="metrics" style="margin-top:18px">
  <div class="metric"><div class="k">Permits required</div><div class="v">${d.required.length}</div><div class="sub">${d.schedule.length} sequential stages</div></div>
  <div class="metric ${d.totalDays > 100 ? "bad" : d.totalDays > 60 ? "warn" : "good"}"><div class="k">Calendar days</div><div class="v">${d.totalDays}</div><div class="sub">review plus corrections</div></div>
  <div class="metric"><div class="k">Correction rounds</div><div class="v">${d.jurisdiction.correctionRounds.toFixed(1)}</div><div class="sub">${d.jurisdiction.correctionDays}d each</div></div>
  <div class="metric ${d.project.valuation >= d.jurisdiction.valuationThresholdEngineered ? "warn" : ""}"><div class="k">Valuation</div><div class="v" style="font-size:20px">${money(d.project.valuation)}</div><div class="sub">${d.project.valuation >= d.jurisdiction.valuationThresholdEngineered ? "engineered drawings" : "below threshold"}</div></div>
</div>

<div class="cols">
  <div class="panel"><h2>Review sequence</h2>
    ${d.schedule.map((st) => `<div class="dsec">
      <div style="display:flex;gap:9px;align-items:baseline;margin-bottom:7px">
        <span class="chip mute">Stage ${st.layer}</span>
        <span class="mono" style="font-size:11px;color:var(--ink-3)">${st.reviewDays}d review + ${st.correctionDays}d corrections = ${st.layerDays}d</span>
        <span style="flex:1"></span><span class="mono" style="font-size:11.5px;color:var(--ink)">day ${st.cumulative}</span>
      </div>
      ${st.permits.map((p) => `<div style="display:flex;gap:8px;align-items:baseline;padding:3px 0">
        <span style="width:8px;height:8px;border-radius:50%;background:${DISCIPLINE_COLOR[p.discipline]};flex-shrink:0;margin-top:5px"></span>
        <div style="flex:1;min-width:0"><div style="font-size:12.5px;color:var(--ink)">${esc(p.name)}</div>
        <div class="note">${esc(p.why)}</div></div></div>`).join("")}
      <div class="bar" style="margin-top:8px"><i style="width:${(st.cumulative / maxDays) * 100}%;background:${DISCIPLINE_COLOR[st.permits[0]!.discipline]}"></i></div>
      ${st.permits.length > 1 ? `<div class="note" style="margin-top:5px">These ${st.permits.length} can be filed in parallel, so the stage costs the slowest review, not their sum.</div>` : ""}
    </div>`).join("") || '<div class="empty">No permits required for this scope.</div>'}
  </div>

  <div>
    <div class="panel"><h2>Jurisdiction escalations</h2><div class="pad">
      ${d.flags.length ? d.flags.map((f) => `<div class="card" style="margin-bottom:8px;border-color:#7a6024"><div class="act">${esc(f)}</div></div>`).join("")
        : '<div class="note">No jurisdiction-specific escalations triggered by this scope.</div>'}
    </div></div>

    <div class="panel"><h2>Same project, other jurisdictions</h2><div class="pad">
      ${comparison.map((c) => `<div style="padding:7px 0;border-bottom:1px solid var(--line)">
        <div style="display:flex;gap:9px;font-size:12px;align-items:baseline">
          <a href="${esc(q({ jurisdiction: c.key }))}" style="color:${c.key === d.jurisdiction.key ? "var(--accent)" : "var(--ink-2)"};flex:1;text-decoration:none">${esc(c.name)}</a>
          <span class="mono" style="color:var(--ink-3)">${c.permits} permits</span>
          <span class="mono" style="min-width:46px;text-align:right;color:${c.key === d.jurisdiction.key ? "var(--accent)" : "var(--ink)"}">${c.days}d</span>
        </div>
        <div class="bar"><i style="width:${(c.days / worst) * 100}%;background:${c.key === d.jurisdiction.key ? "var(--accent)" : "var(--line-2)"}"></i></div>
      </div>`).join("")}
      <div class="note" style="margin-top:9px">${esc(d.jurisdiction.notes)}</div>
    </div></div>

    <div class="panel"><h2>Not triggered</h2><div class="pad">
      ${d.notRequired.map((p) => `<div style="display:flex;gap:8px;padding:3px 0;font-size:12px;opacity:.6">
        <span class="chip mute" style="min-width:52px;font-size:9.5px">n/a</span>
        <span style="color:var(--ink-3)">${esc(p.name)}</span></div>`).join("") || '<div class="note">Every permit in the rule set applies.</div>'}
    </div></div>

    <div class="panel"><h2>Recent determinations</h2><div class="pad">
      <table class="tbl"><thead><tr><th>Project</th><th>Jurisdiction</th><th class="num">Permits</th><th class="num">Days</th></tr></thead>
      <tbody>${recent.map((r) => `<tr><td style="color:var(--ink-2)">${esc(r.project_label)}</td>
        <td style="color:var(--ink-3)">${esc(r.jurisdiction_name)}</td>
        <td class="num">${r.permit_count ?? 0}</td><td class="num">${r.total_days}</td></tr>`).join("")}</tbody></table>
      <div class="note" style="margin-top:9px">Every determination is persisted, which is what makes
      &ldquo;how long does an ADU actually take in Seattle&rdquo; answerable from data rather than from memory.</div>
    </div></div>
  </div>
</div>

<footer class="foot">
  <p style="margin:0 0 9px"><strong>How it is built.</strong> TypeScript on Node with PostgreSQL. Each permit
  carries a predicate over the project and jurisdiction plus an <code>after</code> list of prerequisites, so the
  output is a topological layering rather than a checklist: permits land in the earliest stage where all their
  predecessors have cleared, and everything sharing a stage files simultaneously. That is why the timeline
  charges each stage its slowest review rather than the sum. A rule set that cannot progress raises
  <code>CyclicRuleSetError</code> instead of quietly returning a short, plausible-looking schedule.</p>
  <p style="margin:0">Jurisdictions and project types live in Postgres rather than in a constant, because a
  jurisdiction that changes its review times or starts bundling trade permits should be a row update, not a
  release. Review durations and correction averages are illustrative; verify against the authority having
  jurisdiction before relying on a date.</p>
</footer>
</div></body></html>`;
}

async function main() {
  await migrate();
  await seed();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (url.pathname === "/up") {
      // Health must not depend on the database being reachable, or a brief DB
      // blip makes kamal-proxy pull a container that is otherwise fine.
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }

    try {
      const jurisdictions = await loadJurisdictions();
      const types = await loadProjectTypes();
      const scope = scopeFromQuery(url.searchParams);
      const jKey = url.searchParams.get("jurisdiction") ?? "SEATTLE";
      const jurisdiction = jurisdictions[jKey] ?? Object.values(jurisdictions)[0]!;

      if (!types[scope.type]) scope.type = Object.keys(types)[0]!;
      const d = determine(scope, jurisdiction, types);

      if (url.pathname === "/api/determine") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          jurisdiction: d.jurisdiction.name,
          project: { type: d.project.type, label: d.project.label, valuation: d.project.valuation },
          totalDays: d.totalDays,
          stages: d.schedule.map((s) => ({
            stage: s.layer, reviewDays: s.reviewDays, correctionDays: s.correctionDays,
            cumulativeDays: s.cumulative,
            permits: s.permits.map((p) => ({ id: p.id, name: p.name, discipline: p.discipline, why: p.why })),
          })),
          flags: d.flags,
          notRequired: d.notRequired.map((p) => p.id),
        }, null, 2));
        return;
      }

      if (url.pathname !== "/") {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }

      const comparison = Object.values(jurisdictions)
        .map((j) => {
          const x = determine(scope, j, types);
          return { key: j.key, name: j.name, days: x.totalDays, permits: x.required.length };
        })
        .sort((a, b) => a.days - b.days);

      await recordDetermination(jurisdiction.key, scope.type, scope, d.required.map((p) => p.id), d.totalDays);
      const recent = await recentDeterminations();

      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(renderPage(d, scope, jurisdictions, types, comparison, recent));
    } catch (err) {
      console.error("request failed", err);
      res.writeHead(500, { "content-type": "text/plain" }).end("internal error");
    }
  });

  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, () => console.log(`sequence listening on ${port}`));

  const shutdown = async () => {
    console.log("shutting down");
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
