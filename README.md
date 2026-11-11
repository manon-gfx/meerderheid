# Kamermeerderheid

Select Dutch fracties and see how close they are to a majority in the Tweede Kamer and the Eerste Kamer.

The page is in Dutch by default; `?lang=en` (or the NL/EN switch) shows the English version.

Seat counts are fetched from the official sources and cached for an hour:
- Tweede Kamer: the [open data API](https://opendata.tweedekamer.nl/) (`Fractie.AantalZetels`)
- Eerste Kamer: <https://www.eerstekamer.nl/fracties>

If a fetch fails or the seats don't add up to the house size, the server keeps serving the last good data
(`fallback.json` until the first successful fetch).

## Run

Every push to `main` builds an image for amd64 and arm64 and pushes it to
`docker.manon-palace.com/meerderheid` (tags `latest` and `sha-<commit>`; `v*` git tags also get a version tag).
The workflow needs the repository secrets `REGISTRY_USERNAME` and `REGISTRY_PASSWORD`.

```sh
docker login docker.manon-palace.com
docker compose pull && docker compose up -d
```

`docker compose up -d --build` builds the image locally instead. The page is served on port 8080.
Without Docker: `node server.js` (Node 22+, no dependencies).

| Variable        | Default | |
|-----------------|---------|-|
| `PORT`          | `8080`  | |
| `CACHE_SECONDS` | `3600`  | How long fetched seat counts are reused |

New fracties (splits) appear automatically with a neutral colour. Party colours and left-to-right seat order
are in the `KNOWN` list in `index.html`.
