# Dex Audio Bridge

An independently implemented BitChord music-source addon. It has its own addon identity, server code, request handling, cache, rate limit, health endpoint and setup documentation.

# 🚨 PROJECT DISCONTINUED & FAILED 🚨

### ⚠️ THIS PROJECT IS NO LONGER UNDER MAINTENANCE. IT IS A FAILED PROJECT. ⚠️
**DO NOT DEPLOY THIS. IT DOES NOT WORK AS INTENDED AND WILL FAIL TO PLAY LOSSLESS AUDIO IN BITCHORD.**

***

## Requirements
- Node.js 20 or newer
- Internet access to at least one configured catalogue API

## Run locally
```bash
npm start
```
Open:
- `http://localhost:8787/manifest.json`
- `http://localhost:8787/health`

Add `http://YOUR-LAN-IP:8787` in BitChord → Settings → Sources → Add an addon. For use outside your home network, deploy behind HTTPS.

## Deploy
This is a plain Node HTTP server and can be deployed to any Node host that supports a persistent web process (for example Render, Railway, or a VPS). Set the start command to `npm start`.

Environment variables:
| Name | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `HOST` | `0.0.0.0` | Bind interface |
| `MONOCHROME_API_BASES` | `https://tracks.monochrome.st,https://api.monochrome.tf` | Comma-separated upstream API bases |
| `UPSTREAM_TIMEOUT_MS` | `9000` | Timeout per upstream request |
| `RATE_LIMIT_PER_MINUTE` | `90` | Per-IP request cap |

## Endpoints
- `GET /manifest.json` — addon metadata and settings
- `GET /search?q=...&quality=LOSSLESS` — track catalogue search
- `GET /stream/:id?quality=LOSSLESS` — resolve a playable track
- `GET /health` — basic service health

## Important compatibility note
The addon contract and the upstream provider are separate systems. The server is built to the currently documented BitChord `/manifest.json`, `/search`, and `/stream/:id` contract. Public upstream music APIs can change, rate-limit, or become unavailable; `/health` checks this service is running, not that every upstream track will play. Test a few tracks and all quality tiers after deployment. Do not label a stream lossless unless the upstream actually supplies lossless audio.

## Credits and rights
Dex Audio Bridge is an original implementation. It is not affiliated with BitChord, Monochrome, TIDAL, or any music rights holder. It uses publicly reachable third-party API endpoints as configurable upstream providers; those providers and the music they expose remain subject to their own terms and rights. This project does not include or redistribute copyrighted music files.
