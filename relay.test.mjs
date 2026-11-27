/**
 * Tests for relay.mjs safety guards:
 *   - validateSearchResponse: schema validation of HC search response
 *   - count-drop guard (integration: main() exits when >50% drop detected)
 *
 * Run with: node --test relay.test.mjs
 * (uses Node.js built-in test runner, no extra deps required)
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  validateSearchResponse,
  deduplicateByContentHash,
  loadPhotoHashCache,
  savePhotoHashCache,
  _photoHashCache,
  _resetRunCounters,
  DOWNLOAD_CAP,
} from './relay.mjs'

const VALID_LISTING = { lotteryId: 1234, borough: 'Brooklyn', lotteryEndDate: '2026-12-01T00:00:00' }

describe('validateSearchResponse', () => {
  it('accepts a well-formed response', () => {
    const data = { rentals: [VALID_LISTING], sales: [] }
    const listings = validateSearchResponse(data)
    assert.equal(listings.length, 1)
  })

  it('accepts a response with both rentals and sales', () => {
    const data = { rentals: [VALID_LISTING], sales: [VALID_LISTING] }
    const listings = validateSearchResponse(data)
    assert.equal(listings.length, 2)
  })

  it('throws when response is not an object', () => {
    assert.throws(
      () => validateSearchResponse(null),
      /schema error.*not an object/,
    )
    assert.throws(
      () => validateSearchResponse('string'),
      /schema error.*not an object/,
    )
  })

  it('throws when rentals is missing', () => {
    assert.throws(
      () => validateSearchResponse({ sales: [] }),
      /schema error.*rentals/,
    )
  })

  it('throws when sales is missing', () => {
    assert.throws(
      () => validateSearchResponse({ rentals: [] }),
      /schema error.*sales/,
    )
  })

  it('throws when a listing is missing lotteryId', () => {
    const bad = { rentals: [{ borough: 'Bronx' }], sales: [] }
    assert.throws(
      () => validateSearchResponse(bad),
      /schema error.*lotteryId/,
    )
  })

  it('throws when a listing is missing borough', () => {
    const bad = { rentals: [{ lotteryId: 1 }], sales: [] }
    assert.throws(
      () => validateSearchResponse(bad),
      /schema error.*borough/,
    )
  })

  it('accepts empty rentals and sales arrays', () => {
    // 0 count is handled separately (exits in main); validateSearchResponse just checks structure
    const listings = validateSearchResponse({ rentals: [], sales: [] })
    assert.equal(listings.length, 0)
  })
})

// ── deduplicateByContentHash ──────────────────────────────────────────────────

const TODAY = new Date().toISOString().slice(0, 10)
const YESTERDAY = (() => {
  const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10)
})()

describe('deduplicateByContentHash', () => {
  beforeEach(() => {
    _photoHashCache.clear()
    _resetRunCounters()
  })

  it('keeps photo when download fails (non-ok status)', async () => {
    const orig = globalThis.fetch
    globalThis.fetch = async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) })
    try {
      const result = await deduplicateByContentHash(['https://example.com/a.png'])
      assert.deepEqual(result, ['https://example.com/a.png'])
      // Entry stored as failed
      assert.equal(_photoHashCache.get('https://example.com/a.png')?.hash, 'failed')
    } finally { globalThis.fetch = orig }
  })

  it('keeps photo when download throws (network error)', async () => {
    const orig = globalThis.fetch
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
    try {
      const result = await deduplicateByContentHash(['https://example.com/b.png'])
      assert.deepEqual(result, ['https://example.com/b.png'])
    } finally { globalThis.fetch = orig }
  })

  it('removes duplicate URLs with identical content', async () => {
    const bytes = Buffer.from('fake-image-bytes')
    const orig = globalThis.fetch
    globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => bytes.buffer })
    try {
      const result = await deduplicateByContentHash([
        'https://example.com/38677809.png',
        'https://example.com/38677890.png',
      ])
      assert.equal(result.length, 1)
      assert.equal(result[0], 'https://example.com/38677809.png')
    } finally { globalThis.fetch = orig }
  })

  it('cache hit: does not re-fetch a URL already hashed this run', async () => {
    // Pre-seed the cache with a valid hash entry
    _photoHashCache.set('https://example.com/c.png', { hash: 'abc123', date: TODAY })
    let fetchCount = 0
    const orig = globalThis.fetch
    globalThis.fetch = async () => { fetchCount++; return { ok: true, arrayBuffer: async () => Buffer.from('x').buffer } }
    try {
      const result = await deduplicateByContentHash(['https://example.com/c.png'])
      assert.equal(fetchCount, 0, 'should use cache, no fetch')
      assert.deepEqual(result, ['https://example.com/c.png'])
    } finally { globalThis.fetch = orig }
  })

  it('failed today: skips retry, keeps URL as-is without downloading', async () => {
    _photoHashCache.set('https://example.com/f.png', { hash: 'failed', date: TODAY })
    let fetchCount = 0
    const orig = globalThis.fetch
    globalThis.fetch = async () => { fetchCount++; throw new Error('should not reach') }
    try {
      const result = await deduplicateByContentHash(['https://example.com/f.png'])
      assert.equal(fetchCount, 0)
      assert.deepEqual(result, ['https://example.com/f.png'])
    } finally { globalThis.fetch = orig }
  })

  it('failed yesterday: retries the download once', async () => {
    _photoHashCache.set('https://example.com/g.png', { hash: 'failed', date: YESTERDAY })
    let fetchCount = 0
    const bytes = Buffer.from('retry-image')
    const orig = globalThis.fetch
    globalThis.fetch = async () => { fetchCount++; return { ok: true, arrayBuffer: async () => bytes.buffer } }
    try {
      const result = await deduplicateByContentHash(['https://example.com/g.png'])
      assert.equal(fetchCount, 1, 'should retry once')
      assert.deepEqual(result, ['https://example.com/g.png'])
      // Now cached with real hash
      assert.notEqual(_photoHashCache.get('https://example.com/g.png')?.hash, 'failed')
    } finally { globalThis.fetch = orig }
  })

  it('download cap: URLs beyond DOWNLOAD_CAP are kept without downloading', async () => {
    _photoHashCache.clear()
    _resetRunCounters()

    let callNum = 0
    const orig = globalThis.fetch
    globalThis.fetch = async () => {
      callNum++
      // Each call returns unique bytes so dedup does not remove them
      return { ok: true, arrayBuffer: async () => Buffer.from(`content-${callNum}`).buffer }
    }
    try {
      // Burn exactly DOWNLOAD_CAP downloads with unique URLs
      const burnUrls = Array.from({ length: DOWNLOAD_CAP }, (_, i) => `https://example.com/burn-${i}.png`)
      await deduplicateByContentHash(burnUrls)
      assert.equal(callNum, DOWNLOAD_CAP, 'should have done exactly DOWNLOAD_CAP downloads')

      // Next URL must be capped — no fetch should occur
      const result = await deduplicateByContentHash(['https://example.com/capped.png'])
      assert.deepEqual(result, ['https://example.com/capped.png'], 'capped URL should be kept as-is')
      assert.equal(callNum, DOWNLOAD_CAP, 'no extra download after cap')
    } finally { globalThis.fetch = orig }
  })
})

// ── loadPhotoHashCache / savePhotoHashCache ───────────────────────────────────

describe('photo hash cache persistence', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'relay-test-'))
    _photoHashCache.clear()
    _resetRunCounters()
  })

  it('loadPhotoHashCache populates _photoHashCache from file', () => {
    const file = join(tmpDir, 'hashes.json')
    writeFileSync(file, JSON.stringify({
      'https://a.com/p.png': { hash: 'deadbeef', date: TODAY },
    }), 'utf-8')
    loadPhotoHashCache(file)
    assert.deepEqual(_photoHashCache.get('https://a.com/p.png'), { hash: 'deadbeef', date: TODAY })
  })

  it('loadPhotoHashCache prunes entries older than 30 days', () => {
    const old = new Date()
    old.setDate(old.getDate() - 31)
    const oldDate = old.toISOString().slice(0, 10)
    const file = join(tmpDir, 'hashes.json')
    writeFileSync(file, JSON.stringify({
      'https://a.com/old.png': { hash: 'oldhash', date: oldDate },
      'https://a.com/new.png': { hash: 'newhash', date: TODAY },
    }), 'utf-8')
    loadPhotoHashCache(file)
    assert.equal(_photoHashCache.has('https://a.com/old.png'), false, 'old entry should be pruned')
    assert.equal(_photoHashCache.has('https://a.com/new.png'), true, 'recent entry should survive')
  })

  it('loadPhotoHashCache is a no-op when file does not exist', () => {
    // Should not throw
    loadPhotoHashCache(join(tmpDir, 'nonexistent.json'))
    assert.equal(_photoHashCache.size, 0)
  })

  it('savePhotoHashCache writes entries to disk', () => {
    _photoHashCache.set('https://b.com/p.png', { hash: 'cafe1234', date: TODAY })
    const file = join(tmpDir, 'out.json')
    savePhotoHashCache(file)
    const written = JSON.parse(readFileSync(file, 'utf-8'))
    assert.deepEqual(written['https://b.com/p.png'], { hash: 'cafe1234', date: TODAY })
  })

  it('round-trips: save then load restores the same entries', () => {
    const file = join(tmpDir, 'rt.json')
    _photoHashCache.set('https://c.com/x.png', { hash: 'aabbcc', date: TODAY })
    _photoHashCache.set('https://c.com/y.png', { hash: 'failed', date: TODAY })
    savePhotoHashCache(file)
    _photoHashCache.clear()
    loadPhotoHashCache(file)
    assert.deepEqual(_photoHashCache.get('https://c.com/x.png'), { hash: 'aabbcc', date: TODAY })
    assert.deepEqual(_photoHashCache.get('https://c.com/y.png'), { hash: 'failed', date: TODAY })
  })
})
