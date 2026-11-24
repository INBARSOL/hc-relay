/**
 * ml-snapshot.mjs
 *
 * Run by GitHub Actions on the 1st of each month.
 * Downloads the HPD Mitchell-Lama LNA PDF, parses it, and POSTs the
 * snapshot to the Worker's /internal/ml-snapshot route.
 *
 * Required environment variables:
 *   WORKER_URL   - base URL of the Worker
 *   API_SECRET   - value of the API_SECRET Worker secret
 *
 * CLI options:
 *   --file <path>   Skip the download and parse a local PDF instead (for testing).
 *                   Example:
 *                     node ml-snapshot.mjs --file ../../samples/mitchell-lama-lna-sample.pdf
 *                   When --file is used, WORKER_URL / API_SECRET are not required
 *                   unless --post is also passed.
 *   --post          Even with --file, POST the result to the Worker.
 */

import { writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { parseMitchellLamaLNA } from './parse-ml-last-number.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))

const SOURCE_URL =
  'https://www.nyc.gov/assets/hpd/downloads/pdfs/services/mitchell-lama-last-number-approved.pdf'

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
const fileIdx = args.indexOf('--file')
const localFile = fileIdx >= 0 ? args[fileIdx + 1] : null
const forcePost = args.includes('--post')

// ---------------------------------------------------------------------------
// Download with redirect-following, browser User-Agent, and up to 3 retries.
// Validates that the response is an actual PDF before saving the file.
// ---------------------------------------------------------------------------
async function downloadPdf(url, destPath, maxRetries = 3) {
  let lastErr
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (attempt > 1) {
      const wait = attempt * 2000
      console.log(`[ml-snapshot] Retry ${attempt}/${maxRetries} in ${wait / 1000}s…`)
      await new Promise(r => setTimeout(r, wait))
    }
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; LottoLaneBot/1.0; +https://lotto-lane-web.pages.dev)',
          Accept: 'application/pdf,*/*',
        },
      })

      if (!res.ok) {
        const preview = await res.text().then(t => t.slice(0, 300)).catch(() => '')
        throw new Error(
          `HTTP ${res.status} ${res.statusText} — ` +
          `Content-Type: ${res.headers.get('content-type') ?? 'unknown'} — ` +
          `body: ${preview}`,
        )
      }

      const buf = Buffer.from(await res.arrayBuffer())

      // Validate magic bytes — a block page or redirect HTML would not start with %PDF
      const magic = buf.slice(0, 4).toString('ascii')
      if (magic !== '%PDF') {
        const preview = buf.slice(0, 300).toString('utf-8').replace(/\r?\n/g, ' ')
        const ct = res.headers.get('content-type') ?? 'unknown'
        throw new Error(
          `Downloaded file is not a PDF (starts with ${JSON.stringify(magic)}) — ` +
          `Content-Type: ${ct} — body: ${preview}`,
        )
      }

      writeFileSync(destPath, buf)
      console.log(`[ml-snapshot] Downloaded ${buf.length} bytes → ${destPath}`)
      return destPath
    } catch (err) {
      lastErr = err
      console.error(`[ml-snapshot] Download attempt ${attempt} failed: ${err.message}`)
    }
  }
  throw new Error(`All ${maxRetries} download attempts failed.\nLast error: ${lastErr.message}`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  let pdfPath

  if (localFile) {
    // --file mode: skip download, use the provided path
    pdfPath = resolve(localFile)
    console.log(`[ml-snapshot] Using local file: ${pdfPath}`)
  } else {
    const workerUrl = process.env.WORKER_URL
    const apiSecret = process.env.API_SECRET
    if (!workerUrl || !apiSecret) {
      console.error(
        '[ml-snapshot] WORKER_URL and API_SECRET environment variables are required ' +
        '(or use --file <path> to skip download and POST)',
      )
      process.exit(1)
    }
    pdfPath = resolve(__dir, 'ml-lna.pdf')
    await downloadPdf(SOURCE_URL, pdfPath)
  }

  // parseMitchellLamaLNA is the same function used by scripts/parse-ml-last-number.mjs
  const result = await parseMitchellLamaLNA(pdfPath)

  const devCount = new Set(result.rows.map(r => r.development)).size
  console.log(`[ml-snapshot] Parsed ${result.rows.length} rows from ${devCount} developments`)
  console.log(`[ml-snapshot] PDF updated: ${result.pdf_updated}`)

  // In --file mode without --post, stop here (useful for local testing)
  if (localFile && !forcePost) {
    if (!result.pdf_updated) {
      console.warn(
        '[ml-snapshot] Warning: "Updated MM/DD/YYYY" header not found in this file ' +
        '(sample PDFs captured before that header existed will show this).',
      )
    }
    console.log('[ml-snapshot] --file mode: skipping POST. Pass --post to send to Worker.')
    return
  }

  if (!result.pdf_updated) {
    console.error(
      '[ml-snapshot] Could not find "Updated MM/DD/YYYY" header in PDF. ' +
      'The PDF format may have changed. Aborting.',
    )
    process.exit(1)
  }

  const workerUrl = process.env.WORKER_URL
  const apiSecret = process.env.API_SECRET
  if (!workerUrl || !apiSecret) {
    console.error('[ml-snapshot] WORKER_URL and API_SECRET are required to POST to Worker')
    process.exit(1)
  }

  const payload = {
    pdf_updated: result.pdf_updated,
    source_url: SOURCE_URL,
    rows: result.rows,
  }

  const res = await fetch(`${workerUrl}/internal/ml-snapshot`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Secret': apiSecret,
    },
    body: JSON.stringify(payload),
  })

  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    console.error(`[ml-snapshot] Worker returned ${res.status}:`, JSON.stringify(json))
    process.exit(1)
  }
  if (json.stored === false) {
    console.log(
      `[ml-snapshot] Skipped: ${json.reason} (pdf_updated=${result.pdf_updated} already stored)`,
    )
  } else {
    console.log(
      `[ml-snapshot] Stored snapshot for ${result.pdf_updated} (${json.row_count} rows)`,
    )
  }
}

main().catch(err => {
  console.error('[ml-snapshot] Fatal:', err.message)
  process.exit(1)
})
