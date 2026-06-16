// scraper/wanhai-scraper.js
//
// Wan Hai Lines (WHL) cargo scraper — Puppeteer-driven, because wanhai.com is a
// stateful JSF/PrimeFaces site whose tracking flow depends on client-side
// JavaScript (formInit / formblSubmit) and live session state. A plain HTTP
// replay is NOT reliable here (verified), so we drive a real browser.
//
// Designed to slot into the existing scraper/ (which already uses puppeteer +
// googleapis). It exports scrapeWanHai(bl) returning a normalized record that
// maps onto the "ONE Line Daily Monitor" sheet columns:
//
//   BL Number | Search Code | Container No | Type | Origin | Destination |
//   Vessel | Voyage | ETA | Status | Last Updated | Notes | Track URL | Carrier
//
// Carrier value for these rows is "WHL".
//
// Flow (verified live against BL 025G657555):
//   1) Navigate to tracking_data_page_by_bl_redirect.xhtml?ref_no=BL&ref_type=MFT.
//      The page's own JS (formInit) completes the JSF flow and lands on
//      tracking_data_page_by_bl.xhtml with the full B/L detail rendered.
//   2) Parse the table.tbl-list tables for basic info + container rows.
//
// A standalone runner (runWanHaiScraper) is included at the bottom: it reads the
// "ONE Line Daily Monitor" sheet, scrapes every row whose Carrier column = "WHL",
// and writes the results back — reusing the same GOOGLE_SHEET_ID / GOOGLE_CREDS
// env vars as the existing scraper. It NEVER touches "ONE" rows.

const TRACK_URL = (bl) =>
  `https://www.wanhai.com/views/cargo_track_v2/tracking_data_page_by_bl_redirect.xhtml?ref_no=${encodeURIComponent(bl)}&ref_type=MFT`;

const NAV_TIMEOUT = 45000;

// Normalize a raw Wan Hai container status into the short sheet status, mirroring
// the spirit of the ONE Line mapStatus(). Adjust labels to taste.
function mapWhlStatus(raw) {
  if (!raw) return 'Pending';
  const s = raw.toLowerCase();
  if (/empty (container )?(discharged|returned|available)|gate in to pier|off-dock/.test(s))
    return 'Completed';
  if (/discharged (from|at)|arrived|import/.test(s)) return 'Arrived';
  if (/loaded|on board|departed|export|on vessel/.test(s)) return 'On Vessel';
  if (/gate out|delivered|picked up/.test(s)) return 'Delivered';
  return raw.length > 40 ? raw.slice(0, 40) + '…' : raw;
}

// Runs inside the page (browser context) on the B/L detail page. Returns the
// parsed shipment object. Mirrors the parser in server/wanhai.js but executed
// where the JS-rendered DOM is fully available.
function parseDetailInPage() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const tables = [...document.querySelectorAll('table.tbl-list')].map((t) =>
    [...t.querySelectorAll('tr')]
      .map((tr) => [...tr.querySelectorAll('td,th')].map((td) => clean(td.innerText)))
      .filter((r) => r.some((c) => c.length))
  );
  const findVal = (label) => {
    for (const rows of tables)
      for (const row of rows)
        for (let i = 0; i < row.length - 1; i++)
          if (row[i].toLowerCase() === label.toLowerCase()) return row[i + 1];
    return null;
  };
  const out = {
    blNo: findVal('BL no.'),
    blIssueDate: findVal('B/L Issue Date'),
    vesselName: findVal('Vessel Name'),
    voyage: findVal('Voyage'),
    placeOfReceipt: null,
    placeOfDelivery: null,
    portOfLoading: null,
    portOfDischarging: null,
    etd: null,
    eta: null,
    containers: [],
  };
  for (const rows of tables)
    for (const row of rows) {
      const label = (row[0] || '').toLowerCase();
      if (label === 'place of receipt') out.placeOfReceipt = row[1] || null;
      else if (label === 'port of loading') {
        out.portOfLoading = row[1] || null;
        if (/departure/i.test(row[3] || '')) out.etd = row[4] || null;
      } else if (label === 'port of discharging') {
        out.portOfDischarging = row[1] || null;
        if (/arrival/i.test(row[3] || '')) out.eta = row[4] || null;
      } else if (label === 'place of delivery') out.placeOfDelivery = row[1] || null;
    }
  for (const rows of tables) {
    const h = rows.findIndex((r) => r.some((c) => /^Ctnr No\.?$/i.test(c)));
    if (h === -1) continue;
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.length >= 8 && /^\d+$/.test(r[0])) {
        out.containers.push({
          ctnrNo: r[1] || null,
          typeSize: r[2] || null,
          sealNo: r[3] || null,
          maxGrossWeight: r[4] || null,
          currentStatus: r[7] || null,
          statusDate: r[8] || null,
        });
      }
    }
  }
  return out;
}

/**
 * Scrape a single Wan Hai BL/booking number with an existing puppeteer browser.
 * @param {import('puppeteer').Browser} browser  shared browser instance
 * @param {string} bl  BL or booking number, e.g. "025G657555"
 * @returns {Promise<object>} normalized record (sheet-ready fields + raw)
 */
async function scrapeWanHai(browser, bl) {
  const ref = String(bl).trim().toUpperCase();
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  try {
    // Navigate straight to the redirect entry URL. The page's own JS (formInit)
    // completes the JSF flow and lands on tracking_data_page_by_bl.xhtml with the
    // full detail rendered. This single-tab path is far more reliable under
    // automation than driving the multi-popup quick-query form. (Verified live:
    // the detail page renders 5 tbl-list tables incl. vessel + container rows.)
    await page.goto(TRACK_URL(ref), { waitUntil: 'networkidle2' });

    // Wait until we're actually on the *detail* page (by_bl.xhtml) AND the
    // basic-info table has populated. Guard against matching the intermediate
    // redirect page or the shallow list page.
    await page
      .waitForFunction(
        () =>
          /tracking_data_page_by_bl\.xhtml/.test(location.pathname) &&
          document.querySelectorAll('table.tbl-list').length >= 2 &&
          /Vessel Name/i.test(document.body.innerText),
        { timeout: 30000 }
      )
      .catch(() => {});

    // Parse the detail.
    const data = await page.evaluate(parseDetailInPage);
    await page.close().catch(() => {});

    const first = data.containers[0] || {};
    const status = mapWhlStatus(first.currentStatus);

    return {
      found: !!(data.blNo || data.vesselName),
      blNumber: data.blNo || ref,
      searchCode: ref,
      containerNo: first.ctnrNo || (data.containers.length ? '' : 'Pending'),
      type: first.typeSize || '',
      origin: data.placeOfReceipt || data.portOfLoading || '',
      destination: data.placeOfDelivery || data.portOfDischarging || '',
      vessel: data.vesselName || '',
      voyage: data.voyage || '',
      eta: data.eta || '',
      status,
      lastUpdated: new Date().toISOString(),
      notes: first.currentStatus || '',
      trackUrl: TRACK_URL(ref),
      carrier: 'WANHAI',
      raw: data,
    };
  } catch (err) {
    await page.close().catch(() => {});
    return {
      found: false,
      blNumber: ref,
      searchCode: ref,
      containerNo: 'Pending',
      type: '',
      origin: '',
      destination: '',
      vessel: '',
      voyage: '',
      eta: '',
      status: 'Error',
      lastUpdated: new Date().toISOString(),
      notes: `WHL scrape error: ${err.message}`,
      trackUrl: TRACK_URL(ref),
      carrier: 'WANHAI',
      raw: null,
    };
  }
}

module.exports = { scrapeWanHai, mapWhlStatus };

/* ─── STANDALONE RUNNER ──────────────────────────────────────────────────────
 * Reads the monitor sheet, scrapes all Carrier="WHL" rows, writes results back.
 * Reuses the same env vars as the existing ONE Line scraper:
 *   GOOGLE_SHEET_ID, GOOGLE_CREDS (service-account JSON)
 * Optional: WHL_SHEET_TAB (defaults to "ONE Line Daily Monitor").
 *
 * Column layout (A–N), 1 header row:
 *   A BL Number | B Search Code | C Container No | D Type | E Origin |
 *   F Destination | G Vessel | H Voyage | I ETA | J Status | K Last Updated |
 *   L Notes | M Track URL | N Carrier
 * ───────────────────────────────────────────────────────────────────────── */

const SHEET_TAB = process.env.WHL_SHEET_TAB || 'ONE Line Daily Monitor';
const CARRIER_TAG = 'WANHAI';

async function getSheetsClient() {
  const { google } = require('googleapis');
  const creds = JSON.parse(process.env.GOOGLE_CREDS);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

async function runWanHaiScraper() {
  const puppeteer = require('puppeteer');
  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  if (!SHEET_ID || !process.env.GOOGLE_CREDS) {
    throw new Error('Missing GOOGLE_SHEET_ID or GOOGLE_CREDS env var');
  }

  const sheets = await getSheetsClient();

  // Read all rows.
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A1:N`,
  });
  const rows = res.data.values || [];
  if (rows.length < 2) {
    console.log('[WHL] No data rows found.');
    return;
  }

  // Find WHL rows (column N index 13). rowNumber is 1-based incl. header.
  const targets = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const carrier = (row[13] || row[row.length - 1] || '').toString().trim().toUpperCase();
    const bl = (row[0] || row[1] || '').toString().trim();
    if (carrier === CARRIER_TAG && bl) targets.push({ rowNumber: i + 1, bl });
  }
  if (!targets.length) {
    console.log(`[WHL] No rows with Carrier="${CARRIER_TAG}" to scrape.`);
    return;
  }
  console.log(`[WHL] Scraping ${targets.length} Wan Hai BL(s): ${targets.map((t) => t.bl).join(', ')}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const updates = [];
  try {
    for (const t of targets) {
      const rec = await scrapeWanHai(browser, t.bl);
      console.log(
        `[WHL] ${t.bl} -> ${rec.found ? 'OK' : 'NOT FOUND'} | ${rec.vessel || '-'} | ${rec.status}`
      );
      // Map record onto columns A–N for this row.
      updates.push({
        range: `${SHEET_TAB}!A${t.rowNumber}:N${t.rowNumber}`,
        values: [[
          rec.blNumber,
          rec.searchCode,
          rec.containerNo,
          rec.type,
          rec.origin,
          rec.destination,
          rec.vessel,
          rec.voyage,
          rec.eta,
          rec.status,
          rec.lastUpdated,
          rec.notes,
          rec.trackUrl,
          CARRIER_TAG,
        ]],
      });
    }
  } finally {
    await browser.close().catch(() => {});
  }

  if (updates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { valueInputOption: 'RAW', data: updates },
    });
    console.log(`[WHL] Wrote ${updates.length} row(s) to "${SHEET_TAB}".`);
  }
}

// Run directly: `node scraper/wanhai-scraper.js`
if (require.main === module) {
  runWanHaiScraper().catch((e) => {
    console.error('[WHL] Fatal:', e);
    process.exit(1);
  });
}

module.exports.runWanHaiScraper = runWanHaiScraper;
