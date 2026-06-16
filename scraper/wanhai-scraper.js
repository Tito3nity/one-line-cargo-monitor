// scraper/wanhai-scraper.js
//
// Wan Hai Lines (WHL) cargo scraper — Puppeteer-driven.
//
// Wan Hai's cargo_track_v2 is a stateful JSF/PrimeFaces app. The old direct
// "tracking_data_page_by_bl_redirect.xhtml?ref_no=..." shortcut was deprecated
// and now hangs on "loading...". The current working flow (verified live):
//
//   1) Load the tracking form: cargo_track.xhtml
//   2) Select cargo type "BL no." (#cargoType), fill #q_ref_no1 with the BL,
//      click the Query submit (#quick_ctnr_query).
//   3) Results open in a NEW popup tab: tracking_data_list.xhtml — a
//      "Tracking Information List" with columns:
//        BL no. | Oboard Date | Voyage | Vessel Name | More detail
//   4) Parse that list row for BL / Onboard Date / Voyage / Vessel Name.
//
// Maps onto the "ONE Line Daily Monitor" sheet columns (A–N). Carrier = WANHAI.
// The runner reads WANHAI-tagged rows and writes results back, never touching
// ONE rows.

const QUERY_PAGE = 'https://www.wanhai.com/views/cargo_track_v2/cargo_track.xhtml';
const NAV_TIMEOUT = 45000;

async function scrapeWanHai(browser, bl) {
  const ref = String(bl).trim().toUpperCase();
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  let listPage = null;
  try {
    await page.goto(QUERY_PAGE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#q_ref_no1', { timeout: 20000 });

    await page.evaluate((refNo) => {
      const sel = document.getElementById('cargoType');
      if (sel) {
        const opt = [...sel.options].find((o) => /BL no/i.test(o.text));
        if (opt) sel.value = opt.value;
      }
      const inp = document.getElementById('q_ref_no1');
      if (inp) inp.value = refNo;
    }, ref);

    // The Query button opens results in a NEW tab/popup.
    const newPagePromise = new Promise((resolve) => {
      browser.once('targetcreated', async (target) => {
        try { resolve(await target.page()); } catch (e) { resolve(null); }
      });
    });

    await page.click('#quick_ctnr_query').catch(async () => {
      await page.evaluate(() => {
        const b = document.getElementById('quick_ctnr_query');
        if (b) b.click();
      });
    });

    listPage = await Promise.race([
      newPagePromise,
      new Promise((r) => setTimeout(() => r(null), 12000)),
    ]);

    const target = listPage || page;
    await target
      .waitForFunction(
        () =>
          document.querySelector('table.tbl-list') &&
          /Vessel Name|BL no\./i.test(document.body.innerText),
        { timeout: 20000 }
      )
      .catch(() => {});

    const summary = await target.evaluate((refNo) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      for (const tbl of document.querySelectorAll('table.tbl-list')) {
        const rows = [...tbl.querySelectorAll('tr')].map((tr) =>
          [...tr.querySelectorAll('td,th')].map((td) => clean(td.innerText))
        );
        const header = rows[0] || [];
        const col = (re) => header.findIndex((h) => re.test(h));
        const iBl = col(/BL no/i), iOb = col(/board/i),
          iVoy = col(/Voyage/i), iVes = col(/Vessel/i);
        for (let r = 1; r < rows.length; r++) {
          const row = rows[r];
          const blCell = iBl >= 0 ? row[iBl] : row[1];
          if (blCell && blCell.toUpperCase().includes(refNo)) {
            return {
              bl: blCell,
              onboardDate: iOb >= 0 ? row[iOb] : '',
              voyage: iVoy >= 0 ? row[iVoy] : '',
              vessel: iVes >= 0 ? row[iVes] : '',
            };
          }
        }
      }
      return null;
    }, ref);

    if (listPage) await listPage.close().catch(() => {});
    await page.close().catch(() => {});

    if (summary && (summary.vessel || summary.voyage)) {
      return {
        found: true,
        blNumber: summary.bl || ref,
        searchCode: ref,
        containerNo: '',
        type: '',
        origin: '',
        destination: '',
        vessel: summary.vessel || '',
        voyage: summary.voyage || '',
        eta: '',
        status: summary.onboardDate ? 'Onboard ' + summary.onboardDate : 'Booked',
        lastUpdated: new Date().toISOString(),
        notes:
          'Onboard ' + (summary.onboardDate || '-') + ' | Voyage ' + (summary.voyage || '-'),
        trackUrl: QUERY_PAGE,
        carrier: 'WANHAI',
        raw: summary,
      };
    }
    return notFound(ref);
  } catch (err) {
    try { if (listPage) await listPage.close(); } catch (e) {}
    await page.close().catch(() => {});
    return errored(ref, err.message);
  }
}

function notFound(ref) {
  return { found:false, blNumber:ref, searchCode:ref, containerNo:'Pending', type:'',
    origin:'', destination:'', vessel:'', voyage:'', eta:'', status:'Pending',
    lastUpdated:new Date().toISOString(), notes:'No Wan Hai data found',
    trackUrl:QUERY_PAGE, carrier:'WANHAI', raw:null };
}
function errored(ref, msg) {
  return { found:false, blNumber:ref, searchCode:ref, containerNo:'Pending', type:'',
    origin:'', destination:'', vessel:'', voyage:'', eta:'', status:'Error',
    lastUpdated:new Date().toISOString(), notes:'WANHAI scrape error: ' + msg,
    trackUrl:QUERY_PAGE, carrier:'WANHAI', raw:null };
}

module.exports = { scrapeWanHai };

/* STANDALONE RUNNER
 * Reads the monitor sheet, scrapes all Carrier="WANHAI" rows, writes results back.
 * Reuses GOOGLE_SHEET_ID, GOOGLE_CREDS. Optional WHL_SHEET_TAB.
 * Columns A-N, 1 header row.
 */

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
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A1:N`,
  });
  const rows = res.data.values || [];
  if (rows.length < 2) {
    console.log('[WHL] No data rows found.');
    return;
  }

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
      updates.push({
        range: `${SHEET_TAB}!A${t.rowNumber}:N${t.rowNumber}`,
        values: [[
          rec.blNumber, rec.searchCode, rec.containerNo, rec.type, rec.origin,
          rec.destination, rec.vessel, rec.voyage, rec.eta, rec.status,
          rec.lastUpdated, rec.notes, rec.trackUrl, CARRIER_TAG,
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

if (require.main === module) {
  runWanHaiScraper().catch((e) => {
    console.error('[WHL] Fatal:', e);
    process.exit(1);
  });
}

module.exports.runWanHaiScraper = runWanHaiScraper;
