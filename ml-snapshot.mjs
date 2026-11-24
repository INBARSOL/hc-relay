/**
 * ml-snapshot.mjs
 *
 * Run by GitHub Actions on the 1st of each month.
 * Expects ml-lna.pdf to have been downloaded already (see ml-snapshot.yml).
 *
 * Required environment variables:
 *   WORKER_URL   - base URL of the Worker, e.g. https://lotto-lane-api.nyc-housing-app.workers.dev
 *   API_SECRET   - value of the API_SECRET Worker secret
 */

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');

const SOURCE_URL = 'https://www.nyc.gov/assets/hpd/downloads/pdfs/services/mitchell-lama-last-number-approved.pdf';
const BEDROOM_TYPES = ['studio', '1br', '2br', '3br', '4br'];
const DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
const INT_RE = /^\d+$/;
const SKIP_LINE_RE = /^(Mitchell-Lama Waiting Lists|Development\s*\t|--\s*\d+ of \d+\s*--)/i;
const UPDATED_LINE_RE = /^Updated\s+(\d{1,2}\/\d{1,2}\/\d{4})/i;
const HEADER_NAME_RE = /\b(Bedroom|Contact Info|Last Approval|Management Company|Studio Last|Status)\b/i;

async function extractText(pdfPath) {
  const absPath = resolve(pdfPath);
  const fileUrl = 'file:///' + absPath.replace(/\\/g, '/');
  const parser = new PDFParse({ url: fileUrl });
  const result = await parser.getText();
  return typeof result === 'string' ? result : result.text;
}

function cleanText(raw) {
  let pdfUpdated = null;
  const cleaned = raw
    .split('\n')
    .filter(line => {
      const t = line.trim();
      const updMatch = t.match(UPDATED_LINE_RE);
      if (updMatch) {
        if (!pdfUpdated) {
          const [m, d, y] = updMatch[1].split('/').map(Number);
          pdfUpdated = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        }
        return false;
      }
      return !SKIP_LINE_RE.test(t);
    })
    .join('\n');
  return { cleaned, pdfUpdated };
}

function splitIntoEntries(text) {
  const rawChunks = text.split(/(?<=\(\d{3}\)[-.\s]\d{3}[-.\s]\d{4})\n/);
  return rawChunks
    .map(e => e.trim())
    .filter(e => e.includes('Last Number') && e.includes('\t'));
}

function tokenise(tabGroup) {
  return tabGroup.split('\n').map(s => s.trim()).filter(Boolean);
}

function isDateOrNA(tok) {
  return tok === 'N/A' || DATE_RE.test(tok);
}

function isNumber(tok) {
  return INT_RE.test(tok);
}

function parseEntry(entry) {
  const tabs = entry.split('\t');
  const lnTabIdx = tabs.findIndex(t => t.includes('Last Number'));
  if (lnTabIdx < 0) return null;

  let devRaw;
  let extraFromStatus = '';
  let dataStart;

  if (lnTabIdx === 0) {
    const lnIdx = tabs[0].indexOf('Last Number');
    devRaw = tabs[0].substring(0, lnIdx);
    const approvedIdx = tabs[0].indexOf('Approved');
    if (approvedIdx >= 0) {
      const tail = tabs[0].substring(approvedIdx + 'Approved'.length);
      if (tail.trim()) extraFromStatus = tail;
    }
    dataStart = 1;
  } else {
    const prevTab = tabs[lnTabIdx - 1] || '';
    const prevLines = prevTab.split('\n').map(s => s.trim()).filter(Boolean);
    devRaw = prevLines[prevLines.length - 1] ?? prevTab;
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

  const contact = (tabs[tabs.length - 1] || '').trim();
  const management = (tabs[tabs.length - 2] || '').trim();

  const extraTokens = extraFromStatus ? tokenise(extraFromStatus) : [];
  const middleTabs = tabs.slice(dataStart, tabs.length - 2);
  const tokens = [...extraTokens, ...middleTabs.flatMap(tokenise)];

  if (tokens.length < 10) return null;

  const dateTokens = [];
  let i = tokens.length - 1;
  while (i >= 0 && dateTokens.length < 5) {
    dateTokens.unshift(tokens[i]);
    i--;
  }
  const countTokens = tokens.slice(0, i + 1);

  const bedrooms = [];
  let j = 0;
  while (j < countTokens.length && bedrooms.length < 5) {
    const tok = countTokens[j];
    if (tok === 'N/A') {
      bedrooms.push({ count: null, annotation: null });
      j++;
    } else if (isNumber(tok)) {
      let annotation = '';
      j++;
      while (j < countTokens.length) {
        const next = countTokens[j];
        if (next === 'N/A' || isNumber(next)) break;
        annotation += (annotation ? ' ' : '') + next.replace(/^\*/, '');
        j++;
      }
      bedrooms.push({ count: parseInt(tok, 10), annotation: annotation || null });
    } else {
      j++;
    }
  }
  while (bedrooms.length < 5) bedrooms.push({ count: null, annotation: null });

  const dates = dateTokens.map(tok => {
    if (tok === 'N/A' || !DATE_RE.test(tok)) return null;
    const [m, d, y] = tok.split('/').map(Number);
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  });
  while (dates.length < 5) dates.push(null);

  return BEDROOM_TYPES.map((size, idx) => ({
    development: name,
    bedroom_size: size,
    last_number_approved: bedrooms[idx]?.count ?? null,
    annotation: bedrooms[idx]?.annotation ?? null,
    last_approval_date: dates[idx] ?? null,
    management_company: management || null,
    contact_info: contact || null,
  }));
}

async function main() {
  const workerUrl = process.env.WORKER_URL;
  const apiSecret = process.env.API_SECRET;
  if (!workerUrl || !apiSecret) {
    console.error('[ml-snapshot] WORKER_URL and API_SECRET are required');
    process.exit(1);
  }

  const pdfPath = resolve(__dir, 'ml-lna.pdf');
  console.log(`[ml-snapshot] Parsing: ${pdfPath}`);

  const raw = await extractText(pdfPath);
  const { cleaned, pdfUpdated } = cleanText(raw);
  if (!pdfUpdated) {
    console.error('[ml-snapshot] Could not extract "Updated" date from PDF — aborting');
    process.exit(1);
  }
  console.log(`[ml-snapshot] PDF updated: ${pdfUpdated}`);

  const entries = splitIntoEntries(cleaned);
  const rows = [];
  for (const entry of entries) {
    const result = parseEntry(entry);
    if (result) rows.push(...result);
  }
  console.log(`[ml-snapshot] Parsed ${rows.length} rows from ${new Set(rows.map(r => r.development)).size} developments`);

  const payload = { pdf_updated: pdfUpdated, source_url: SOURCE_URL, rows };
  const res = await fetch(`${workerUrl}/internal/ml-snapshot`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Secret': apiSecret,
    },
    body: JSON.stringify(payload),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[ml-snapshot] Worker returned ${res.status}:`, json);
    process.exit(1);
  }
  if (json.stored === false) {
    console.log(`[ml-snapshot] Skipped: ${json.reason} (pdf_updated=${pdfUpdated} already stored)`);
  } else {
    console.log(`[ml-snapshot] Stored snapshot for ${pdfUpdated} (${json.row_count} rows)`);
  }
}

main().catch(err => {
  console.error('[ml-snapshot] Fatal:', err.message);
  process.exit(1);
});
