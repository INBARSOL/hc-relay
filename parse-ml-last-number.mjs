/**
 * scripts/parse-ml-last-number.mjs
 *
 * Parse the HPD Mitchell-Lama "Last Number Approved" PDF into structured JSON.
 *
 * Usage:
 *   node scripts/parse-ml-last-number.mjs [path-to-pdf]
 *
 * Default input:  samples/mitchell-lama-lna-sample.pdf
 * Default output: samples/mitchell-lama-lna-parsed.json
 *
 * Source URL: https://www.nyc.gov/assets/hpd/downloads/pdfs/services/mitchell-lama-last-number-approved.pdf
 */

import { createRequire } from 'module';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, '..');

const BEDROOM_TYPES = ['studio', '1br', '2br', '3br', '4br'];
const DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
const INT_RE = /^\d+$/;
const ANNOTATION_START_RE = /^\*/;
// Page header/footer lines to skip
// Lines to drop: page title, page markers, and the full column-header row (starts with "Development\t")
const SKIP_LINE_RE = /^(Mitchell-Lama Waiting Lists|Development\s*\t|--\s*\d+ of \d+\s*--)/i;
// Matches the "Updated M/D/YYYY" line in the PDF header
const UPDATED_LINE_RE = /Updated\s+(\d{1,2}\/\d{1,2}\/\d{4})/i;
// Column-header indicator: a chunk whose "dev name" contains these words is a header artifact
const HEADER_NAME_RE = /\b(Bedroom|Contact Info|Last Approval|Management Company|Studio Last|Status)\b/i;

/** Extract text from a local PDF file and return raw string. */
async function extractText(pdfPath) {
  const absPath = resolve(pdfPath);
  const fileUrl = 'file:///' + absPath.replace(/\\/g, '/');
  const parser = new PDFParse({ url: fileUrl });
  const result = await parser.getText();
  return typeof result === 'string' ? result : result.text;
}

/** Remove header/footer noise lines from raw PDF text; also extract the PDF's "Updated" date. */
function cleanText(raw) {
  let pdfUpdated = null;
  const cleaned = raw
    .split('\n')
    .filter(line => {
      const t = line.trim();
      const updMatch = t.match(UPDATED_LINE_RE);
      if (updMatch) {
        // Capture the first "Updated M/D/YYYY" we see (consistent across all pages)
        if (!pdfUpdated) {
          const [m, d, y] = updMatch[1].split('/').map(Number);
          pdfUpdated = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        }
        return false; // skip this line from body
      }
      return !SKIP_LINE_RE.test(t);
    })
    .join('\n');
  return { cleaned, pdfUpdated };
}

/**
 * Split raw text into one string per development entry.
 * Each entry begins with the development name and contains all its data.
 * The marker "Last Number\nApproved" appears once per row (may be tab- or newline-separated
 * from the development name).
 */
/**
 * Collect the development name from the tail of a chunk.
 * The dev name is whatever comes after the last phone-number line of the PREVIOUS entry,
 * which is the first "paragraph" of this chunk before any tab or "Last Number".
 */
function extractDevName(chunk) {
  // Everything up to the first "\tLast Number" or "\nLast Number" is the dev name + status.
  const lnIdx = chunk.indexOf('Last Number');
  if (lnIdx < 0) return null;
  const before = chunk.substring(0, lnIdx);
  return before.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function splitIntoEntries(text) {
  // Rows end with a contact phone number on its own tab group.
  // Split on phone pattern followed by newline to get per-entry chunks.
  // Each chunk starts with the development name text.
  const rawChunks = text.split(/(?<=\(\d{3}\)[-.\s]\d{3}[-.\s]\d{4})\n/);

  return rawChunks
    .map(e => e.trim())
    .filter(e => e.includes('Last Number') && e.includes('\t'));
}

/** Tokenise a tab group by splitting on newlines and trimming each part. */
function tokenise(tabGroup) {
  return tabGroup.split('\n').map(s => s.trim()).filter(Boolean);
}

/** True if token is a date (M/D/YYYY) or "N/A". */
function isDateOrNA(tok) {
  return tok === 'N/A' || DATE_RE.test(tok);
}

/** True if token is an integer wait-list number. */
function isNumber(tok) {
  return INT_RE.test(tok);
}

/**
 * Parse one development entry string into a structured row.
 * Returns null if the entry cannot be parsed.
 */
function parseEntry(entry) {
  // Split on tabs
  const tabs = entry.split('\t');

  // Find which tab group contains "Last Number\nApproved".
  // Normally it's tabs[1] (single-line dev name) or tabs[0] (multi-line dev name).
  // But the first entry on each page is preceded by multi-line column-header noise that
  // survives cleanText(), pushing the status tab to tabs[2] (or beyond).
  const lnTabIdx = tabs.findIndex(t => t.includes('Last Number'));
  if (lnTabIdx < 0) return null;

  let devRaw;
  let extraFromStatus = ''; // bedroom data embedded in the status tab group
  let dataStart;

  if (lnTabIdx === 0) {
    // Multi-line dev name: tabs[0] = "DevName\n…\nLast Number\nApproved"
    const lnIdx = tabs[0].indexOf('Last Number');
    devRaw = tabs[0].substring(0, lnIdx);
    const approvedIdx = tabs[0].indexOf('Approved');
    if (approvedIdx >= 0) {
      const tail = tabs[0].substring(approvedIdx + 'Approved'.length);
      if (tail.trim()) extraFromStatus = tail;
    }
    dataStart = 1;
  } else {
    // Dev name is the LAST non-empty line of the tab just before "Last Number".
    // (For clean entries that last line is the full dev name; for first-on-page entries
    //  the preceding tab starts with column-header remnants like "Contact Info".)
    const prevTab = tabs[lnTabIdx - 1] || '';
    const prevLines = prevTab.split('\n').map(s => s.trim()).filter(Boolean);
    devRaw = prevLines[prevLines.length - 1] ?? prevTab;

    // Check if status tab has extra data after "Approved"
    const lnTab = tabs[lnTabIdx];
    const approvedIdx = lnTab.indexOf('Approved');
    if (approvedIdx >= 0) {
      const tail = lnTab.substring(approvedIdx + 'Approved'.length);
      if (tail.trim()) extraFromStatus = tail;
    }
    dataStart = lnTabIdx + 1;
  }

  const name = devRaw.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name || HEADER_NAME_RE.test(name)) return null;

  // Last two tabs are management company and contact
  const contact = (tabs[tabs.length - 1] || '').trim();
  const management = (tabs[tabs.length - 2] || '').trim();

  // Middle tabs hold bedroom counts + dates; prepend any extra from status tab
  const extraTokens = extraFromStatus ? tokenise(extraFromStatus) : [];
  const middleTabs = tabs.slice(dataStart, tabs.length - 2);
  const tokens = [...extraTokens, ...middleTabs.flatMap(tokenise)];

  if (tokens.length < 10) return null; // Need at least 5 counts + 5 dates

  // Work from the right: collect exactly 5 date/NA tokens (the approval dates).
  // Dates always come after the bedroom counts in the PDF's column order.
  const dateTokens = [];
  const countTokens = [];
  let i = tokens.length - 1;
  while (i >= 0 && dateTokens.length < 5) {
    dateTokens.unshift(tokens[i]);
    i--;
  }
  while (i >= 0) {
    countTokens.unshift(tokens[i]);
    i--;
  }

  // Extract 5 bedroom count values left-to-right from countTokens.
  // A "value" is N/A or an integer, optionally followed by an annotation (tokens starting with * or plain words).
  const bedrooms = /** @type {Array<{count: number|null, annotation: string|null}>} */ ([]);
  let j = 0;
  while (j < countTokens.length && bedrooms.length < 5) {
    const tok = countTokens[j];
    if (tok === 'N/A') {
      bedrooms.push({ count: null, annotation: null });
      j++;
    } else if (isNumber(tok)) {
      let annotation = '';
      j++;
      // Collect annotation tokens until we hit the next value or run out
      while (j < countTokens.length) {
        const next = countTokens[j];
        if (next === 'N/A' || isNumber(next)) break;
        annotation += (annotation ? ' ' : '') + next.replace(/^\*/, '');
        j++;
      }
      bedrooms.push({ count: parseInt(tok, 10), annotation: annotation || null });
    } else {
      j++; // skip unexpected token
    }
  }

  // Pad to 5 if fewer were found
  while (bedrooms.length < 5) bedrooms.push({ count: null, annotation: null });

  // Parse date tokens (M/D/YYYY → ISO date string, N/A → null)
  const dates = dateTokens.map(tok => {
    if (tok === 'N/A' || !DATE_RE.test(tok)) return null;
    const [m, d, y] = tok.split('/').map(Number);
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  });
  while (dates.length < 5) dates.push(null);

  // Build per-bedroom-size rows
  const rows = BEDROOM_TYPES.map((size, idx) => ({
    development: name,
    bedroom_size: size,
    last_number_approved: bedrooms[idx]?.count ?? null,
    annotation: bedrooms[idx]?.annotation ?? null,
    last_approval_date: dates[idx] ?? null,
    management_company: management || null,
    contact_info: contact || null,
  }));

  return rows;
}

/**
 * Parse the LNA PDF and return structured JSON.
 * @param {string} pdfPath - path to the PDF file
 * @returns {Promise<{fetched_at: string, source_url: string, rows: Array}>}
 */
export async function parseMitchellLamaLNA(pdfPath) {
  const raw = await extractText(pdfPath);
  const { cleaned: clean, pdfUpdated } = cleanText(raw);
  const entries = splitIntoEntries(clean);

  const rows = [];
  const skipped = [];

  for (const entry of entries) {
    const result = parseEntry(entry);
    if (result) {
      rows.push(...result);
    } else {
      skipped.push(entry.substring(0, 60));
    }
  }

  if (skipped.length > 0) {
    console.warn(`[parse-ml] Skipped ${skipped.length} entries:`, skipped);
  }

  return {
    pdf_updated: pdfUpdated,
    fetched_at: new Date().toISOString(),
    source_url: 'https://www.nyc.gov/assets/hpd/downloads/pdfs/services/mitchell-lama-last-number-approved.pdf',
    rows,
  };
}

// CLI entrypoint
if (process.argv[1] && process.argv[1].endsWith('parse-ml-last-number.mjs')) {
  const inputPath = process.argv[2] || resolve(root, 'samples/mitchell-lama-lna-sample.pdf');
  const outputPath = resolve(root, 'samples/mitchell-lama-lna-parsed.json');

  console.log(`[parse-ml] Reading: ${inputPath}`);
  parseMitchellLamaLNA(inputPath)
    .then(result => {
      writeFileSync(outputPath, JSON.stringify(result, null, 2));
      const devCount = new Set(result.rows.map(r => r.development)).size;
      console.log(`[parse-ml] Done: ${devCount} developments, ${result.rows.length} rows`);
      console.log(`[parse-ml] Output: ${outputPath}`);
    })
    .catch(err => {
      console.error('[parse-ml] Error:', err.message);
      process.exit(1);
    });
}
