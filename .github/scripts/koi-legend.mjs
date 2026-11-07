// Erzeugt assets/koi-legend.svg: eine Legende zum Code-Koi (git-koi).
// Liest den Schnappschuss, den git-koi im Workflow sammelt, und rechnet mit denselben
// Regeln wie git-koi (v1.0.2) nach, wofür Größe, Farben und Zeichnung stehen.
//
//   KOI_CAPTION="cruise for 2026-11-07, gold body" node .github/scripts/koi-legend.mjs snapshot.json assets/koi-legend.svg

import { readFileSync, writeFileSync } from "node:fs";

const [snapshotPath, outPath = "assets/koi-legend.svg"] = process.argv.slice(2);
if (!snapshotPath) throw new Error("Pfad zum git-koi-Schnappschuss fehlt.");
const snap = JSON.parse(readFileSync(snapshotPath, "utf8"));
const caption = process.env.KOI_CAPTION || "";
// "all": Schnappschuss mit privaten Repositories und Beiträgen (koi-snapshot.mjs), sonst nur öffentlich.
const allData = process.env.KOI_SCOPE === "all";

// ---------------------------------------------------------------- Werte wie in git-koi
const FULL_COLOR = 500, YOUNG_SHAPE = 1_500, ADULT = 12_750, MAX_GROWTH = 100_000;
const days = [...(snap.contribution_history?.days || [])].sort((a, b) => a.date.localeCompare(b.date));
const observedOn = snap.contribution_history?.observed_on || days.at(-1)?.date;
const total = days.reduce((s, d) => s + d.contribution_count, 0);
const growth = Math.log2(1 + Math.min(total, MAX_GROWTH) / 50) / Math.log2(1 + MAX_GROWTH / 50);

const stage =
  total >= MAX_GROWTH ? { name: "Maximalgröße", next: null } :
  total >= ADULT ? { name: "Ausgewachsen", note: "wird noch länger", next: MAX_GROWTH } :
  total >= YOUNG_SHAPE ? { name: "Jung-adult", note: "Körper wächst in die Länge", next: ADULT } :
  total >= FULL_COLOR ? { name: "Heranwachsend", note: "Kopf und Flossen formen sich", next: YOUNG_SHAPE } :
  { name: "Jungfisch", note: "Farben noch blass", next: FULL_COLOR };

// Sprachen: Hauptsprache öffentlicher, nicht geforkter Repositories (jedes Repo zählt einmal).
const repos = new Map();
for (const r of snap.repositories || []) repos.set(r.repository_id, r);
const langCounts = {};
for (const r of repos.values()) {
  if (r.visibility !== "public" || r.is_fork || !r.primary_language) continue;
  langCounts[r.primary_language] = (langCounts[r.primary_language] || 0) + 1;
}
const langTotal = Object.values(langCounts).reduce((a, b) => a + b, 0) || 1;
const languages = Object.entries(langCounts)
  .map(([name, n]) => ({ name, share: n / langTotal, color: snap.language_colors?.[name] || "#76879b" }))
  .sort((a, b) => b.share - a.share || a.name.localeCompare(b.name));

// Wochen-Serien (Montag–Sonntag, ein aktiver Tag genügt), wie git-koi sie bildet.
const isoMonday = (iso) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
const weeks = [];
for (const d of days) {
  const monday = isoMonday(d.date);
  if (weeks.at(-1)?.monday !== monday) weeks.push({ monday, active: 0 });
  if (d.contribution_count > 0) weeks.at(-1).active++;
}
const obsMonday = observedOn ? isoMonday(observedOn) : null;
let longest = 0, runStart = null, recentLen = 0, endedOn = null;
weeks.forEach((w, i) => {
  if (w.active > 0) {
    if (runStart === null) runStart = i;
    recentLen = i - runStart + 1; endedOn = null;
    longest = Math.max(longest, recentLen);
  } else if (w.monday !== obsMonday && runStart !== null) {
    runStart = null;
    const next = new Date(w.monday + "T00:00:00Z"); next.setUTCDate(next.getUTCDate() + 7);
    endedOn = next.toISOString().slice(0, 10);
  }
});
const finBuild = Math.min(recentLen / 13, 1);
const fadeFloor = Math.exp(-0.5 * 6.5);
const weeksSinceEnd = endedOn ? Math.max(0, (Date.parse(observedOn) - Date.parse(endedOn)) / 6048e5) : 0;
const finStrength = endedOn ? finBuild * Math.max(0, (Math.exp(-0.5 * weeksSinceEnd) - fadeFloor) / (1 - fadeFloor)) : finBuild;
const record = (w) => Math.min(Math.log(1 + w / 0.6) / Math.log(1 + 208 / 0.6), 1);
const rec = record(longest), normal = record(4), vivid = record(52);
const vibrancy = rec < normal ? rec / normal : 1 + Math.min((rec - normal) / (vivid - normal), 1);
const glimmer = Math.min(Math.max((rec - vivid) / (1 - vivid), 0), 1);
const colorWord = vibrancy < 0.5 ? "blass" : vibrancy < 1 ? "matt" : vibrancy < 1.5 ? "normal" : vibrancy < 2 ? "leuchtend" : "kräftig";

// Verhalten: direkt aus der Ausgabe von git-koi render.
const behaviors = {
  "cruise": ["Gleitet ruhig", "ein ganz normaler Tag"],
  "dart": ["Flitzt", "Meilenstein oder besonders starke Woche"],
  "surface feeding": ["Schnappt an der Oberfläche", "erster Beitrag der Woche"],
  "rest": ["Ruht", "seit 14+ Tagen kein Beitrag"],
  "deep rest": ["Tiefe Ruhe", "seit 60+ Tagen kein Beitrag"],
};
const behaviorKey = (caption.match(/^([a-z ]+?) for /) || [])[1];
const [behaviorName, behaviorWhy] = behaviors[behaviorKey] || ["–", "Verhalten nicht ermittelt"];

// ---------------------------------------------------------------- SVG
const de = (n) => n.toLocaleString("de-DE");
const pct = (x) => `${Math.round(x * 100)} %`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const dateDe = observedOn ? observedOn.split("-").reverse().join(".") : "";
const W = 1040, H = 512, X0 = 52, XV = 236, BAR = W - XV - 56;
const C = { gold: "#d9b66d", light: "#f4d997", text: "#eef1f5", muted: "#8b98a9", track: "#ffffff14" };
const sans = `font-family="ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"`;
const mono = `font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"`;

const label = (y, t) => `<text x="${X0}" y="${y}" ${mono} font-size="15" letter-spacing="3" fill="${C.gold}" fill-opacity=".8">${t}</text>`;
const value = (y, t, extra = "") => `<text x="${XV}" y="${y}" ${sans} font-size="25" font-weight="600" fill="${C.text}">${t}${extra}</text>`;
const note = (y, t) => `<text x="${XV}" y="${y}" ${sans} font-size="16" fill="${C.muted}">${t}</text>`;

// Breite grob schätzen (SVG kann im README nicht messen) und nur so viele Sprachen zeigen,
// wie sicher in die Zeile passen; der Rest wird als "+N weitere" zusammengefasst.
const textWidth = (s, size) => [...s].reduce((w, ch) => w + size * (/[A-ZÄÖÜ#+]/.test(ch) ? 0.68 : /[il.,'|]/.test(ch) ? 0.3 : /[ mw]/.test(ch) ? (ch === " " ? 0.3 : 0.85) : 0.56), 0);
const entryWidth = (l) => 26 + textWidth(l.name, 21) + 8 + textWidth(pct(l.share), 21) + 34;
const limitX = W - 56;
let cursor = XV, langRow = "", shownCount = 0;
for (const l of languages) {
  const restAfter = languages.length - shownCount - 1;
  const reserve = restAfter > 0 ? 120 : 0;
  if (cursor + entryWidth(l) - 34 > limitX - reserve) break;
  langRow += `<circle cx="${(cursor + 9).toFixed(1)}" cy="241" r="9" fill="${esc(l.color)}"/><circle cx="${(cursor + 9).toFixed(1)}" cy="241" r="9" fill="none" stroke="#fff" stroke-opacity=".25"/>` +
    `<text x="${(cursor + 26).toFixed(1)}" y="248" ${sans} font-size="21" font-weight="600" fill="${C.text}">${esc(l.name)}<tspan fill="${C.gold}" font-weight="400" dx="8">${pct(l.share)}</tspan></text>`;
  cursor += entryWidth(l);
  shownCount++;
}
const rest = languages.length - shownCount;
if (rest > 0) langRow += `<text x="${limitX}" y="248" ${sans} font-size="18" fill="${C.muted}" text-anchor="end">+${rest} weitere</text>`;

const nextNote = stage.next ? `nächste Stufe bei ${de(stage.next)}` : "größer geht es nicht";
const streakNow = endedOn ? (finStrength > 0 ? `zuletzt ${recentLen} Wo., verblasst` : "keine laufende Serie") : `aktuell ${recentLen} Wo.`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
<title id="t">Legende zum Code-Koi</title>
<desc id="d">Größe: ${esc(stage.name)}, ${de(total)} Beiträge, ${pct(growth)} der Maximalgröße. Farben: ${esc(languages.map((l) => `${l.name} ${pct(l.share)}`).join(", ") || "keine")}. Längste Serie ${longest} Wochen, ${esc(streakNow.replace(/\.$/, ""))}. Heute: ${esc(behaviorName)}. Stand ${dateDe}.</desc>
<defs>
  <linearGradient id="glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".09"/><stop offset=".45" stop-color="#ffffff" stop-opacity=".025"/><stop offset="1" stop-color="#ffffff" stop-opacity=".05"/></linearGradient>
  <linearGradient id="edge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.light}" stop-opacity=".9"/><stop offset=".35" stop-color="${C.gold}" stop-opacity=".35"/><stop offset=".7" stop-color="${C.gold}" stop-opacity=".12"/><stop offset="1" stop-color="${C.light}" stop-opacity=".55"/></linearGradient>
  <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#a8843f"/><stop offset=".6" stop-color="${C.gold}"/><stop offset="1" stop-color="${C.light}"/></linearGradient>
  <linearGradient id="rule" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.gold}" stop-opacity="0"/><stop offset=".2" stop-color="${C.gold}" stop-opacity=".45"/><stop offset=".8" stop-color="${C.gold}" stop-opacity=".45"/><stop offset="1" stop-color="${C.gold}" stop-opacity="0"/></linearGradient>
  <radialGradient id="glow" cx=".88" cy="0" r=".75"><stop offset="0" stop-color="${C.gold}" stop-opacity=".22"/><stop offset="1" stop-color="${C.gold}" stop-opacity="0"/></radialGradient>
  <radialGradient id="glow2" cx="0" cy="1" r=".6"><stop offset="0" stop-color="${C.light}" stop-opacity=".08"/><stop offset="1" stop-color="${C.light}" stop-opacity="0"/></radialGradient>
  <clipPath id="card"><rect x="2" y="2" width="${W - 4}" height="${H - 4}" rx="30"/></clipPath>
</defs>
<g clip-path="url(#card)">
  <rect width="${W}" height="${H}" fill="#0c1016" fill-opacity=".94"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect width="${W}" height="${H}" fill="url(#glow2)"/>
  <rect width="${W}" height="${H}" fill="url(#glass)"/>
  <path d="M40 3.5H${W - 40}" stroke="#ffffff" stroke-opacity=".28" stroke-width="1.5"/>
</g>
<rect x="2" y="2" width="${W - 4}" height="${H - 4}" rx="30" fill="none" stroke="url(#edge)" stroke-width="2"/>

<text x="${X0}" y="66" ${mono} font-size="17" letter-spacing="5" fill="${C.light}">CODE-KOI · LEGENDE</text>
<text x="${W - 56}" y="66" ${sans} font-size="16" fill="${C.muted}" text-anchor="end">Stand ${dateDe}</text>
<rect x="${X0}" y="90" width="${W - X0 - 56}" height="1" fill="url(#rule)"/>

${label(140, "GRÖSSE")}
${value(140, esc(stage.name), `<tspan ${sans} font-size="19" font-weight="400" fill="${C.gold}" dx="12">${de(total)} Beiträge${allData ? " · inkl. privater" : ""}</tspan>`)}
<rect x="${XV}" y="156" width="${BAR}" height="6" rx="3" fill="${C.track}"/>
<rect x="${XV}" y="156" width="${(BAR * growth).toFixed(1)}" height="6" rx="3" fill="url(#bar)"/>
<circle cx="${(XV + BAR * growth).toFixed(1)}" cy="159" r="6" fill="${C.light}"/>
${note(188, `${pct(growth)} der Maximalgröße · ${stage.note ? esc(stage.note) + " · " : ""}${nextNote}`)}

${label(248, "FARBEN")}
${langRow || value(248, "–")}
${note(280, `Hauptsprachen ${allData ? "aller meiner Repos, auch privater" : "meiner öffentlichen Repos"} · Farbintensität: ${colorWord}${glimmer > 0 ? " mit Glitzer" : ""}`)}

${label(346, "SERIEN")}
${value(346, `Längste ${longest} Wo.`, `<tspan ${sans} font-size="19" font-weight="400" fill="${C.gold}" dx="12">${esc(streakNow)}</tspan>`)}
${note(378, `Längste Serie → Farbstärke · laufende Serie → Streifenflossen ${pct(finStrength)}`)}

${label(444, "HEUTE")}
${value(444, esc(behaviorName))}
${note(476, `${esc(behaviorWhy)} · Grundfarbe Gold`)}
</svg>
`;
writeFileSync(outPath, svg);
console.log(`Legende geschrieben: ${outPath} (${stage.name}, ${total} Beiträge, ${languages.length} Sprachen, ${behaviorKey || "?"})`);
