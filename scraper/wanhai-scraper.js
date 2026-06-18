// scraper/wanhai-scraper.js  — REBUILT v2.0
//
// Wan Hai Lines (WHL) cargo scraper — Puppeteer-driven, session-resilient.
//
// THE PROBLEM THIS SOLVES
// -----------------------
// Wan Hai's cargo tracking is a stateful JSF/PrimeFaces app. Each request needs
// a live server session (JSESSIONID + javax.faces.ViewState). When that session
// expires or a "deep link" is opened cold, the site bounces you to a static
// error page (…/views/quick/cargo_tracking.html) that says roughly
//   "Sorry, the webpage you accessed got problem".
// A plain server-side fetch() cannot reliably hold that session, which is why
// the Render /api/wanhai route kept failing. A real browser (Puppeteer) DOES
// hold the session, so we always (re)establish a fresh session from the search
// FORM page (…/views/quick/cargo_tracking.xhtml) — never from a cold deep link.
//
// FLOW (each implemented as an independent attempt; we try them in order):
//   A) FORM flow  — load cargo_tracking.xhtml, pick "BL no.", type the BL,
//                   submit, read the result table (handles the result opening
//                   in the same page OR a new popup tab).
//   B) DEEP-LINK  — tracking_data_page_by_bl_redirect.xhtml?ref_no=..&ref_type=MFT
//                   but ONLY after we have first visited the form page in the
//                   same browser context, so a session cookie already exists.
//
// If a redirect to *cargo_tracking.html* (the error page) is detected, that
// attempt is treated as a failure and we fall through / retry, so the dashboard
// keeps the previous good data instead of being overwritten with garbage.
//
// Sheet mapping ("ONE Line Daily Monitor", header row 1, data from row 2):
//   A BL | B SearchCode | C ContainerNo | D Type | E Origin | F Destination
//   G Vessel | H Voyage | I ETA | J Status | K LastUpdated | L Notes
//   M TrackURL | N Carrier
// This scraper ONLY touches rows whose column N == "WANHAI". It never writes
// to ONE rows and never changes the Carrier tag of a row it didn't own.

const QUICK_BASE   = 'https://www.wanhai.com/views/quick';
const V2_BASE      = 'https://www.wanhai.com/views/cargo_track_v2';
const FORM_PAGE    = QUICK_BASE + '/cargo_tracking.xhtml';      // the live search form
const ERROR_PAGE_RE = /cargo_tracking\.html(\b|$)/i;            // the "got problem" bounce
const REDIRECT_EP  = V2_BASE + '/tracking_data_page_by_bl_redirect.xhtml';
const NAV_TIMEOUT  = 45000;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ───────────────────────── parsing helpers ───────────────────────── */

// Pull a clean structured record out of whatever result HTML we land on.
// Works for both the "list" view and the full "detail" view because we just
// scan every tbl-list table for labelled cells + a container block.
function parseFromTables(rowsByTable, ref) {
  const flat = [];
  for (const rows of rowsByTable) for (const r of rows) flat.push(r);

  const findVal = (labelRe) => {
    for (const row of flat) {
      for (let i = 0; i < row.length - 1; i++) {
        if (labelRe.test(row[i])) {
          const v = (row[i + 1] || '').trim();
          if (v && v !== '---') return v;
        }
      }
    }
    return '';
  };

  // LIST-VIEW (columnar) reader: the "Tracking Information List" has a header
  // row [BL no. | Oboard Date | Voyage | Vessel Name | More detail] and a data
  // row below it. VERIFIED LIVE for 025G657555 -> 2026/06/01 | S015 | GSL MAMITSA.
  // findVal (label-then-adjacent-cell) can't read this, so handle it explicitly.
  const fromList = { bl: '', onboard: '', voyage: '', vessel: '' };
  for (const rows of rowsByTable) {
    const hi = rows.findIndex((r) =>
      r.some((c) => /vessel name/i.test(c)) && r.some((c) => /voyage/i.test(c)));
    if (hi === -1) continue;
    const header = rows[hi];
    const col = (re) => header.findIndex((h) => re.test(h));
    const iBl = col(/BL no/i), iOb = col(/board date/i),
          iVoy = col(/voyage/i), iVes = col(/vessel name/i);
    for (let r = hi + 1; r < rows.length; r++) {
      const row = rows[r];
      const blCell = iBl >= 0 ? (row[iBl] || '') : '';
      if (blCell && blCell.toUpperCase().includes(ref.toUpperCase())) {
        fromList.bl      = blCell.trim();
        fromList.onboard = iOb  >= 0 ? (row[iOb]  || '').trim() : '';
        fromList.voyage  = iVoy >= 0 ? (row[iVoy] || '').trim() : '';
        fromList.vessel  = iVes >= 0 ? (row[iVes] || '').trim() : '';
        break;
      }
    }
    if (fromList.vessel || fromList.voyage) break;
  }

  const rec = {
    blNumber:    fromList.bl     || findVal(/^BL no\.?$/i) || ref,
    vessel:      fromList.vessel || findVal(/Vessel Name/i),
    voyage:      fromList.voyage || findVal(/^Voyage$/i),
    onboardDate: fromList.onboard|| findVal(/board Date|Oboard Date/i),
    origin:      '',
    destination: '',
    eta:         '',
    etd:         '',
    containerNo: '',
    type:        '',
    status:      '',
  };

  // Location / date rows: "Place of Receipt | LOC | ... | DATE"
  for (const row of flat) {
    const head = (row[0] || '').toLowerCase();
    const loc  = (row[1] || '').trim();
    const date = (row[row.length - 1] || '').trim();
    if (head.startsWith('place of receipt') || head.startsWith('port of loading')) {
      if (!rec.origin && loc && loc !== '---') rec.origin = loc;
      if (/depart/i.test(row.join(' ')) && date) rec.etd = date;
    } else if (head.startsWith('port of discharg') || head.startsWith('place of delivery')) {
      if (loc && loc !== '---') rec.destination = loc;
      if (/arriv/i.test(row.join(' ')) && date) rec.eta = date;
    }
  }

  // Container block: a header row containing "Ctnr No." + "Current Status",
  // then data rows where col[0] is an index and col[1] looks like a container.
  let inCtnr = false;
  const containers = [];
  for (const row of flat) {
    const joined = row.join(' ').toLowerCase();
    if (joined.includes('ctnr no') && joined.includes('current status')) { inCtnr = true; continue; }
    if (inCtnr && /^[A-Z]{4}\d{6,7}$/.test((row[1] || '').trim())) {
      containers.push({
        containerNo: row[1].trim(),
        typeSize:    (row[2] || '').trim(),
        status:      (row[7] || row[row.length - 2] || '').trim(),
        statusDate:  (row[8] || row[row.length - 1] || '').trim(),
      });
    }
  }
  if (containers.length) {
    rec.containerNo = containers.map(c => c.containerNo).join(', ');
    rec.type        = containers.map(c => c.typeSize).filter(Boolean).join(', ');
    rec.status      = containers[0].status || '';
  }

  // Status fallback derived from milestones.
  if (!rec.status) {
    if (rec.eta && /\d/.test(rec.eta))      rec.status = 'In Transit';
    else if (rec.onboardDate)               rec.status = 'Onboard ' + rec.onboardDate;
    else                                    rec.status = 'Booked';
  }
  return rec;
}

// Read tables on the page. Prefer table.tbl-list (detail view) but fall back to
// ALL tables, because the "Tracking Information List" result is a plain <table>
// (VERIFIED LIVE) with header row BL/Oboard Date/Voyage/Vessel Name/More detail.
async function readTables(target) {
  return target.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const grab = (sel) => {
      const out = [];
      for (const tbl of document.querySelectorAll(sel)) {
        const rows = [...tbl.querySelectorAll('tr')].map((tr) =>
          [...tr.querySelectorAll('td,th')].map((td) => clean(td.innerText))
        );
        if (rows.some((r) => r.some((c) => c.length))) out.push(rows);
      }
      return out;
    };
    const listed = grab('table.tbl-list');
    return listed.length ? listed : grab('table');
  });
}

function hasResult(rowsByTable, ref) {
  for (const rows of rowsByTable)
    for (const r of rows)
      if (r.some((c) => (c || '').toUpperCase().includes(ref))) return true;
  // Even without the BL echoed, a populated tbl-list with a vessel/voyage header counts.
  return rowsByTable.some((rows) =>
    rows.some((r) => /vessel name|voyage|ctnr no/i.test(r.join(' ')))
  );
}

/* ─────────────────────── attempt A: the FORM flow ─────────────────── */

async function attemptForm(browser, ref) {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  await page.setUserAgent(UA);
  let popup = null;
  try {
    await page.goto(FORM_PAGE, { waitUntil: 'domcontentloaded' });

    // Detect the bounce-to-error page right away.
    if (ERROR_PAGE_RE.test(page.url())) throw new Error('bounced to error page on form load');

    // Wait for the BL input. The quick form uses #q_ref_no1 (kept stable across
    // the v2 / quick variants); fall back to any text input inside the form.
    await page.waitForSelector('#q_ref_no1, input[id*="ref_no"]', { timeout: 20000 });

    await page.evaluate((refNo) => {
      // Force the result to render IN THIS TAB. The live form is
      // method=post target=_blank; in headless Puppeteer catching that popup is
      // racy, but overriding target to _self makes the POST navigate this page
      // straight to the result (VERIFIED LIVE: resolves to
      // tracking_data_list.xhtml?file_num=...&top_file_num=...&parent_id=...).
      const form = document.querySelector('form');
      if (form) form.target = '_self';
      // Choose "BL no." in the cargo-type selector if present.
      const sel = document.getElementById('cargoType') ||
                  document.querySelector('select[id*="cargoType"]');
      if (sel) {
        const opt = [...sel.options].find((o) => /BL no/i.test(o.text));
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      }
      const inp = document.getElementById('q_ref_no1') ||
                  document.querySelector('input[id*="ref_no"]');
      if (inp) { inp.value = refNo; inp.dispatchEvent(new Event('input', { bubbles: true })); }
    }, ref);

    // Secondary safety net: if a popup still opens (target override didn't take),
    // capture it by polling browser.pages() for a tracking_data_list tab.
    const knownBefore = new Set(await browser.pages());

    // Submit and wait for the same-tab navigation to the result list page.
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
      page.evaluate(() => {
        const b = document.getElementById('quick_ctnr_query') ||
                  document.querySelector('[id*="query"],button[type="submit"],input[type="submit"]');
        if (b) b.click();
      }),
    ]);

    // Resolve the result target: this page if it navigated to a result URL,
    // otherwise a freshly-opened popup tab.
    let target = page;
    const isResult = (u) => /tracking_data_list\.xhtml|tracking_data_page_by_bl\.xhtml/i.test(u || '');
    if (!isResult(page.url())) {
      for (let i = 0; i < 20 && !isResult(target.url()); i++) {   // up to ~10s for a popup
        await new Promise((r) => setTimeout(r, 500));
        for (const p of await browser.pages()) {
          if (knownBefore.has(p)) continue;
          if (isResult(p.url())) { target = p; break; }
        }
      }
      if (target !== page) { popup = target; await target.bringToFront().catch(() => {}); }
    }

    if (ERROR_PAGE_RE.test(target.url())) throw new Error('result bounced to error page');

    // The list table renders quickly, but wait for actual content to be safe.
    await target
      .waitForFunction(
        () => document.querySelector('table') &&
              /vessel name|bl no\.|ctnr no/i.test(document.body.innerText),
        { timeout: 30000, polling: 500 }
      )
      .catch(() => {});

    if (ERROR_PAGE_RE.test(target.url())) throw new Error('result bounced to error page');

    const tables = await readTables(target);
    if (!hasResult(tables, ref)) throw new Error('no result table after form submit');

    const rec = parseFromTables(tables, ref);
    rec.sourceUrl = target.url();

    // ── DETAIL DRILL-DOWN ──────────────────────────────────────────────
    // The list view (tracking_data_list.xhtml) only carries BL / Onboard /
    // Voyage / Vessel + a "More detail" link. Container No., type, ports and
    // ETA live on the DETAIL page (tracking_data_page_by_bl.xhtml) behind that
    // link. If we don't yet have those, click through and merge them in.
    // VERIFIED LIVE: the list row's last cell is a "More detail" anchor that
    // navigates same-tab to tracking_data_page_by_bl.xhtml.
    const needsDetail = !rec.containerNo || !rec.eta || !rec.destination;
    if (needsDetail) {
      try {
        const beforeUrl = target.url();
        // Fingerprint current content so we can detect an in-place (ajax) change.
        const beforeFp = await target.evaluate(() =>
          (document.body.innerText || '').replace(/\s+/g, ' ').length);

        const clickInfo = await target.evaluate((refNo) => {
          const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toUpperCase();
          const info = { anchors: 0, strategy: '', href: '', onclickAttr: '', clicked: false };
          const allA = [...document.querySelectorAll('a')];
          info.anchors = allA.length;

          // PRIMARY: the detail trigger is a JSF anchor whose onclick calls
          // formbookingSubmit('<BL>', 'BKG'|'MFT'). VERIFIED FROM LIVE LOG.
          // Click THAT element directly so the JSF/mojarra handler fires its
          // ajax postback (it updates the page in place — same URL).
          let link = allA.find(a => /formbookingSubmit\s*\(/i.test(a.getAttribute('onclick') || ''));
          if (link) info.strategy = 'formbookingSubmit';

          // FALLBACK 1: explicit "More detail" text.
          if (!link) {
            link = allA.find(a => /more\s*detail/i.test(a.innerText));
            if (link) info.strategy = 'moreDetailText';
          }
          // FALLBACK 2: first anchor in the BL's row (last resort).
          if (!link) {
            for (const tr of document.querySelectorAll('tr')) {
              if (norm(tr.innerText).includes(refNo.toUpperCase())) {
                const a = tr.querySelector('a');
                if (a) { link = a; info.strategy = 'rowAnchor'; break; }
              }
            }
          }

          if (link) {
            info.href = link.getAttribute('href') || '';
            info.onclickAttr = (link.getAttribute('onclick') || '').slice(0, 140);
            link.removeAttribute('target');
            // Fire the native click so JSF's registered handler runs (calling
            // .onclick() directly can skip mojarra's event chain).
            link.click();
            info.clicked = true;
          }
          return info;
        }, ref);

        console.log(`[WHL]   detail: anchors=${clickInfo.anchors} strategy=${clickInfo.strategy} ` +
                    `clicked=${clickInfo.clicked} href="${clickInfo.href}" onclick="${clickInfo.onclickAttr}"`);

        if (clickInfo.clicked) {
          // This is a JSF ajax postback: the URL stays the same and the DOM is
          // swapped in place. So DON'T wait for navigation — wait for the
          // container/ETA content to APPEAR (or the body text to change size).
          await target
            .waitForFunction(
              (prevLen) => {
                const t = (document.body.innerText || '');
                const hasDetail = /ctnr no|place of receipt|port of discharg|estimated|laden|container no/i.test(t);
                const changed = Math.abs(t.replace(/\s+/g, ' ').length - prevLen) > 40;
                return hasDetail || changed;
              },
              { timeout: 25000, polling: 500 },
              beforeFp
            )
            .catch(() => {});
          // Give a JSF ajax repaint a moment to settle.
          await new Promise(r => setTimeout(r, 1500));

          const afterUrl = target.url();
          console.log(`[WHL]   detail: ${beforeUrl.split('/').pop()} -> ${afterUrl.split('/').pop()} ` +
                      `errorPage=${ERROR_PAGE_RE.test(afterUrl)}`);

          if (!ERROR_PAGE_RE.test(afterUrl)) {
            // ── STRUCTURAL PROBE (temporary): log how the detail content is laid
            // out so the parser can be fixed exactly. Safe to remove later.
            const probe = await target.evaluate(() => {
              const out = { tables: 0, divs: 0, uls: 0, dls: 0, ctnrCtx: [], labels: [] };
              out.tables = document.querySelectorAll('table').length;
              out.divs   = document.querySelectorAll('div').length;
              out.uls    = document.querySelectorAll('ul').length;
              out.dls    = document.querySelectorAll('dl').length;
              const body = document.body.innerText || '';
              for (const kw of ['Ctnr', 'Container', 'Estimated', 'Arrival', 'Discharge', 'Receipt', 'Laden', 'WHSU']) {
                const i = body.indexOf(kw);
                if (i >= 0) out.ctnrCtx.push(kw + ':«' + body.slice(i, i + 80).replace(/\s+/g, ' ') + '»');
              }
              const hint = [...document.querySelectorAll('[id*="ctnr"],[id*="container"],[class*="ctnr"],[class*="container"]')]
                .slice(0, 5).map(e => (e.tagName + '#' + (e.id || '') + '.' + (e.className || '')).slice(0, 60));
              out.hintEls = hint;
              return out;
            }).catch(e => ({ probeErr: e.message }));
            console.log('[WHL]   PROBE: ' + JSON.stringify(probe).slice(0, 900));

            const detailTables = await readTables(target);
            const detail = parseFromTables(detailTables, ref);
            console.log(`[WHL]   detail parsed: ctnr="${detail.containerNo}" type="${detail.type}" ` +
                        `dest="${detail.destination}" eta="${detail.eta}" tables=${detailTables.length}`);
            rec.containerNo = rec.containerNo || detail.containerNo;
            rec.type        = rec.type        || detail.type;
            rec.origin      = rec.origin      || detail.origin;
            rec.destination = rec.destination || detail.destination;
            rec.eta         = rec.eta         || detail.eta;
            rec.etd         = rec.etd         || detail.etd;
            if (detail.status && /transit|discharg|arriv|deliver|load|gate|empty|full/i.test(detail.status)) {
              rec.status = detail.status;
            }
            rec.sourceUrl = afterUrl;
            // Diagnostic breadcrumb that survives shape(): records what the detail
            // step yielded, so a blank result is explainable from the sheet alone.
            rec.detailDiag = `det:${detailTables.length}t/ctnr:${detail.containerNo?'y':'n'}/eta:${detail.eta?'y':'n'}`;
          } else {
            rec.detailDiag = 'det:errorpage';
          }
        } else {
          rec.detailDiag = `det:nolink/a${clickInfo.anchors}`;
        }
      } catch (e) {
        rec.detailErr = e.message;
        rec.detailDiag = 'det:exc:' + (e.message || '').slice(0, 40);
        console.log(`[WHL]   detail EXC: ${e.message}`);
      }
    }

    return rec;
  } finally {
    if (popup) await popup.close().catch(() => {});
    await page.close().catch(() => {});
  }
}

/* ──────── attempt B: deep link, but only after a session exists ───── */

async function attemptDeepLink(browser, ref) {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  await page.setUserAgent(UA);
  try {
    // Warm the session by visiting the form page first (sets JSESSIONID).
    await page.goto(FORM_PAGE, { waitUntil: 'domcontentloaded' }).catch(() => {});

    const url = REDIRECT_EP +
      '?ref_no=' + encodeURIComponent(ref) + '&ref_type=MFT';
    // LIVE-VERIFIED: this deep link frequently hangs on a "loading..." shell and
    // never resolves the tables. So we navigate with a short budget and then
    // give the tables a bounded chance to appear — if they don't, we bail fast
    // and let the (reliable) form flow have already done the job. This attempt
    // is a fallback only; it must never stall the whole run.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

    if (ERROR_PAGE_RE.test(page.url())) throw new Error('deep link bounced to error page');

    await page
      .waitForFunction(() => document.querySelector('table.tbl-list'),
        { timeout: 12000, polling: 500 })
      .catch(() => {});

    const tables = await readTables(page);
    if (!hasResult(tables, ref)) throw new Error('deep link still loading / no tables');

    const rec = parseFromTables(tables, ref);
    rec.sourceUrl = page.url();
    return rec;
  } finally {
    await page.close().catch(() => {});
  }
}

/* ─────────────────────────── public scrape ───────────────────────── */

async function scrapeWanHai(browser, bl) {
  const ref = String(bl).trim().toUpperCase();
  const attempts = [attemptForm, attemptDeepLink];
  let lastErr = '';

  for (const attempt of attempts) {
    for (let tries = 0; tries < 2; tries++) {   // one retry each (session may need a beat)
      try {
        const r = await attempt(browser, ref);
        if (r && (r.vessel || r.voyage || r.containerNo || r.eta)) {
          return shape(ref, r, true);
        }
        lastErr = 'empty result';
      } catch (e) {
        lastErr = e.message;
      }
      await new Promise((res) => setTimeout(res, 1500));
    }
  }
  return shape(ref, null, false, lastErr);
}

function shape(ref, r, found, err) {
  if (found && r) {
    const noteBits = [];
    if (r.onboardDate) noteBits.push('Onboard ' + r.onboardDate);
    if (r.voyage)      noteBits.push('Voyage ' + r.voyage);
    if (r.detailDiag)  noteBits.push(r.detailDiag);
    return {
      found: true,
      blNumber:    r.blNumber || ref,
      searchCode:  ref,
      containerNo: r.containerNo || '',
      type:        r.type || '',
      origin:      r.origin || '',
      destination: r.destination || '',
      vessel:      r.vessel || '',
      voyage:      r.voyage || '',
      eta:         r.eta || '',
      status:      r.status || 'In Transit',
      lastUpdated: new Date().toISOString(),
      notes:       noteBits.join(' | '),
      trackUrl:    FORM_PAGE,
      carrier:     'WANHAI',
    };
  }
  return {
    found: false,
    blNumber: ref, searchCode: ref, containerNo: '', type: '',
    origin: '', destination: '', vessel: '', voyage: '', eta: '',
    status: 'Pending',
    lastUpdated: new Date().toISOString(),
    notes: 'No Wan Hai data this run (' + (err || 'unknown') + ')',
    trackUrl: FORM_PAGE, carrier: 'WANHAI',
  };
}

module.exports = { scrapeWanHai };

/* ═══════════════════════════ STANDALONE RUNNER ════════════════════════════
 * Reads the monitor sheet, scrapes every Carrier="WANHAI" row, writes results
 * back to A:N for that row only. Never touches ONE rows.
 *
 * KEY SAFETY RULE: if a scrape fails (found=false), we DO NOT overwrite the
 * existing live columns (C–J) — we only refresh the timestamp + note. This is
 * what stops a transient Wan Hai outage from blanking good data, and it is the
 * counterpart to the N3-revert guard now in Code.gs.
 */

const SHEET_TAB = process.env.WHL_SHEET_TAB || 'ONE Line Daily Monitor';
const CARRIER_TAG = 'WANHAI';

async function getSheetsClient() {
  const { google } = require('googleapis');
  // GOOGLE_CREDS may be raw JSON or base64-encoded JSON. Match the working ONE
  // Line scraper exactly: if it starts with "{" treat it as raw, otherwise
  // base64-decode first. (The repo's secret is base64-encoded.)
  const raw = process.env.GOOGLE_CREDS || '';
  let creds;
  try {
    creds = JSON.parse(raw.trim().startsWith('{')
      ? raw
      : Buffer.from(raw, 'base64').toString('utf-8'));
  } catch (e) {
    throw new Error('GOOGLE_CREDS is missing or not valid JSON/base64: ' + e.message);
  }
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

async function runWanHaiScraper() {
  const puppeteer = require('puppeteer');
  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  if (!SHEET_ID || !process.env.GOOGLE_CREDS)
    throw new Error('Missing GOOGLE_SHEET_ID or GOOGLE_CREDS env var');

  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A1:N`,
  });
  const rows = res.data.values || [];
  if (rows.length < 2) { console.log('[WHL] No data rows.'); return; }

  const targets = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const carrier = (row[13] || '').toString().trim().toUpperCase();
    const bl = (row[0] || '').toString().trim();
    if (carrier === CARRIER_TAG && bl) targets.push({ rowNumber: i + 1, bl, prev: row });
  }
  if (!targets.length) { console.log(`[WHL] No "${CARRIER_TAG}" rows.`); return; }
  console.log(`[WHL] Scraping ${targets.length} BL(s): ${targets.map(t => t.bl).join(', ')}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const updates = [];
  try {
    for (const t of targets) {
      const rec = await scrapeWanHai(browser, t.bl);
      console.log(`[WHL] ${t.bl} -> ${rec.found ? 'OK' : 'KEEP-PREV'} | ${rec.vessel || '-'} | ${rec.status}`);

      const p = t.prev; // existing row, so we can preserve on failure
      const merged = rec.found ? rec : {
        blNumber:    t.bl,
        searchCode:  p[1] || t.bl,
        containerNo: p[2] || '',
        type:        p[3] || '',
        origin:      p[4] || '',
        destination: p[5] || '',
        vessel:      p[6] || '',
        voyage:      p[7] || '',
        eta:         p[8] || '',
        status:      p[9] || 'Pending',
        lastUpdated: new Date().toISOString(),
        notes:       rec.notes,           // record why this run found nothing
        trackUrl:    p[12] || FORM_PAGE,
      };

      updates.push({
        range: `${SHEET_TAB}!A${t.rowNumber}:N${t.rowNumber}`,
        values: [[
          merged.blNumber, merged.searchCode, merged.containerNo, merged.type,
          merged.origin, merged.destination, merged.vessel, merged.voyage,
          merged.eta, merged.status, merged.lastUpdated, merged.notes,
          merged.trackUrl, CARRIER_TAG,            // column N always re-asserted WANHAI
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
  runWanHaiScraper().catch((e) => { console.error('[WHL] Fatal:', e); process.exit(1); });
}

module.exports.runWanHaiScraper = runWanHaiScraper;
