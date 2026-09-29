const STORAGE = {
  url: "dt.environmentUrl",
  token: "dt.apiToken",
  sla: "dt.slaTarget",
  mttr: "dt.mttrTarget",
  range: "dt.range",
};

const rangeSelect = document.getElementById("rangeSelect");
const slaTargetInput = document.getElementById("slaTarget");
const mttrTargetInput = document.getElementById("mttrTarget");
const settingsDialog = document.getElementById("settingsDialog");
const statusLine = document.getElementById("statusLine");

const state = {
  problems: [],
  fetchedAt: 0,
  from: "now-7d",
  to: "now",
  entityTab: "all",
  demo: false,
};

rangeSelect.value = localStorage.getItem(STORAGE.range) || "now-7d";
slaTargetInput.value = localStorage.getItem(STORAGE.sla) || "99.9";
mttrTargetInput.value = localStorage.getItem(STORAGE.mttr) || "60";
document.getElementById("dtUrl").value = localStorage.getItem(STORAGE.url) || "";
document.getElementById("dtToken").value = localStorage.getItem(STORAGE.token) || "";

document.getElementById("settingsBtn").addEventListener("click", () => settingsDialog.showModal());
document.getElementById("refreshBtn").addEventListener("click", () => {
  if (state.demo) {
    statusLine.textContent = "Showing sample data. Connect Dynatrace in Settings to use live problems.";
    render();
    return;
  }
  loadProblems();
});
rangeSelect.addEventListener("change", () => {
  localStorage.setItem(STORAGE.range, rangeSelect.value);
  if (state.demo) render();
  else loadProblems();
});
slaTargetInput.addEventListener("input", persistSlaAndRender);
mttrTargetInput.addEventListener("input", persistSlaAndRender);

document.getElementById("entityTabs").addEventListener("click", (event) => {
  const button = event.target.closest(".tab");
  if (!button) return;
  state.entityTab = button.dataset.type;
  for (const tab of document.querySelectorAll(".tab")) tab.classList.toggle("active", tab === button);
  render();
});

document.getElementById("settingsForm").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "save") return;
  event.preventDefault();
  const url = document.getElementById("dtUrl").value.trim().replace(/\/+$/, "");
  const token = document.getElementById("dtToken").value.trim();
  if (!url || !token) {
    statusLine.textContent = "Environment URL and API token are required to load live data.";
    return;
  }
  localStorage.setItem(STORAGE.url, url);
  localStorage.setItem(STORAGE.token, token);
  await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, token }),
  });
  settingsDialog.close();
  state.demo = false;
  await loadProblems();
});

document.getElementById("demoBtn").addEventListener("click", () => {
  settingsDialog.close();
  state.demo = true;
  state.problems = sampleProblems();
  state.fetchedAt = Date.now();
  state.from = rangeSelect.value;
  statusLine.textContent = "Showing sample data. Connect Dynatrace in Settings to use live problems.";
  render();
});

document.getElementById("cancelSettings").addEventListener("click", () => settingsDialog.close());

init();

async function init() {
  const url = localStorage.getItem(STORAGE.url);
  const token = localStorage.getItem(STORAGE.token);
  if (url && token) {
    await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, token }),
    });
  }
  const status = await fetch("/api/status").then((r) => r.json()).catch(() => ({ configured: false }));
  if (status.configured || (url && token)) {
    await loadProblems();
  } else {
    settingsDialog.showModal();
    render();
  }
}

function persistSlaAndRender() {
  localStorage.setItem(STORAGE.sla, slaTargetInput.value);
  localStorage.setItem(STORAGE.mttr, mttrTargetInput.value);
  render();
}

async function loadProblems() {
  statusLine.textContent = "Loading problems from Dynatrace…";
  try {
    const response = await fetch(`/api/problems?from=${encodeURIComponent(rangeSelect.value)}&to=now`, {
      headers: credHeaders(),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Failed to load problems");
    state.demo = false;
    state.problems = payload.problems || [];
    state.fetchedAt = payload.fetchedAt || Date.now();
    state.from = payload.from;
    state.to = payload.to;
    statusLine.textContent = `${state.problems.length} problem${state.problems.length === 1 ? "" : "s"} · fetched ${new Date(state.fetchedAt).toLocaleString()}`;
    render();
  } catch (err) {
    statusLine.textContent = err.message;
    if (!state.problems.length) render();
  }
}

function credHeaders() {
  const url = localStorage.getItem(STORAGE.url) || "";
  const token = localStorage.getItem(STORAGE.token) || "";
  const headers = {};
  if (url) headers["x-dt-url"] = url;
  if (token) headers["x-dt-token"] = token;
  return headers;
}

function render() {
  const now = Date.now();
  const windowMs = rangeToMs(rangeSelect.value);
  const windowStart = now - windowMs;
  const slaTarget = Number(slaTargetInput.value || 99.9);
  const mttrTargetMs = Number(mttrTargetInput.value || 60) * 60 * 1000;
  const metrics = analyze(state.problems, { now, windowStart, windowMs, slaTarget, mttrTargetMs });

  renderKpis(metrics);
  renderSla(metrics, slaTarget, mttrTargetMs);
  renderFrequent(metrics.byTitle);
  renderImpact(metrics.byEntity);
  renderSimilar(metrics.byTitle);
  renderProblems(metrics.rows, mttrTargetMs);
}

function analyze(problems, { now, windowStart, windowMs, slaTarget, mttrTargetMs }) {
  const rows = problems.map((problem) => {
    const open = problem.status === "OPEN" || problem.endTime < 0;
    const end = open ? now : Number(problem.endTime);
    const start = Number(problem.startTime);
    const duration = Math.max(0, end - start);
    const entities = [...(problem.affectedEntities || []), ...(problem.impactedEntities || [])];
    const uniqueEntities = dedupeEntities(entities);
    return { problem, open, start, end, duration, entities: uniqueEntities };
  });

  const resolved = rows.filter((row) => !row.open);
  const openRows = rows.filter((row) => row.open);
  const durations = resolved.map((row) => row.duration).sort((a, b) => a - b);
  const avgMttr = mean(durations);
  const medianMttr = percentile(durations, 50);
  const p90Mttr = percentile(durations, 90);
  const withinMttr = resolved.filter((row) => row.duration <= mttrTargetMs).length;
  const mttrCompliance = resolved.length ? (withinMttr / resolved.length) * 100 : 100;

  const downtimeMs = mergedDuration(rows.map((row) => [Math.max(row.start, windowStart), Math.min(row.end, now)]));
  const availability = windowMs > 0 ? Math.max(0, Math.min(100, ((windowMs - downtimeMs) / windowMs) * 100)) : 100;
  const budgetMs = ((100 - slaTarget) / 100) * windowMs;
  const remainingBudget = budgetMs - downtimeMs;
  const mtbf = rows.length ? (windowMs - downtimeMs) / rows.length : windowMs;

  const byTitle = groupBy(rows, (row) => row.problem.title || "Untitled");
  const byEntity = {};
  for (const row of rows) {
    for (const entity of row.entities) {
      const key = entity.id || entity.name;
      if (!byEntity[key]) {
        byEntity[key] = {
          name: entity.name || entity.id,
          type: entityType(entity),
          count: 0,
          downtime: 0,
        };
      }
      byEntity[key].count += 1;
      byEntity[key].downtime += row.duration;
    }
  }

  return {
    rows,
    openCount: openRows.length,
    resolvedCount: resolved.length,
    avgMttr,
    medianMttr,
    p90Mttr,
    longest: durations.at(-1) || openRows.reduce((max, row) => Math.max(max, row.duration), 0),
    mttrCompliance,
    withinMttr,
    downtimeMs,
    availability,
    remainingBudget,
    budgetMs,
    mtbf,
    slaMet: availability >= slaTarget,
    mttrMet: mttrCompliance >= 100 || (resolved.length > 0 && avgMttr <= mttrTargetMs),
    byTitle,
    byEntity,
  };
}

function renderKpis(metrics) {
  document.getElementById("kpiRow").innerHTML = [
    kpi("Average MTTR", formatDuration(metrics.avgMttr), `Median ${formatDuration(metrics.medianMttr)}`),
    kpi("P90 MTTR", formatDuration(metrics.p90Mttr), `Longest ${formatDuration(metrics.longest)}`),
    kpi("Open / resolved", `${metrics.openCount} / ${metrics.resolvedCount}`, `${metrics.rows.length} total`),
    kpi("Downtime", formatDuration(metrics.downtimeMs), "Overlapping intervals merged"),
    kpi("Availability", `${metrics.availability.toFixed(3)}%`, `MTBF ${formatDuration(metrics.mtbf)}`),
  ].join("");
}

function renderSla(metrics, slaTarget, mttrTargetMs) {
  const availClass = metrics.slaMet ? "ok" : "bad";
  const mttrClass = metrics.avgMttr <= mttrTargetMs ? "ok" : "bad";
  const budgetClass = metrics.remainingBudget >= 0 ? "ok" : "bad";
  document.getElementById("slaGrid").innerHTML = `
    ${slaCard("Availability SLA", `${metrics.availability.toFixed(3)}% vs ${slaTarget.toFixed(2)}%`, metrics.slaMet ? "Standard met" : "Below standard", availClass, `Allowed downtime ${formatDuration(metrics.budgetMs)}`)}
    ${slaCard("MTTR SLA", `Avg ${formatDuration(metrics.avgMttr)} vs ${formatDuration(mttrTargetMs)}`, metrics.avgMttr <= mttrTargetMs ? "Standard met" : "Above target", mttrClass, `${metrics.withinMttr}/${metrics.resolvedCount} resolved within target (${metrics.mttrCompliance.toFixed(0)}%)`)}
    ${slaCard("Error budget", formatDuration(Math.abs(metrics.remainingBudget)), metrics.remainingBudget >= 0 ? "Remaining" : "Consumed", budgetClass, `${((metrics.downtimeMs / Math.max(metrics.budgetMs, 1)) * 100).toFixed(0)}% of budget used`)}
    ${slaCard("Overall SLA", metrics.slaMet && metrics.avgMttr <= mttrTargetMs ? "Reached" : "Not reached", metrics.slaMet && metrics.avgMttr <= mttrTargetMs ? "Standard met" : "Below standard", metrics.slaMet && metrics.avgMttr <= mttrTargetMs ? "ok" : "bad", "Requires both availability and MTTR")}
  `;
}

function renderFrequent(byTitle) {
  const ranked = Object.entries(byTitle).sort((a, b) => b[1].length - a[1].length).slice(0, 8);
  const max = ranked[0]?.[1].length || 1;
  document.getElementById("frequentList").innerHTML = ranked.length
    ? ranked.map(([title, rows]) => rankRow(title, `${rows.length} occurrences`, rows.length, max)).join("")
    : `<p class="empty">No problems in this range.</p>`;
}

function renderImpact(byEntity) {
  const filtered = Object.values(byEntity)
    .filter((item) => state.entityTab === "all" || item.type === state.entityTab)
    .sort((a, b) => b.count - a.count || b.downtime - a.downtime)
    .slice(0, 8);
  const max = filtered[0]?.count || 1;
  document.getElementById("impactList").innerHTML = filtered.length
    ? filtered
        .map((item) =>
          rankRow(
            `${item.name}`,
            `${item.type} · ${item.count} problems · ${formatDuration(item.downtime)} total duration`,
            item.count,
            max
          )
        )
        .join("")
    : `<p class="empty">No impacted ${state.entityTab === "all" ? "entities" : state.entityTab.toLowerCase() + "s"}.</p>`;
}

function renderSimilar(byTitle) {
  const ranked = Object.entries(byTitle).sort((a, b) => b[1].length - a[1].length);
  document.getElementById("similarBody").innerHTML = ranked.length
    ? ranked
        .map(([title, rows]) => {
          const resolved = rows.filter((row) => !row.open);
          const last = Math.max(...rows.map((row) => row.start));
          const severities = countMap(rows.map((row) => row.problem.severityLevel || "UNKNOWN"));
          return `<tr>
            <td>${escapeHtml(title)}</td>
            <td>${rows.length}</td>
            <td>${rows.filter((row) => row.open).length}</td>
            <td>${formatDuration(mean(resolved.map((row) => row.duration)))}</td>
            <td>${formatDuration(Math.max(...rows.map((row) => row.duration)))}</td>
            <td>${new Date(last).toLocaleString()}</td>
            <td>${Object.entries(severities).map(([k, v]) => `${k} ${v}`).join(", ")}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="7" class="empty">No similar-problem groups yet.</td></tr>`;
}

function renderProblems(rows, mttrTargetMs) {
  const sorted = [...rows].sort((a, b) => b.start - a.start).slice(0, 80);
  document.getElementById("problemBody").innerHTML = sorted.length
    ? sorted
        .map((row) => {
          const within = !row.open && row.duration <= mttrTargetMs;
          const badge = row.open ? `<span class="badge warn">Open</span>` : within ? `<span class="badge ok">Yes</span>` : `<span class="badge bad">No</span>`;
          return `<tr>
            <td>${escapeHtml(row.problem.displayId || row.problem.problemId || "")}</td>
            <td>${escapeHtml(row.problem.title || "")}</td>
            <td>${escapeHtml(row.problem.status || "")}</td>
            <td>${escapeHtml(row.problem.severityLevel || "")}</td>
            <td>${escapeHtml(row.problem.impactLevel || "")}</td>
            <td>${formatDuration(row.duration)}</td>
            <td>${badge}</td>
            <td>${escapeHtml(row.entities.map((entity) => entity.name || entity.id).slice(0, 4).join(", "))}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="8" class="empty">No problems loaded.</td></tr>`;
}

function kpi(label, value, hint) {
  return `<article class="kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="hint">${hint}</div></article>`;
}

function slaCard(name, metric, status, tone, hint) {
  return `<article class="sla-card"><div class="name">${name}</div><div class="metric">${metric}</div><span class="badge ${tone}">${status}</span><p class="hint" style="color:var(--muted);font-size:0.75rem;margin-top:8px">${hint}</p></article>`;
}

function rankRow(title, meta, value, max) {
  const width = Math.max(6, (value / max) * 100);
  return `<div class="rank"><strong>${escapeHtml(title)}</strong><span class="meta">${escapeHtml(meta)}</span><div class="bar"><span style="width:${width}%"></span></div></div>`;
}

function rangeToMs(from) {
  if (from === "now-24h") return 24 * 3600 * 1000;
  if (from === "now-14d") return 14 * 24 * 3600 * 1000;
  if (from === "now-30d") return 30 * 24 * 3600 * 1000;
  return 7 * 24 * 3600 * 1000;
}

function mergedDuration(intervals) {
  const valid = intervals.filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start).sort((a, b) => a[0] - b[0]);
  if (!valid.length) return 0;
  const merged = [valid[0].slice()];
  for (const [start, end] of valid.slice(1)) {
    const last = merged.at(-1);
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged.reduce((sum, [start, end]) => sum + (end - start), 0);
}

function groupBy(rows, keyFn) {
  const map = {};
  for (const row of rows) {
    const key = keyFn(row);
    (map[key] ||= []).push(row);
  }
  return map;
}

function dedupeEntities(entities) {
  const map = new Map();
  for (const entity of entities) {
    const id = entity.entityId?.id || entity.entityId || entity.id;
    const name = entity.name || entity.entityId?.name || id;
    if (!id) continue;
    map.set(id, { id, name, entityId: entity.entityId || id });
  }
  return [...map.values()];
}

function entityType(entity) {
  const id = String(entity.id || "");
  if (id.startsWith("SERVICE")) return "SERVICE";
  if (id.startsWith("HOST")) return "HOST";
  if (id.startsWith("APPLICATION") || id.startsWith("MOBILE_APPLICATION") || id.startsWith("CUSTOM_APPLICATION")) return "APPLICATION";
  const type = entity.entityId?.type;
  return type || "OTHER";
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function countMap(items) {
  const map = {};
  for (const item of items) map[item] = (map[item] || 0) + 1;
  return map;
}

function formatDuration(ms) {
  if (!ms || ms < 0) return "0m";
  const totalMinutes = Math.round(ms / 60000);
  if (totalMinutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sampleProblems() {
  const now = Date.now();
  const hour = 3600000;
  return [
    problem("P-2401", "Failure rate increase", "RESOLVED", "ERROR", "SERVICE", now - 30 * hour, now - 29 * hour, [svc("checkout"), host("prod-app-1")]),
    problem("P-2402", "Failure rate increase", "RESOLVED", "ERROR", "SERVICE", now - 20 * hour, now - 18.5 * hour, [svc("checkout"), svc("payments")]),
    problem("P-2403", "Failure rate increase", "OPEN", "ERROR", "SERVICE", now - 1.2 * hour, -1, [svc("checkout")]),
    problem("P-2404", "CPU saturation", "RESOLVED", "RESOURCE_CONTENTION", "INFRASTRUCTURE", now - 50 * hour, now - 49.2 * hour, [host("prod-app-2")]),
    problem("P-2405", "CPU saturation", "RESOLVED", "RESOURCE_CONTENTION", "INFRASTRUCTURE", now - 12 * hour, now - 11.1 * hour, [host("prod-app-2"), host("prod-app-1")]),
    problem("P-2406", "High response time", "RESOLVED", "PERFORMANCE", "SERVICE", now - 8 * hour, now - 7.4 * hour, [svc("search"), app("www")]),
    problem("P-2407", "High response time", "RESOLVED", "PERFORMANCE", "SERVICE", now - 6 * hour, now - 4.2 * hour, [svc("search")]),
    problem("P-2408", "Process unavailable", "RESOLVED", "AVAILABILITY", "INFRASTRUCTURE", now - 70 * hour, now - 69.5 * hour, [host("prod-cache-1")]),
    problem("P-2409", "Process unavailable", "OPEN", "AVAILABILITY", "INFRASTRUCTURE", now - 0.4 * hour, -1, [host("prod-cache-1"), svc("session")]),
    problem("P-2410", "Memory usage high", "RESOLVED", "RESOURCE_CONTENTION", "INFRASTRUCTURE", now - 3 * hour, now - 2.7 * hour, [host("prod-app-3")]),
  ];
}

function problem(displayId, title, status, severityLevel, impactLevel, startTime, endTime, entities) {
  return {
    problemId: displayId,
    displayId,
    title,
    status,
    severityLevel,
    impactLevel,
    startTime,
    endTime,
    affectedEntities: entities,
    impactedEntities: entities,
  };
}

function svc(name) {
  return { entityId: { id: `SERVICE-${name}`, name, type: "SERVICE" }, name };
}
function host(name) {
  return { entityId: { id: `HOST-${name}`, name, type: "HOST" }, name };
}
function app(name) {
  return { entityId: { id: `APPLICATION-${name}`, name, type: "APPLICATION" }, name };
}
