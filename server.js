import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const PORT = Number(process.env.PORT ?? 8080);
const CACHE_MS = Number(process.env.CACHE_SECONDS ?? 3600) * 1000;
const RETRY_MS = 60_000;

const TWEEDE_KAMER_URL =
  "https://gegevensmagazijn.tweedekamer.nl/OData/v4/2.0/Fractie" +
  "?$filter=Verwijderd%20eq%20false%20and%20DatumInactief%20eq%20null&$select=Afkorting,NaamNL,AantalZetels";
const EERSTE_KAMER_URL = "https://www.eerstekamer.nl/fracties";

const indexHtml = await readFile(new URL("./index.html", import.meta.url));
let data = JSON.parse(await readFile(new URL("./fallback.json", import.meta.url), "utf8"));
let fetchedAt = 0;
let pendingRefresh = null;

async function fetchOk(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response;
}

const stripMarkup = text => text?.replace(/[<>"'&]/g, "").trim();

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

async function refresh() {
  try {
    const [tk, ek] = await Promise.all([fetchTweedeKamer(), fetchEersteKamer()]);
    data = { updated: new Date().toISOString(), tk, ek };
    fetchedAt = Date.now();
  } catch (error) {
    console.error(`Refresh failed, serving data from ${data.updated}: ${error.message}`);
    fetchedAt = Date.now() - CACHE_MS + RETRY_MS;
  }
}

async function currentData() {
  if (Date.now() - fetchedAt > CACHE_MS) {
    pendingRefresh ??= refresh().finally(() => { pendingRefresh = null; });
    await pendingRefresh;
  }
  return data;
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
