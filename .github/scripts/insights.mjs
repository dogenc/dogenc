// Erzeugt assets/languages.svg und assets/rhythm.svg (inkl. privater Repos).
// Abgebildet werden nur Summen – keine Repository-Namen, Commit-Texte oder Inhalte.
//
//   ACTIVITY_TOKEN=<PAT> node .github/scripts/insights.mjs [ausgabe-ordner]
//   node .github/scripts/insights.mjs --demo [ausgabe-ordner]   (Zufallsdaten, nur zur Vorschau)

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const LOGIN = process.env.ACTIVITY_LOGIN || "dogenc";
const TZ = process.env.ACTIVITY_TZ || "Europe/Berlin";
const args = process.argv.slice(2);
const demo = args.includes("--demo");
const outDir = args.find((a) => !a.startsWith("--")) || "assets";

const WEEKDAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const C = { bg: "#0d1117", line: "#293344", gold: "#d9b66d", light: "#f4d997", text: "#e6edf3", muted: "#76879b", track: "#161d27" };

async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${process.env.ACTIVITY_TOKEN}`, "Content-Type": "application/json", "User-Agent": LOGIN },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`GitHub API: ${res.status} ${JSON.stringify(json.errors || json)}`);
  return json.data;
}

async function fetchData() {
  if (!process.env.ACTIVITY_TOKEN) throw new Error("ACTIVITY_TOKEN fehlt – ohne eigenen Token fehlen private Repositories.");
  const since = new Date(Date.now() - 365 * 864e5).toISOString();

  const base = await gql(
    `query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          totalCommitContributions totalPullRequestContributions
          totalRepositoriesWithContributedCommits totalIssueContributions
          contributionCalendar { weeks { contributionDays { date weekday contributionCount } } }
        }
      }
    }`,
    { login: LOGIN },
  );
  const user = base.user;

  const repos = [];
  let cursor = null;
  do {
    const page = await gql(
      `query($login: String!, $cursor: String) {
        user(login: $login) {
          repositories(first: 50, after: $cursor, ownerAffiliations: OWNER, isFork: false) {
            pageInfo { hasNextPage endCursor }
            nodes {
              name
              languages(first: 20, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name color } } }
              defaultBranchRef { name }
            }
          }
        }
      }`,
      { login: LOGIN, cursor },
    );
    const r = page.user.repositories;
    repos.push(...r.nodes);
    cursor = r.pageInfo.hasNextPage ? r.pageInfo.endCursor : null;
  } while (cursor);

  // Commits der letzten 12 Monate (ausgewertet werden nur Zeitpunkte).
  // Squash-Merges fassen viele Commits zu einem zusammen – die Einzelcommits
  // stecken aber noch im Pull Request und werden von dort ergänzt.
  const isBot = (n) => /\[bot\]|dependabot/i.test(`${n.author?.user?.login || ""} ${n.author?.name || ""}`);
  const key = (n) => `${n.authoredDate}|${n.messageHeadline}`;
  const mainCommits = [];
  const prCommits = new Map();
  const mergeOids = new Set();
  let skippedBots = 0;
  for (const repo of repos) {
    if (!repo.defaultBranchRef) continue;
    let after = null;
    do {
      const page = await gql(
        `query($owner: String!, $name: String!, $since: GitTimestamp!, $after: String) {
          repository(owner: $owner, name: $name) {
            defaultBranchRef { target { ... on Commit {
              history(first: 100, after: $after, since: $since) {
                pageInfo { hasNextPage endCursor }
                nodes { oid authoredDate messageHeadline author { name user { login } } }
              }
            } } }
          }
        }`,
        { owner: LOGIN, name: repo.name, since, after },
      );
      const history = page.repository?.defaultBranchRef?.target?.history;
      if (!history) break;
      // Eigene Repos: alle Commits zählen, nur Bots (z. B. diese Action) nicht.
      for (const n of history.nodes) {
        if (isBot(n)) skippedBots++;
        else mainCommits.push(n);
      }
      after = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null;
    } while (after);

    let prAfter = null;
    do {
      const page = await gql(
        `query($owner: String!, $name: String!, $after: String) {
          repository(owner: $owner, name: $name) {
            pullRequests(first: 25, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
              pageInfo { hasNextPage endCursor }
              nodes {
                updatedAt
                mergeCommit { oid }
                commits(first: 250) { nodes { commit { authoredDate messageHeadline author { name user { login } } } } }
              }
            }
          }
        }`,
        { owner: LOGIN, name: repo.name, after: prAfter },
      );
      const prs = page.repository?.pullRequests;
      if (!prs) break;
      for (const pr of prs.nodes) {
        if (pr.mergeCommit) mergeOids.add(pr.mergeCommit.oid);
        for (const { commit } of pr.commits.nodes)
          if (commit.authoredDate >= since && !isBot(commit)) prCommits.set(key(commit), commit);
      }
      const older = prs.nodes.length && prs.nodes.at(-1).updatedAt < since;
      prAfter = prs.pageInfo.hasNextPage && !older ? prs.pageInfo.endCursor : null;
    } while (prAfter);
  }

  // Squash-/Merge-Commits ersetzen durch die Einzelcommits aus den PRs (ohne Doppelte).
  const mainKeys = new Set(mainCommits.map(key));
  const removed = mainCommits.filter((n) => mergeOids.has(n.oid) && !prCommits.has(key(n)));
  const added = [...prCommits.values()].filter((n) => !mainKeys.has(key(n)));
  const commitTimes = [
    ...mainCommits.filter((n) => !removed.includes(n)).map((n) => n.authoredDate),
    ...added.map((n) => n.authoredDate),
  ];
  console.log(
    `Commits: ${commitTimes.length} (Branch ${mainCommits.length}, aus PRs ergänzt ${added.length}, Squash/Merge entfernt ${removed.length}, Bots ignoriert ${skippedBots})`,
  );

  // Tagesweise Korrektur für die Heatmap (activity.mjs liest sie über ACTIVITY_EXTRA).
  const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });
  const extraPerDay = {};
  for (const n of added) extraPerDay[dayFmt.format(new Date(n.authoredDate))] = (extraPerDay[dayFmt.format(new Date(n.authoredDate))] || 0) + 1;
  for (const n of removed) extraPerDay[dayFmt.format(new Date(n.authoredDate))] = (extraPerDay[dayFmt.format(new Date(n.authoredDate))] || 0) - 1;
  if (process.env.ACTIVITY_EXTRA) writeFileSync(process.env.ACTIVITY_EXTRA, JSON.stringify(extraPerDay));

  const languages = new Map();
  for (const repo of repos)
    for (const { size, node } of repo.languages.edges) {
      const entry = languages.get(node.name) || { name: node.name, color: node.color || C.muted, size: 0 };
      entry.size += size;
      languages.set(node.name, entry);
    }

  const cc = user.contributionsCollection;
  const perWeekday = Array(7).fill(0);
  for (const w of cc.contributionCalendar.weeks)
    for (const d of w.contributionDays) perWeekday[d.weekday] += Math.max(0, d.contributionCount + (extraPerDay[d.date] || 0));

  const hourFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: TZ });
  const perHour = Array(24).fill(0);
  for (const t of commitTimes) perHour[Number(hourFmt.format(new Date(t)))]++;

  return {
    repoCount: repos.length,
    languages: [...languages.values()],
    perHour,
    perWeekday,
    totals: {
      commits: Math.max(0, cc.totalCommitContributions + added.length - removed.length),
      prs: cc.totalPullRequestContributions,
      repos: cc.totalRepositoriesWithContributedCommits,
      issues: cc.totalIssueContributions,
    },
  };
}

function demoData() {
  const rnd = (n) => Math.floor(Math.random() * n);
  return {
    repoCount: 23,
    languages: [
      ["TypeScript", "#3178c6"], ["Python", "#3572A5"], ["C++", "#f34b7d"], ["JavaScript", "#f1e05a"],
      ["Rust", "#dea584"], ["HTML", "#e34c26"], ["CSS", "#563d7c"], ["Java", "#b07219"], ["C", "#555555"], ["Shell", "#89e051"],
    ].map(([name, color], i) => ({ name, color, size: (12 - i) ** 3 * 1000 + rnd(9000) })),
    perHour: Array.from({ length: 24 }, (_, h) => Math.round((Math.sin(((h - 15) / 24) * Math.PI * 2) + 1.2) * 20) + rnd(10)),
    perWeekday: Array.from({ length: 7 }, () => 50 + rnd(150)),
    totals: { commits: 800 + rnd(400), prs: rnd(60), repos: 5 + rnd(15), issues: rnd(40) },
  };
}

const fmt = (n) => n.toLocaleString("de-DE");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const today = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ }).format(new Date());

function frame(width, height, path, label, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">
<rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="16" fill="${C.bg}" stroke="${C.line}"/><path d="M1 49H${width - 1}" stroke="${C.line}"/>
<circle cx="27" cy="25" r="5" fill="#df7369"/><circle cx="47" cy="25" r="5" fill="${C.gold}"/><circle cx="67" cy="25" r="5" fill="#81b59d"/>
<g font-family="monospace">
<text x="99" y="31" fill="${C.muted}" font-size="13">dogenc@labs ~ ${path}</text>
${body}
</g>
</svg>
`;
}

function renderLanguages({ languages, repoCount }) {
  const total = languages.reduce((s, l) => s + l.size, 0) || 1;
  const sorted = languages.sort((a, b) => b.size - a.size);
  const top = sorted.slice(0, 8);
  const rest = sorted.slice(8).reduce((s, l) => s + l.size, 0);
  if (rest > 0) top.push({ name: "Sonstige", color: "#3d4a5c", size: rest });
  const items = top.map((l) => ({ ...l, pct: (l.size / total) * 100 }));

  const width = 1200;
  const barX = 36;
  const barW = width - 72;
  let x = barX;
  const segments = items
    .map((l) => {
      const w = (l.pct / 100) * barW;
      const seg = `<rect x="${x.toFixed(1)}" y="128" width="${Math.max(w - 3, 1).toFixed(1)}" height="26" fill="${l.color}"><title>${esc(l.name)}: ${l.pct.toFixed(1)} %</title></rect>`;
      x += w;
      return seg;
    })
    .join("");

  const cols = 3;
  const colW = barW / cols;
  const rows = Math.ceil(items.length / cols);
  const list = items
    .map((l, i) => {
      const cx = barX + (i % cols) * colW;
      const cy = 210 + Math.floor(i / cols) * 46;
      return `<circle cx="${cx + 9}" cy="${cy - 7}" r="9" fill="${l.color}"/><text x="${cx + 30}" y="${cy}" fill="${C.text}" font-size="21">${esc(l.name)}</text><text x="${cx + colW - 30}" y="${cy}" fill="${C.gold}" font-size="21" text-anchor="end">${l.pct.toFixed(1)} %</text>`;
    })
    .join("");
  const height = 210 + rows * 46 + 34;

  const body = `<text x="36" y="96" fill="${C.gold}" font-size="22">$ du --languages ~/repos</text>
<text x="${width - 36}" y="96" fill="${C.muted}" font-size="18" text-anchor="end">${repoCount} Repositories · Stand ${today}</text>
<clipPath id="bar"><rect x="${barX}" y="128" width="${barW}" height="26" rx="13"/></clipPath>
<rect x="${barX}" y="128" width="${barW}" height="26" rx="13" fill="${C.track}"/>
<g clip-path="url(#bar)">${segments}</g>
${list}`;
  const label = `Programmiersprachen aus öffentlichen und privaten Repositories: ${items.map((l) => `${l.name} ${l.pct.toFixed(1)} %`).join(", ")}.`;
  return frame(width, height, "/languages", label, body);
}

function rhythmType(perHour) {
  const sum = (a, b) => perHour.slice(a, b).reduce((s, n) => s + n, 0);
  const slots = [
    ["Frühaufsteher", sum(5, 12)],
    ["Tagmensch", sum(12, 18)],
    ["Abendcoder", sum(18, 23)],
    ["Nachteule", sum(23, 24) + sum(0, 5)],
  ];
  if (!slots.some(([, n]) => n > 0)) return "–";
  return slots.sort((a, b) => b[1] - a[1])[0][0];
}

function bars(values, labels, x0, y0, w, h, labelEvery) {
  const max = Math.max(...values, 1);
  const best = values.indexOf(max);
  const step = w / values.length;
  const bw = step * 0.68;
  return values
    .map((v, i) => {
      const bh = Math.max((v / max) * h, v > 0 ? 3 : 0);
      const x = x0 + i * step + (step - bw) / 2;
      const fill = i === best ? C.light : v > 0 ? C.gold : C.track;
      const opacity = i === best ? 1 : 0.35 + 0.55 * (v / max);
      const track = `<rect x="${x.toFixed(1)}" y="${y0}" width="${bw.toFixed(1)}" height="${h}" rx="4" fill="${C.track}"/>`;
      const bar = bh ? `<rect x="${x.toFixed(1)}" y="${(y0 + h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="4" fill="${fill}" fill-opacity="${opacity.toFixed(2)}"><title>${labels[i]}: ${fmt(v)}</title></rect>` : "";
      const lbl = i % labelEvery === 0 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${y0 + h + 28}" fill="${C.muted}" font-size="17" text-anchor="middle">${labels[i]}</text>` : "";
      return track + bar + lbl;
    })
    .join("");
}

function renderRhythm({ perHour, perWeekday, totals }) {
  const width = 1200;
  // Woche ab Montag anzeigen.
  const order = [1, 2, 3, 4, 5, 6, 0];
  const week = order.map((i) => perWeekday[i]);
  const weekLabels = order.map((i) => WEEKDAYS[i]);
  const hourLabels = perHour.map((_, h) => String(h).padStart(2, "0"));
  const peak = perHour.indexOf(Math.max(...perHour));
  const hasCommits = perHour.some((n) => n > 0);
  const type = rhythmType(perHour);

  const tiles = [
    [fmt(totals.commits), "Commits"],
    [fmt(totals.prs), "Pull Requests"],
    [fmt(totals.repos), "aktive Repositories"],
    [type, hasCommits ? `Peak ${String(peak).padStart(2, "0")}–${String((peak + 1) % 24).padStart(2, "0")} Uhr` : "Coding-Typ"],
  ];
  const tileW = (width - 72) / tiles.length;
  const tileSvg = tiles
    .map(([v, l], i) => `<text x="${36 + i * tileW}" y="150" fill="${C.gold}" font-size="34">${esc(v)}</text><text x="${36 + i * tileW}" y="180" fill="${C.muted}" font-size="18">${esc(l)}</text>`)
    .join("");

  const chartY = 262;
  const chartH = 150;
  const body = `<text x="36" y="96" fill="${C.gold}" font-size="22">$ git log --format=%H:%M | rhythm</text>
<text x="${width - 36}" y="96" fill="${C.muted}" font-size="18" text-anchor="end">12 Monate · inkl. privat</text>
${tileSvg}
<path d="M36 208H${width - 36}" stroke="${C.line}"/>
<text x="36" y="244" fill="${C.text}" font-size="19">Tageszeit (${TZ.split("/").pop()})</text>
${bars(perHour, hourLabels, 30, chartY, 760, chartH, 3)}
<path d="M826 232V${chartY + chartH + 36}" stroke="${C.line}"/>
<text x="860" y="244" fill="${C.text}" font-size="19">Wochentag</text>
${bars(week, weekLabels, 856, chartY, 314, chartH, 1)}`;
  const height = chartY + chartH + 64;
  const label = `Coding-Rhythmus der letzten 12 Monate: ${fmt(totals.commits)} Commits, ${fmt(totals.prs)} Pull Requests, ${fmt(totals.repos)} aktive Repositories; Typ: ${type}.`;
  return frame(width, height, "/rhythm", label, body);
}

const data = demo ? demoData() : await fetchData();
writeFileSync(join(outDir, "languages.svg"), renderLanguages(data));
writeFileSync(join(outDir, "rhythm.svg"), renderRhythm(data));
console.log(`languages.svg + rhythm.svg in ${outDir} geschrieben (${data.repoCount} Repos).`);
