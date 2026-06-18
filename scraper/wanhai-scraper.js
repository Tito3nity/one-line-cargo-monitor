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
  let popup2 = null;   // detail-page popup opened by the formbookingSubmit postback
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

    // ── IN-FRAME DETAIL POSTBACK ───────────────────────────────────────────
    // The LIST page contains the JSF command links (autoLink_ / "B/L Data" =
    // formblSubmit) that load the detail page. Clicking them opens a popup whose
    // redirect shell we can't render headless. Instead, replay the postback IN
    // THIS FRAME: force the cargoTrackV2Bean form to target=_self so the JSF
    // POST navigates the list page itself to the detail result (ViewState +
    // session intact, no popup, no cold GET). Then parse the detail in-place.
    if (!rec.containerNo || !rec.eta || !rec.destination) {
      try {
        // Probe what command links exist on the list page (id + onclick), so we
        // target the right one and can see the JSF call shape.
        const probe = await target.evaluate(() => {
          const clean = s => (s || '').replace(/\s+/g, ' ').trim();
          const links = [...document.querySelectorAll('a')].map(a => ({
            id: a.id || '', txt: clean(a.textContent).slice(0, 20),
            oc: (a.getAttribute('onclick') || '').slice(0, 400),
          })).filter(l => /autoLink_|formblSubmit|formbookingSubmit|B\/?L\s*Data|Booking\s*Data/i.test(l.id + l.txt + l.oc));
          const form = document.getElementById('cargoTrackV2Bean') || document.querySelector('form');
          return { links: links.slice(0, 8), hasForm: !!form,
                   formAction: form ? (form.getAttribute('action') || '') : '' };
        }).catch(e => ({ err: e.message }));
        console.log('[WHL]   DETAILLINKS: ' + JSON.stringify(probe).slice(0, 800));

        // Fire the B/L Data postback in-frame via NATIVE form submit. mojarra's
        // jsfcljs() just (1) adds a hidden input named after the command link's
        // source id, (2) sets target, (3) submits the form. A synthetic onclick
        // runs jsfcljs but the submit doesn't navigate in headless — so we do
        // mojarra's job ourselves: parse the source param from the onclick and
        // submit cargoTrackV2Bean natively (which always navigates).
        const fired = await target.evaluate(() => {
          const form = document.getElementById('cargoTrackV2Bean') || document.querySelector('form');
          if (!form) return { ok: false, reason: 'no form' };
          const a = [...document.querySelectorAll('a')]
            .find(x => /formblSubmit|B\/?L\s*Data/i.test((x.getAttribute('onclick') || '') + ' ' + (x.textContent || '')));
          if (!a) return { ok: false, reason: 'no B/L Data link' };
          const oc = a.getAttribute('onclick') || '';

          // Extract the mojarra source param: jsfcljs(form, {'SRC':'SRC'}, '') or
          // jsfcljs(form, 'SRC', ''). Grab the JSF client id (e.g. j_idt29:0:j_id..).
          let src = '';
          let m = oc.match(/jsfcljs\([^,]+,\s*\{?\s*'([^']+)'/);
          if (m) src = m[1];
          if (!src) { m = oc.match(/'(j_idt\d+:[^']+)'/); if (m) src = m[1]; }

          form.setAttribute('target', '_self');
          form.target = '_self';

          // Add the hidden source input mojarra would add, then native-submit.
          if (src) {
            let inp = form.querySelector(`input[name="${src.replace(/"/g, '\\"')}"]`);
            if (!inp) {
              inp = document.createElement('input');
              inp.type = 'hidden'; inp.name = src; inp.value = src;
              form.appendChild(inp);
            }
          }
          try {
            if (form.requestSubmit) form.requestSubmit(); else form.submit();
            return { ok: true, src, action: form.getAttribute('action') || '' };
          } catch (e) {
            return { ok: false, reason: 'submit threw: ' + String(e).slice(0, 80), src };
          }
        }).catch(e => ({ ok: false, reason: e.message }));
        console.log('[WHL]   DETAILFIRE: ' + JSON.stringify(fired).slice(0, 300));

        if (fired.ok) {
          // Wait for the in-frame navigation OR in-place content swap to detail.
          await target.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
          await target.waitForFunction(
            () => /ctnr no|place of receipt|port of discharg|estimated|laden|container no/i
                    .test(document.body?.innerText || ''),
            { timeout: 20000, polling: 500 }
          ).catch(() => {});
          await new Promise(r => setTimeout(r, 2000));

          const durl = target.url();
          const dtables = await target.evaluate(() => document.querySelectorAll('table').length).catch(() => 0);
          console.log(`[WHL]   DETAIL after fire: url=${durl.split('/').pop()} tables=${dtables}`);

          if (!ERROR_PAGE_RE.test(durl)) {
            const detailTables = await readTables(target);
            const detail = parseFromTables(detailTables, ref);
            console.log(`[WHL]   DETAIL parsed: ctnr="${detail.containerNo}" type="${detail.type}" ` +
                        `dest="${detail.destination}" eta="${detail.eta}"`);
            rec.containerNo = rec.containerNo || detail.containerNo;
            rec.type        = rec.type        || detail.type;
            rec.origin      = rec.origin      || detail.origin;
            rec.destination = rec.destination || detail.destination;
            rec.eta         = rec.eta         || detail.eta;
            rec.etd         = rec.etd         || detail.etd;
            if (detail.status && /transit|discharg|arriv|deliver|load|gate|empty|full/i.test(detail.status))
              rec.status = detail.status;
          }
        }
      } catch (e) {
        console.log(`[WHL]   DETAIL postback EXC: ${e.message}`);
      }
    }

    return rec;
  } finally {
    if (popup2) await popup2.close().catch(() => {});
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

    // KEY INSIGHT: the redirect shell forwards via client-side JS. A popup loses
    // window.opener (so its forward dies), and fetch() can't run JS at all — but
    // a MAIN-FRAME page.goto() executes the shell's JS with the opener/referer
    // intact, exactly like a real browser. So navigate the main page here and
    // then WAIT FOR THE FORWARD to carry us off *_redirect.xhtml onto the real
    // detail page, instead of bailing on the still-loading shell.
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    if (ERROR_PAGE_RE.test(page.url())) throw new Error('deep link bounced to error page');

    // Wait for the client-side forward to leave the redirect shell. The shell
    // may use meta-refresh, location=, or a JSF/JS forward — all of which run
    // during a real navigation. Give it a generous budget.
    await page.waitForFunction(
      () => !/_redirect\.xhtml/i.test(location.href),
      { timeout: 25000, polling: 400 }
    ).catch(() => {});

    // If the shell didn't auto-forward, try nudging it: some WHL shells expose a
    // doSubmit()/forward() or a body onload that needs a tick, and a reload of
    // the shell (now that the session/referer is set) often forwards on the 2nd
    // load. Reload once if we're still on the shell.
    if (/_redirect\.xhtml/i.test(page.url())) {
      console.log('[WHL]   deeplink: still on shell, reloading once');
      await page.reload({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {});
      await page.waitForFunction(
        () => !/_redirect\.xhtml/i.test(location.href) ||
              document.querySelectorAll('table').length > 0,
        { timeout: 20000, polling: 400 }
      ).catch(() => {});
    }

    // Now wait for the real detail content (tables with container/port/ETA text).
    await page.waitForFunction(
      () => document.querySelectorAll('table').length > 0 &&
            /ctnr no|place of receipt|port of discharg|estimated|laden|container|vessel/i
              .test(document.body.innerText || ''),
      { timeout: 20000, polling: 500 }
    ).catch(() => {});

    const preUrl = page.url();
    const tblCount = await page.evaluate(() => document.querySelectorAll('table').length).catch(() => 0);
    console.log(`[WHL]   deeplink: pre-forward=${preUrl.split('/').pop()} tables=${tblCount} ` +
                `shell=${/_redirect\.xhtml/i.test(preUrl)}`);

    // If we're still stuck on the shell, dump its forward logic so we can see
    // EXACTLY what gates the redirect (it's a small page). Look at inline
    // scripts mentioning location/submit/forward, any forms + their action, and
    // body onload — the shell's redirect condition lives in one of these.
    if (/_redirect\.xhtml/i.test(preUrl)) {
      const probe = await page.evaluate(() => {
        const pick = [];
        for (const s of document.querySelectorAll('script')) {
          const t = s.textContent || '';
          if (/location|submit|forward|window\.open|href|ref_no|setTimeout|onload|autoLink|click/i.test(t)) {
            pick.push(t.replace(/\s+/g, ' ').trim().slice(0, 1200));
          }
        }
        const forms = [...document.querySelectorAll('form')].map(f => ({
          id: f.id, name: f.name, action: f.getAttribute('action') || '',
          method: f.getAttribute('method') || '',
          inputs: [...f.querySelectorAll('input')].map(i => `${i.name || i.id}=${(i.value||'').slice(0,30)}`)
        }));
        return {
          bodyOnload: document.body ? (document.body.getAttribute('onload') || '') : '',
          scripts: pick.slice(0, 4),
          forms,
          iframes: [...document.querySelectorAll('iframe')].map(f => f.src || f.id || '(inline)'),
          tableDump: [...document.querySelectorAll('table')].slice(0, 4).map((tbl, ti) => {
            const rows = [...tbl.querySelectorAll('tr')].slice(0, 10).map(tr =>
              [...tr.querySelectorAll('td,th')].map(td => (td.textContent||'').replace(/\s+/g,' ').trim())
                .filter(Boolean).join(' | ')).filter(Boolean);
            return `T${ti}: ` + rows.slice(0, 8).join('  /  ').slice(0, 350);
          }),
          bodyText: (document.body ? document.body.innerText : '').replace(/\s+/g,' ').slice(0, 200),
        };
      }).catch(e => ({ err: e.message }));
      console.log('[WHL]   SHELLJS: ' + JSON.stringify(probe).slice(0, 1900));
    }

    // THE SHELL'S OWN FORWARD MECHANISM (from SHELLJS dump): window.onload
    // finds elements whose id contains "autoLink_", matches one to ref_no, and
    // clicks it to forward to the detail page. On a cold GET these autoLinks
    // may render a beat late (JSF), so: wait for them, then drive the forward
    // ourselves (re-running the same logic the onload would), and click the
    // matching link. This is doing exactly what the page does.
    await page.waitForFunction(
      () => document.querySelectorAll('[id*="autoLink_"]').length > 0,
      { timeout: 8000, polling: 300 }
    ).catch(() => {});
    const autoFwd = await page.evaluate((refNo) => {
      const out = { autoLinks: [], clicked: false, matched: '' };
      const links = [...document.querySelectorAll('[id*="autoLink_"]')];
      out.autoLinks = links.slice(0, 8).map(a =>
        `${a.id}|ref=${a.getAttribute('data-ref_no')||a.getAttribute('ref_no')||''}|oc=${(a.getAttribute('onclick')||'').slice(0,40)}|txt=${(a.textContent||'').trim().slice(0,20)}`);
      let target = links.find(a =>
        (a.getAttribute('data-ref_no') || a.getAttribute('ref_no') || a.textContent || a.getAttribute('onclick') || '')
          .toUpperCase().includes(refNo.toUpperCase()));
      if (!target && links.length === 1) target = links[0];
      if (target) {
        out.matched = target.id;
        target.removeAttribute('target');
        target.click();
        out.clicked = true;
      } else if (typeof window.onload === 'function') {
        try { window.onload(); out.ranOnload = true; } catch (e) { out.onloadErr = String(e).slice(0,60); }
      }
      return out;
    }, ref).catch(e => ({ err: e.message }));
    console.log('[WHL]   AUTOFWD: ' + JSON.stringify(autoFwd).slice(0, 600));

    // After firing the forward, wait for the detail content (new tables / fields).
    if (autoFwd.clicked || autoFwd.ranOnload) {
      await page.waitForFunction(
        () => document.querySelectorAll('table').length > 1 ||
              /ctnr no|place of receipt|port of discharg|estimated|laden/i.test(document.body?.innerText || ''),
        { timeout: 20000, polling: 500 }
      ).catch(() => {});
      await new Promise(r => setTimeout(r, 2500));
      console.log(`[WHL]   AUTOFWD after: url=${page.url().split('/').pop()} ` +
                  `tables=${await page.evaluate(()=>document.querySelectorAll('table').length).catch(()=>0)}`);
    }

    const finalUrl = page.url();
    if (ERROR_PAGE_RE.test(finalUrl)) throw new Error('deep link bounced to error page');

    // Data may now be in the main frame OR an iframe the forward opened.
    let parseTarget = page;
    for (const fr of page.frames()) {
      if (fr === page.mainFrame()) continue;
      const hasData = await fr.evaluate(
        () => /ctnr no|place of receipt|port of discharg|container|vessel|onboard/i.test(document.body?.innerText || '')
      ).catch(() => false);
      if (hasData) {
        console.log(`[WHL]   deeplink: data found in iframe -> ${(fr.url()||'').split('/').pop()}`);
        parseTarget = fr;
        break;
      }
    }

    const tables = await readTables(parseTarget);
    if (!hasResult(tables, ref)) throw new Error('deep link: tables present but no recognizable result rows (see SHELLJS/AUTOFWD dump)');

    const rec = parseFromTables(tables, ref);
    rec.sourceUrl = finalUrl;
    return rec;
  } finally {
    await page.close().catch(() => {});
  }
}

/* ─────────────────────────── public scrape ───────────────────────── */

async function scrapeWanHai(browser, bl) {
  const ref = String(bl).trim().toUpperCase();

  // ── PRIMARY: extract everything from Wan Hai's own page ────────────────────
  // Two complementary page paths, merged for the most complete record:
  //   • attemptForm     — reliably yields the list view (vessel/voyage/status).
  //   • attemptDeepLink — navigates the MAIN frame to the redirect URL and lets
  //     the shell's JS forward fire (opener/referer intact), reaching the full
  //     detail page (container No / type / ports / ETA).
  // We run both (deep link first, since it carries the detail fields) and merge.
  let merged = null;
  let lastErr = '';

  const runAttempt = async (fn, label) => {
    for (let tries = 0; tries < 2; tries++) {
      try {
        const r = await fn(browser, ref);
        if (r && (r.vessel || r.voyage || r.containerNo || r.eta)) return r;
        lastErr = label + ': empty result';
      } catch (e) {
        lastErr = label + ': ' + e.message;
        console.log(`[WHL]   ${label} failed: ${e.message}`);
      }
      await new Promise((res) => setTimeout(res, 1500));
    }
    return null;
  };

  // Deep link first — it's the one that can reach container/ETA.
  const deep = await runAttempt(attemptDeepLink, 'deeplink');
  if (deep) merged = { ...deep };

  // Run the form flow if we still lack the list-view basics or detail fields.
  const needBasics = !merged || !merged.vessel || !merged.voyage;
  if (needBasics) {
    const form = await runAttempt(attemptForm, 'form');
    if (form) {
      // Merge: keep any field already populated; fill blanks from the other path.
      merged = {
        ...(form || {}),
        ...Object.fromEntries(Object.entries(merged || {}).filter(([, v]) => v)),
      };
      // Ensure detail fields from deep link aren't lost if form had blanks.
      if (deep) for (const k of ['containerNo', 'type', 'origin', 'destination', 'eta', 'etd']) {
        if (!merged[k] && deep[k]) merged[k] = deep[k];
      }
    }
  }

  if (merged && (merged.vessel || merged.voyage || merged.containerNo || merged.eta)) {
    return shape(ref, merged, true);
  }

  // ── LAST RESORT: SeaRates API (only if a key is configured) ───────────────
  try {
    const { fetchWanHaiFromApi } = require('./wanhai-api');
    const api = await fetchWanHaiFromApi(ref, { forceUpdate: false });
    if (api && (api.containerNo || api.eta || api.vessel)) {
      console.log(`[WHL] ${ref} -> page failed; SeaRates fallback OK`);
      return api;
    }
  } catch (e) {
    console.log(`[WHL] SeaRates fallback also failed: ${e.message}`);
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
