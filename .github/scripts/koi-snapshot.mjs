// Sammelt einen git-koi-Schnappschuss mit ALLEN eigenen Beiträgen und Repositories,
// auch privaten. git-koi selbst liest nur öffentliche Daten; mit dem eigenen
// ACTIVITY_TOKEN (Scopes: repo + read:user) sieht die GitHub-API auch private.
//
// Der Schnappschuss bleibt im Runner (RUNNER_TEMP) und wird nie committet. Er enthält
// keine Namen oder Inhalte, nur IDs, Hauptsprachen und Tageszahlen. Private Repositories
// werden darin als "public" geführt, weil git-koi nur so ihre Sprache mitzählt.
//
//   ACTIVITY_TOKEN=<PAT> node .github/scripts/koi-snapshot.mjs ausgabe.json

import { writeFileSync } from "node:fs";

const LOGIN = process.env.ACTIVITY_LOGIN || "dogenc";
const out = process.argv[2];
if (!out) throw new Error("Ausgabedatei fehlt.");
if (!process.env.ACTIVITY_TOKEN) throw new Error("ACTIVITY_TOKEN fehlt – ohne eigenen Token keine privaten Daten.");

async function gql(query, variables) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: `bearer ${process.env.ACTIVITY_TOKEN}`, "Content-Type": "application/json", "User-Agent": LOGIN },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && !json.errors) return json.data;
    if (attempt >= 3) throw new Error(`GitHub API: ${res.status} ${JSON.stringify(json.errors || json).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, attempt * 3000));
  }
}

const day = (d) => d.toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return day(d); };

const { user } = await gql(`query($login: String!) { user(login: $login) { databaseId createdAt } }`, { login: LOGIN });

// Repositories: alle eigenen (öffentlich + privat) und fremde, zu denen beigetragen wurde.
const repositories = new Map();
const languageColors = {};
async function collect(connection, call) {
  let cursor = null;
  do {
    const data = await gql(
      `query($login: String!, $cursor: String) { user(login: $login) { ${call} {
        nodes { databaseId visibility isFork primaryLanguage { name color } }
        pageInfo { hasNextPage endCursor } } } }`,
      { login: LOGIN, cursor },
    );
    const conn = data.user[connection];
    for (const r of conn.nodes) {
      if (!r) continue;
      if (r.primaryLanguage) languageColors[r.primaryLanguage.name] = r.primaryLanguage.color || null;
      repositories.set(r.databaseId, {
        repository_id: r.databaseId,
        visibility: "public", // siehe Kopfkommentar: nur so zählt git-koi private Repos mit
        is_fork: r.isFork,
        primary_language: r.primaryLanguage?.name ?? null,
      });
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
}
await collect("repositories", "repositories(first: 100, after: $cursor, ownerAffiliations: [OWNER])");
await collect("repositoriesContributedTo",
  "repositoriesContributedTo(first: 100, after: $cursor, includeUserRepositories: false, contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, PULL_REQUEST_REVIEW, REPOSITORY])");

// Kalender in Jahresfenstern vom Kontostart bis gestern (UTC), wie git-koi.
const createdOn = user.createdAt.slice(0, 10);
const lastDay = addDays(day(new Date()), -1);
const counts = new Map();
for (let start = createdOn; start <= lastDay; ) {
  const next = new Date(start + "T00:00:00Z"); next.setUTCFullYear(next.getUTCFullYear() + 1);
  const end = [addDays(day(next), -1), lastDay].sort()[0];
  const data = await gql(
    `query($login: String!, $from: DateTime!, $to: DateTime!) { user(login: $login) {
      contributionsCollection(from: $from, to: $to) { contributionCalendar { weeks { contributionDays { date contributionCount } } } } } }`,
    { login: LOGIN, from: `${start}T00:00:00Z`, to: `${end}T23:59:59Z` },
  );
  for (const w of data.user.contributionsCollection.contributionCalendar.weeks)
    for (const d of w.contributionDays)
      if (d.date >= start && d.date <= end) counts.set(d.date, d.contributionCount);
  start = addDays(end, 1);
}

// git-koi verlangt jeden Tag lückenlos; fehlende Tage (selten) zählen als 0.
const days = [];
let missing = 0;
for (let d = createdOn; d <= lastDay; d = addDays(d, 1)) {
  if (!counts.has(d)) missing++;
  days.push({ date: d, contribution_count: counts.get(d) ?? 0 });
}

const snapshot = {
  schema_version: 3,
  account_id: user.databaseId,
  repositories: [...repositories.values()],
  language_colors: languageColors,
  contribution_history: { observed_on: lastDay, days },
};
writeFileSync(out, JSON.stringify(snapshot));
const total = days.reduce((s, d) => s + d.contribution_count, 0);
console.log(`Schnappschuss: ${repositories.size} Repositories, ${Object.keys(languageColors).length} Sprachen, ${total} Beiträge seit ${createdOn}${missing ? `, ${missing} Tage ohne Angabe` : ""}.`);
