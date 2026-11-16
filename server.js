import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const PORT = Number(process.env.PORT ?? 8080);
const CACHE_MS = Number(process.env.CACHE_SECONDS ?? 3600) * 1000;
const RETRY_MS = 60_000;

const TWEEDE_KAMER_URL =
  "https://gegevensmagazijn.tweedekamer.nl/OData/v4/2.0/Fractie" +
  "?$filter=Verwijderd%20eq%20false%20and%20DatumInactief%20eq%20null&$select=Afkorting,NaamNL,AantalZetels";
const EERSTE_KAMER_URL = "https://www.eerstekamer.nl/fracties";
const WIKIPEDIA_POLLS_PAGE = "https://en.wikipedia.org/wiki/Opinion_polling_for_the_next_Dutch_general_election";
const WIKIPEDIA_POLLS_URL =
  "https://en.wikipedia.org/w/api.php?action=parse&page=Opinion_polling_for_the_next_Dutch_general_election" +
  "&redirects=1&prop=wikitext&format=json&formatversion=2";
const PEILINGWIJZER_URL = "https://peilingwijzer.tomlouwerse.nl/";

// Poll party names that differ from the fractie names the official sources use.
const POLL_PARTY_NAMES = { FvD: "FVD", Denk: "DENK", CU: "ChristenUnie", "50+": "50PLUS" };
const POLLSTER_NAMES = { Verian: "Verian/EenVandaag" };

const indexHtml = await readFile(new URL("./index.html", import.meta.url));
const state = JSON.parse(await readFile(new URL("./fallback.json", import.meta.url), "utf8"));
let fetchedAt = 0;
let pendingRefresh = null;

async function fetchOk(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "Kamermeerderheid/1.0" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response;
}

const stripMarkup = text => text?.replace(/[<>"']/g, "").trim();

function checkTotal(house, fracties, total) {
  const seats = fracties.reduce((sum, f) => sum + f.seats, 0);
  if (seats > total || seats < total - 5) throw new Error(`${house} seats add up to ${seats}, expected ${total}`);
  return fracties.map(f => ({ ...f, name: stripMarkup(f.name), fullName: stripMarkup(f.fullName) }));
}

async function fetchTweedeKamer() {
  const { value } = await (await fetchOk(TWEEDE_KAMER_URL)).json();
  const fracties = value
    .filter(f => f.AantalZetels > 0)
    .map(f => ({ name: f.Afkorting, fullName: f.NaamNL, seats: f.AantalZetels }));
  return checkTotal("Tweede Kamer", fracties, 150);
}

const decodeEntities = text =>
  text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(code)).replace(/&quot;/g, '"').replace(/&amp;/g, "&");

async function fetchEersteKamer() {
  const html = await (await fetchOk(EERSTE_KAMER_URL)).text();
  const fracties = [...html.matchAll(/>([^<>]+?) \((\d+) zetels?\)</g)]
    .map(([, name, seats]) => ({ name: decodeEntities(name.trim()), seats: Number(seats) }));
  return checkTotal("Eerste Kamer", fracties, 75);
}

async function fetchHouses() {
  const [tk, ek] = await Promise.all([fetchTweedeKamer(), fetchEersteKamer()]);
  return { updated: new Date().toISOString(), tk, ek };
}

function makePoll(pollster, date, url, seatsByParty) {
  const seats = seatsByParty
    .map(([party, seats]) => ({ name: POLL_PARTY_NAMES[party] ?? party, seats }))
    .filter(p => p.seats > 0);
  return { pollster: stripMarkup(pollster), date, url, seats: checkTotal(pollster, seats, 150) };
}

const wikitextCellValue = cell => cell
  .replace(/<ref[^>]*\/>|<ref[\s\S]*?<\/ref>/g, "")
  .replace(/\{\{[^{}]*\}\}/g, "")
  .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1")
  .split("|").pop().replace(/'''/g, "").trim();

// Latest poll per pollster from the seat table on Wikipedia.
async function fetchWikipediaPolls() {
  const { parse } = await (await fetchOk(WIKIPEDIA_POLLS_URL)).json();
  const table = parse.wikitext.split("=== Seats ===")[1].split("\n|}")[0];
  const [, headerRow, , ...dataRows] = table.split(/\n\|-[^\n]*/);
  const headers = headerRow.split("\n").filter(line => line.startsWith("!"));
  const partyColumns = headers.flatMap((header, i) => header.includes("[[") ? [[wikitextCellValue(header), i]] : []);

  const polls = new Map();
  for (const row of dataRows) {
    const cells = row.split("\n").filter(line => line.startsWith("|")).map(line => line.slice(1));
    if (cells.length !== headers.length) continue;
    const pollster = POLLSTER_NAMES[wikitextCellValue(cells[0])] ?? wikitextCellValue(cells[0]);
    const fieldworkEnd = cells[1].match(/opdrts\|\d*\|(\d+)\|(\w+)\|(\d{4})/);
    if (!pollster || /election/i.test(pollster) || polls.has(pollster) || !fieldworkEnd) continue;
    const date = new Date(`${fieldworkEnd.slice(1).join(" ")} UTC`).toISOString().slice(0, 10);
    const url = cells.at(-1).match(/url=\s*(https:\/\/[^\s|}<>"']+)/)?.[1] ?? WIKIPEDIA_POLLS_PAGE;
    try {
      const seats = partyColumns.map(([party, i]) => [party, Number(wikitextCellValue(cells[i])) || 0]);
      polls.set(pollster, makePoll(pollster, date, url, seats));
    } catch (error) {
      console.error(`Skipping ${pollster} poll of ${date}: ${error.message}`);
    }
  }
  if (polls.size === 0) throw new Error("No polls found on Wikipedia");
  return [...polls.values()];
}

async function fetchPeilingwijzer() {
  const html = await (await fetchOk(PEILINGWIJZER_URL)).text();
  const { rows, meta } = JSON.parse(html.match(/<script[^>]*>\s*(\{"rows":[\s\S]*?)<\/script>/)[1]);
  const [, day, month, year] = meta.caption.join(" ").match(/(\d{2})-(\d{2})-(\d{4})/);
  return [makePoll("Peilingwijzer", `${year}-${month}-${day}`, PEILINGWIJZER_URL, rows.map(row => [row.p, row.zet]))];
}

const SOURCES = { houses: fetchHouses, wikipedia: fetchWikipediaPolls, peilingwijzer: fetchPeilingwijzer };

async function refresh() {
  const keys = Object.keys(SOURCES);
  const results = await Promise.allSettled(keys.map(key => SOURCES[key]()));
  let failed = false;
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      state[keys[i]] = result.value;
    } else {
      failed = true;
      console.error(`Refreshing ${keys[i]} failed, keeping previous data: ${result.reason.message}`);
    }
  });
  fetchedAt = failed ? Date.now() - CACHE_MS + RETRY_MS : Date.now();
}

async function currentData() {
  if (Date.now() - fetchedAt > CACHE_MS) {
    pendingRefresh ??= refresh().finally(() => { pendingRefresh = null; });
    await pendingRefresh;
  }
  return { ...state.houses, polls: [...state.peilingwijzer, ...state.wikipedia] };
}

createServer(async (request, response) => {
  const { pathname } = new URL(request.url, "http://localhost");
  if (pathname === "/api/fracties") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
    response.end(JSON.stringify(await currentData()));
  } else if (pathname === "/" || pathname === "/index.html") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(indexHtml);
  } else {
    response.writeHead(404).end();
  }
}).listen(PORT, () => console.log(`Kamermeerderheid listening on :${PORT}`));

process.on("SIGTERM", () => process.exit(0));
