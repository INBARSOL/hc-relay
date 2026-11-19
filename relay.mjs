#!/usr/bin/env node
/**
 * Lotto Lane relay — GitHub Actions runner fetches Housing Connect data
 * (Azure IPs are not blocked by HC's WAF) and POSTs raw JSON to the Worker.
 *
 * Usage:
 *   node relay.mjs
 *
 * Required environment variables (set as GitHub encrypted secrets):
 *   WORKER_URL   — https://lotto-lane-api.nyc-housing-app.workers.dev
 *   API_SECRET   — same value as the Worker's API_SECRET secret
 *
 * Optional:
 *   DRY_RUN=1    — fetch HC data but skip the POST to the Worker (for local testing)
 */

const WORKER_URL = process.env.WORKER_URL?.trim()
const API_SECRET = process.env.API_SECRET?.trim()
const DRY_RUN = process.env.DRY_RUN === '1'

const HC_API = 'https://a806-housingconnectapi.nyc.gov/HPDPublicAPI/api/Lottery/'
const CONTACT_URL = 'https://github.com/INBARSOL/lotto-lane-relay'
const UA = `LottoLane/1.0 (${CONTACT_URL})`

const SEARCH_PAYLOAD = JSON.stringify({
  UnitTypes: [], NearbyPlaces: [], NearbySubways: [], Amenities: [],
  Applied: null, HPDUserId: null, Boroughs: [], Neighborhoods: [],
  HouseholdSize: null, Income: '', HouseholdType: 1,
  OwnerTypes: [], PreferanceTypes: [], LotteryTypes: [],
  Min: null, Max: null, RentalSubsidy: null,
})

function log(msg) {
  console.log(`[relay] ${new Date().toISOString()} ${msg}`)
}

async function fetchSearch() {
  log('fetching SearchLotteries...')
  const res = await fetch(`${HC_API}SearchLotteries`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': UA,
      Origin: 'https://housingconnect.nyc.gov',
      Referer: 'https://housingconnect.nyc.gov/',
    },
    body: SEARCH_PAYLOAD,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`SearchLotteries failed: HTTP ${res.status} — ${body.slice(0, 300)}`)
  }
  const data = await res.json()
  const count = (data.rentals?.length ?? 0) + (data.sales?.length ?? 0)
  log(`SearchLotteries ok — ${count} listings`)
  return data
}

async function fetchDetail(lotteryId) {
  const res = await fetch(`${HC_API}GetLotteryAdvertisement?lotteryId=${lotteryId}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`GetLotteryAdvertisement?lotteryId=${lotteryId} failed: HTTP ${res.status}`)
  return res.json()
}

async function main() {
  if (!DRY_RUN) {
    if (!WORKER_URL) throw new Error('WORKER_URL is required')
    if (!API_SECRET) throw new Error('API_SECRET is required')
  }

  // 1. Fetch search
  const searchResponse = await fetchSearch()
  const listings = [...(searchResponse.rentals ?? []), ...(searchResponse.sales ?? [])]

  if (listings.length === 0) {
    log('WARNING: zero listings returned — skipping detail fetch and ingest')
    process.exit(1)
  }

  // 2. Fetch each detail (sequential — polite, stays under 50 subrequest budget awareness)
  const detailResponses = {}
  let detailErrors = 0
  for (const listing of listings) {
    const id = listing.lotteryId ?? listing.LotteryId
    if (!id) continue
    try {
      detailResponses[String(id)] = await fetchDetail(id)
      // Small delay between requests — polite polling, not hammering
      await new Promise(r => setTimeout(r, 200))
    } catch (err) {
      log(`WARNING: detail fetch failed for ${id}: ${err.message}`)
      detailErrors++
    }
  }
  log(`details: ${Object.keys(detailResponses).length} ok, ${detailErrors} failed`)

  if (DRY_RUN) {
    log('DRY_RUN=1 — skipping POST to Worker')
    log(`would POST ${listings.length} listings to ${WORKER_URL ?? '(WORKER_URL not set)'}`)
    process.exit(0)
  }

  // 3. POST to Worker
  log(`posting to ${WORKER_URL}/internal/ingest ...`)
  const ingestRes = await fetch(`${WORKER_URL}/internal/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Secret': API_SECRET,
      'User-Agent': UA,
    },
    body: JSON.stringify({ searchResponse, detailResponses }),
  })

  if (!ingestRes.ok) {
    const body = await ingestRes.text().catch(() => '')
    throw new Error(`Worker /internal/ingest failed: HTTP ${ingestRes.status} — ${body.slice(0, 300)}`)
  }

  const result = await ingestRes.json()
  log(`ingest ok: ${JSON.stringify(result.summary)}`)

  if (result.summary?.errors?.length > 0) {
    log(`WARNING: ${result.summary.errors.length} ingest errors — Worker will ping /fail`)
    process.exitCode = 1
  }
}

main().catch(err => {
  console.error(`[relay] FATAL: ${err.message}`)
  process.exit(1)
})
