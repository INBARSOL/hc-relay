#!/usr/bin/env node
/**
 * Lotto Lane relay — GitHub Actions runner fetches Housing Connect data
 * (Azure IPs are not blocked by HC's WAF) and POSTs to the Worker one
 * listing at a time to stay under the Worker's 50 D1 subrequest limit.
 *
 * Usage:
 *   node relay.mjs
 *
 * Required environment variables (set as GitHub encrypted secrets):
 *   WORKER_URL   — https://lotto-lane-api.nyc-housing-app.workers.dev
 *   API_SECRET   — same value as the Worker's API_SECRET secret
 *
 * Optional:
 *   DRY_RUN=1    — fetch HC data but skip all Worker POSTs (for local testing)
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

async function postListing(searchListingRaw, detailData) {
  const res = await fetch(`${WORKER_URL}/internal/ingest/listing`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Secret': API_SECRET,
      'User-Agent': UA,
    },
    body: JSON.stringify({ searchListingRaw, detailData }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`/ingest/listing failed: HTTP ${res.status} — ${body.slice(0, 300)}`)
  }
  return res.json()
}

async function postComplete(total, errorCount, prevCount) {
  const res = await fetch(`${WORKER_URL}/internal/ingest/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Secret': API_SECRET,
      'User-Agent': UA,
    },
    body: JSON.stringify({ total, errorCount, prevCount }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`/ingest/complete failed: HTTP ${res.status} — ${body.slice(0, 300)}`)
  }
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
    log('WARNING: zero listings returned — skipping ingest')
    process.exit(1)
  }

  // 2. Get prevCount before any writes (for drop check in /ingest/complete)
  let prevCount = 0
  if (!DRY_RUN) {
    // We ask the Worker for the current published count via /health (doesn't expose count)
    // so we pass prevCount=0 and let the Worker use its own countPublishedLotteries call.
    // The Worker's /ingest/complete does the count internally — prevCount here is just for
    // the Worker's reference; we pass the total listing count instead.
    prevCount = listings.length  // approximation; Worker queries D1 for the real prevCount
  }

  // 3. POST each listing individually — one Worker invocation per listing
  let errorCount = 0
  const statuses = {}

  if (DRY_RUN) {
    log(`DRY_RUN=1 — would POST ${listings.length} listings to ${WORKER_URL ?? '(WORKER_URL not set)'}`)

    // Still fetch details so we can verify HC connectivity
    for (const listing of listings) {
      const id = listing.lotteryId ?? listing.LotteryId
      if (!id) continue
      try {
        await fetchDetail(id)
        await new Promise(r => setTimeout(r, 200))
      } catch (err) {
        log(`WARNING: detail fetch failed for ${id}: ${err.message}`)
        errorCount++
      }
    }
    log(`details: ${listings.length - errorCount} ok, ${errorCount} failed`)
    log('DRY_RUN complete — no Worker POSTs sent')
    process.exit(0)
  }

  for (const listing of listings) {
    const id = listing.lotteryId ?? listing.LotteryId
    if (!id) {
      errorCount++
      continue
    }

    let detailData
    try {
      detailData = await fetchDetail(id)
      await new Promise(r => setTimeout(r, 200))
    } catch (err) {
      log(`WARNING: detail fetch failed for ${id}: ${err.message}`)
      errorCount++
      continue
    }

    try {
      const { result } = await postListing(listing, detailData)
      statuses[result.status] = (statuses[result.status] ?? 0) + 1
      if (result.status === 'error') {
        log(`WARNING listing ${id}: ${result.error}`)
        errorCount++
      }
    } catch (err) {
      log(`WARNING: failed to post listing ${id}: ${err.message}`)
      errorCount++
    }
  }

  log(`listings done — ${JSON.stringify(statuses)}, errors: ${errorCount}`)

  // 4. Signal completion — Worker does drop check, logs watchdog event, pings healthcheck
  const completeResult = await postComplete(listings.length, errorCount, prevCount)
  log(`complete: ${JSON.stringify(completeResult)}`)

  if (errorCount > 0) {
    log(`WARNING: ${errorCount} errors — Worker will ping /fail`)
    process.exitCode = 1
  }
}

main().catch(err => {
  console.error(`[relay] FATAL: ${err.message}`)
  process.exit(1)
})
