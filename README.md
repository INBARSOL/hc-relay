# lotto-lane-relay

GitHub Actions relay for [Lotto Lane](https://github.com/INBARSOL/lotto-lane).

Cloudflare Workers IPs are blocked by Housing Connect's WAF. This repo runs on
GitHub-hosted runners (Azure IPs), fetches the HC lottery data every 15 minutes,
and POSTs the raw responses to the Lotto Lane Worker, which does all parsing and storage.

## How it works

1. `relay.yml` runs every 15 minutes on `ubuntu-latest`
2. `relay.mjs` fetches `SearchLotteries` + `GetLotteryAdvertisement` for each listing
3. POSTs `{ searchResponse, detailResponses }` to `POST /internal/ingest` on the Worker
4. The Worker parses, validates, fingerprints and stores changes in D1

`keepalive.yml` makes a small commit on the 1st of each month to prevent
GitHub's 60-day inactivity rule from disabling the workflows.

## Secrets required

| Secret | Value |
|--------|-------|
| `WORKER_URL` | `https://lotto-lane-api.nyc-housing-app.workers.dev` |
| `API_SECRET` | Same as the Worker's `API_SECRET` wrangler secret |

Add these at: **Settings → Secrets and variables → Actions → New repository secret**

## Local dry-run

```bash
DRY_RUN=1 node relay.mjs
```

This fetches HC data and logs what would be sent to the Worker, without POSTing anything.
