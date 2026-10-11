// Erzeugt assets/activity.svg aus dem GitHub-Beitragskalender (inkl. privater Repos).
// Es werden nur Tageszahlen abgefragt – keine Repository-Namen, Commits oder Inhalte.
//
//   ACTIVITY_TOKEN=<PAT> node .github/scripts/activity.mjs [ausgabe.svg]
//   node .github/scripts/activity.mjs --demo [ausgabe.svg]   (Zufallsdaten, nur zur Vorschau)

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const LOGIN = process.env.ACTIVITY_LOGIN || "dogenc";
const args = process.argv.slice(2);
const demo = args.includes("--demo");
const out = args.find((a) => !a.startsWith("--")) || "assets/activity.svg";

const LEVELS = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };
const COLORS = ["#161d27", "#4a3d22", "#7d6331", "#b8914a", "#f4d997"];
const WEEKDAYS = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

async function fetchWeeks() {
  const token = process.env.ACTIVITY_TOKEN;
  if (!token) throw new Error("ACTIVITY_TOKEN fehlt – ohne eigenen Token fehlen private Beiträge.");
  const query = `query($login: String!) {
    user(login: $login) {
      contributionsCollection {
        contributionCalendar {
          weeks { contributionDays { date weekday contributionCount contributionLevel } }
        }
      }
    }
  }`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": LOGIN },
    body: JSON.stringify({ query, variables: { login: LOGIN } }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`GitHub API: ${res.status} ${JSON.stringify(json.errors || json)}`);
  return json.data.user.contributionsCollection.contributionCalendar.weeks.map((w) =>
    w.contributionDays.map((d) => ({
      date: d.date,
      weekday: d.weekday,
      count: d.contributionCount,
      level: LEVELS[d.contributionLevel] ?? 0,
    })),
  );
}

function demoWeeks() {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 364 - end.getUTCDay());
  const weeks = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() === 0) weeks.push([]);
    const count = Math.random() < 0.3 ? 0 : Math.floor(Math.random() ** 2 * 25);
    const level = count === 0 ? 0 : Math.min(4, Math.ceil(count / 6));
    weeks.at(-1).push({ date: d.toISOString().slice(0, 10), weekday: d.getUTCDay(), count, level });
  }
  return weeks;
}

function stats(days) {
  const total = days.reduce((s, d) => s + d.count, 0);
  const active = days.filter((d) => d.count > 0).length;
  let longest = 0;
  let run = 0;
  for (const d of days) {
    run = d.count > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  // Aktuelle Serie: ein heute noch leerer Tag unterbricht sie nicht.
  let current = 0;
  let i = days.length - 1;
  if (i >= 0 && days[i].count === 0) i--;
  for (; i >= 0 && days[i].count > 0; i--) current++;
  const last30 = days.slice(-30).reduce((s, d) => s + d.count, 0);
  const perWeekday = Array(7).fill(0);
  for (const d of days) perWeekday[d.weekday] += d.count;
  const best = perWeekday.indexOf(Math.max(...perWeekday));
  return { total, active, longest, current, last30, bestDay: total ? WEEKDAYS[best] : "–" };
}

const fmt = (n) => n.toLocaleString("de-DE");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const deDate = (iso) => iso.split("-").reverse().join(".");

function render(weeks) {
  const days = weeks.flat();
  const s = stats(days);
  const cell = 16;
  const step = 20;
  const gridX = 76;
  const gridY = 214;
  const width = 1200;
  const height = gridY + 7 * step + 66;
  const updated = deDate(days.at(-1).date);

  const tiles = [
    [fmt(s.total), "Beiträge · 12 Monate"],
    [fmt(s.last30), "letzte 30 Tage"],
    [`${s.current} ${s.current === 1 ? "Tag" : "Tage"}`, "aktuelle Serie"],
    [`${s.longest} Tage`, "längste Serie"],
    [`${fmt(s.active)}`, "aktive Tage"],
    [s.bestDay, "aktivster Wochentag"],
  ];
  const tileW = 1128 / tiles.length;
  const tileSvg = tiles
    .map(([value, label], i) => {
      const x = 36 + i * tileW;
      return `<text x="${x}" y="118" fill="#d9b66d" font-size="24">${esc(value)}</text><text x="${x}" y="144" fill="#76879b" font-size="13">${esc(label)}</text>`;
    })
    .join("");

  let lastMonth = -1;
  const monthSvg = weeks
    .map((week, wi) => {
      const m = Number(week[0].date.slice(5, 7)) - 1;
      if (m === lastMonth) return "";
      lastMonth = m;
      if (wi > weeks.length - 3) return "";
      return `<text x="${gridX + wi * step}" y="${gridY - 12}">${MONTHS[m]}</text>`;
    })
    .join("");

  const cellSvg = weeks
    .map((week, wi) =>
      week
        .map((d) => {
          const label = `${deDate(d.date)}: ${d.count} ${d.count === 1 ? "Beitrag" : "Beiträge"}`;
          return `<rect x="${gridX + wi * step}" y="${gridY + d.weekday * step}" width="${cell}" height="${cell}" rx="3" fill="${COLORS[d.level]}"><title>${label}</title></rect>`;
        })
        .join(""),
    )
    .join("");

  const legendX = width - 36 - 5 * step - 96;
  const legendY = gridY + 7 * step + 24;
  const legendSvg = COLORS.map(
    (c, i) => `<rect x="${legendX + 52 + i * step}" y="${legendY}" width="${cell}" height="${cell}" rx="3" fill="${c}"/>`,
  ).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Coding-Aktivität der letzten 12 Monate inklusive privater Repositories: ${fmt(s.total)} Beiträge, aktuelle Serie ${s.current} Tage, längste Serie ${s.longest} Tage.">
<rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="16" fill="#0d1117" stroke="#293344"/><path d="M1 49H${width - 1}" stroke="#293344"/>
<circle cx="27" cy="25" r="5" fill="#df7369"/><circle cx="47" cy="25" r="5" fill="#d9b66d"/><circle cx="67" cy="25" r="5" fill="#81b59d"/>
<g font-family="monospace">
<text x="99" y="31" fill="#76879b" font-size="13">dogenc@labs ~ /activity</text>
<text x="36" y="84" fill="#d9b66d" font-size="17">$ git log --all --since="12 months" | heatmap</text>
${tileSvg}
<path d="M36 170H${width - 36}" stroke="#293344"/>
<g fill="#76879b" font-size="12">${monthSvg}
<text x="36" y="${gridY + 1 * step + 12}">Mo</text><text x="36" y="${gridY + 3 * step + 12}">Mi</text><text x="36" y="${gridY + 5 * step + 12}">Fr</text></g>
${cellSvg}
<g fill="#76879b" font-size="12"><text x="36" y="${legendY + 12}">öffentliche + private Repositories · Stand ${updated}</text>
<text x="${legendX}" y="${legendY + 12}">wenig</text><text x="${legendX + 52 + 5 * step + 6}" y="${legendY + 12}">viel</text></g>
${legendSvg}
</g>
</svg>
`;
}

// Einzelcommits aus squash-gemergten PRs ergänzen (von insights.mjs berechnet).
function applyExtra(weeks) {
  const file = process.env.ACTIVITY_EXTRA;
  if (!file || !existsSync(file)) return weeks;
  const extra = JSON.parse(readFileSync(file, "utf8"));
  const days = weeks.flat();
  for (const d of days) d.count = Math.max(0, d.count + (extra[d.date] || 0));
  // Stufen wie bei GitHub über Quartile der aktiven Tage neu bestimmen.
  const sorted = days.map((d) => d.count).filter((c) => c > 0).sort((a, b) => a - b);
  const q = (p) => sorted[Math.floor((sorted.length - 1) * p)] ?? 0;
  const limits = [q(0.25), q(0.5), q(0.75)];
  for (const d of days) d.level = d.count === 0 ? 0 : 1 + limits.filter((l) => d.count > l).length;
  return weeks;
}

const weeks = demo ? demoWeeks() : applyExtra(await fetchWeeks());
writeFileSync(out, render(weeks));
console.log(`${out} geschrieben (${weeks.flat().length} Tage).`);
