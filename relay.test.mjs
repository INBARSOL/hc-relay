/**
 * Unit tests for relay.mjs coordinate extraction logic.
 *
 * HC detail API nests lat/lng inside lotteryBuildings[0], not at the top level.
 * This was the root cause of nearby=null for all 32 lotteries (discovered 2026-11-21).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

/** Mirror of the extraction logic in relay.mjs */
function extractLatLng(detailData) {
  const building = Array.isArray(detailData.lotteryBuildings) ? detailData.lotteryBuildings[0] : null
  const lat = building?.latitude ?? building?.Latitude ?? detailData.latitude ?? detailData.Latitude ?? null
  const lng = building?.longitude ?? building?.Longitude ?? detailData.longitude ?? detailData.Longitude ?? null
  return {
    lat: lat != null ? parseFloat(lat) : null,
    lng: lng != null ? parseFloat(lng) : null,
  }
}

test('extracts lat/lng from lotteryBuildings[0] (real HC response shape)', () => {
  const detailData = {
    lotteryId: 7637,
    lotteryName: 'Test',
    lotteryBuildings: [
      { buildingId: 8173, address: '2102 Union St', latitude: 40.6648982, longitude: -73.9214715 },
    ],
  }
  const { lat, lng } = extractLatLng(detailData)
  assert.strictEqual(lat, 40.6648982)
  assert.strictEqual(lng, -73.9214715)
})

test('falls back to top-level lat/lng if lotteryBuildings absent', () => {
  const detailData = { latitude: 40.7, longitude: -74.0 }
  const { lat, lng } = extractLatLng(detailData)
  assert.strictEqual(lat, 40.7)
  assert.strictEqual(lng, -74.0)
})

test('returns null when no lat/lng anywhere', () => {
  const detailData = { lotteryId: 1, lotteryBuildings: [{ buildingId: 1 }] }
  const { lat, lng } = extractLatLng(detailData)
  assert.strictEqual(lat, null)
  assert.strictEqual(lng, null)
})

test('returns null when lotteryBuildings is empty', () => {
  const detailData = { lotteryBuildings: [] }
  const { lat, lng } = extractLatLng(detailData)
  assert.strictEqual(lat, null)
  assert.strictEqual(lng, null)
})

test('handles string lat/lng values (parseFloat)', () => {
  const detailData = {
    lotteryBuildings: [{ latitude: '40.6648982', longitude: '-73.9214715' }],
  }
  const { lat, lng } = extractLatLng(detailData)
  assert.ok(Math.abs(lat - 40.6648982) < 1e-7)
  assert.ok(Math.abs(lng - (-73.9214715)) < 1e-7)
})
