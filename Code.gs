// ============================================================
// MULTI-CARRIER CARGO TRACKER — Google Apps Script Backend v6.0
// (ONE Line live + Wan Hai via GitHub Actions scraper)
//
// WHAT CHANGED FROM v3.1 (and why the N3 / carrier bug existed)
// ------------------------------------------------------------
// v3.1 knew nothing about carriers. It used 13 columns (A–M) and its
// refreshAllBLs() / scheduledRefresh() looped over EVERY row and called the
// ONE Line API on it. For a Wan Hai row that meant:
//   • ONE Line returned nothing  → the row got blanked back to "Pending"
//   • writeToSheet rewrote A–M only → if the deployed copy ever added an N
//     write, or re-ordered, the Carrier tag in column N reverted ONE↔WANHAI.
// This version is carrier-aware end to end:
//   • 14 columns A–N (N = Carrier).
//   • refreshAllBLs() SKIPS any row whose carrier is WANHAI — those rows are
//     owned by the GitHub Actions Puppeteer scraper, never by Apps Script.
//   • writeToSheet() preserves the existing Carrier in column N and never
//     downgrades a WANHAI row to ONE.
//   • scheduledRefresh() is the trigger entry point and shares the same guard,
//     so the time-driven trigger can no longer revert N3.
// ============================================================

const SPREADSHEET_ID    = '1e1smHhHSIZ89xltCWhDuK-tQI0LqQN7a0tPSxyLeZzs';
const SHEET_GID         = 120157833;
const SHEET_NAME_FALLBACK = 'ONE Line Daily Monitor';

const ONE_BASE = 'https://ecomm.one-line.com';

const STATUS_MAP = {
  'Empty Container Release to Shipper'                                          : 'Released',
  'Gate In to Outbound Terminal'                                               : 'Gate In (Pre-load)',
  'Loaded on Vessel at Port of Loading'                                        : 'In Transit',
  'Vessel Departure from Port of Loading'                                      : 'In Transit (Departed)',
  'Vessel Arrival at Port of Discharge'                                        : 'Arrived',
  'Unloaded from Vessel at Port of Discharging'                                : 'Arrived (Unloading)',
  'Gate Out from Inbound Terminal for Delivery to Consignee (or Port Shuttle)' : 'Delivered',
  'Empty Container Returned from Customer'                                     : 'Completed ✓'
};

// Column index constants (0-based) for the 14-column layout.
const COL = {
  BL:0, SEARCH:1, CONTAINER:2, TYPE:3, ORIGIN:4, DEST:5, VESSEL:6,
  VOYAGE:7, ETA:8, STATUS:9, UPDATED:10, NOTES:11, TRACKURL:12, CARRIER:13
};
const NUM_COLS = 14;

// ────────────────────────────────────────────────────────────
// ROUTER
// ────────────────────────────────────────────────────────────
function doGet(e) {
  const action = (e.parameter.action || 'list').toLowerCase();
  let result;
  try {
    switch (action) {
      case 'track':
        result = trackSingleBL((e.parameter.bl || '').trim(), (e.parameter.notes || '').trim());
        break;
      case 'writerecord':           // dashboard pushes a fully-formed record (any carrier)
        result = writeRecordFromParams(e.parameter);
        break;
      case 'list':
        result = getSheetData();
        break;
      case 'refreshall':
        result = refreshAllBLs();
        break;
      case 'delete':
        result = deleteFromSheet((e.parameter.bl || '').trim());
        break;
      default:
        result = { error: 'Unknown action: ' + action };
    }
  } catch (err) {
    result = { error: err.message };
    Logger.log('doGet error [' + action + ']: ' + err.message);
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ────────────────────────────────────────────────────────────
// TRACK SINGLE BL (ONE Line only — Wan Hai never reaches here)
// ────────────────────────────────────────────────────────────
function trackSingleBL(blNumber, notes) {
  if (!blNumber) throw new Error('BL number is required');
  const cleanBL  = blNumber.replace(/^ONEY/i, '').trim().toUpperCase();
  const trackUrl = ONE_BASE + '/one-ecom/manage-shipment/cargo-tracking?trakNoParam=' + cleanBL + '&trakNoTpCdParam=B';
  const live     = fetchONELineData(cleanBL);
  const record = {
    blNumber:    blNumber.toUpperCase(),
    searchCode:  cleanBL,
    containerNo: live.containerNo || '',
    type:        live.type || '',
    origin:      live.origin || '',
    destination: live.destination || '',
    vessel:      live.vessel || '',
    voyage:      live.voyage || '',
    eta:         live.eta || '',
    status:      live.status || 'Pending',
    lastUpdated: new Date().toISOString(),
    notes:       notes,
    trackUrl:    trackUrl,
    carrier:     'ONE'
  };
  writeToSheet(record);
  return record;
}

// Generic writer the dashboard calls (carries its own carrier tag).
function writeRecordFromParams(p) {
  const rec = {
    blNumber:    (p.blNumber || '').toUpperCase(),
    searchCode:  p.searchCode || p.blNumber || '',
    containerNo: p.containerNo || '',
    type:        p.type || '',
    origin:      p.origin || '',
    destination: p.destination || '',
    vessel:      p.vessel || '',
    voyage:      p.voyage || '',
    eta:         p.eta || '',
    status:      p.status || 'Pending',
    lastUpdated: new Date().toISOString(),
    notes:       p.notes || '',
    trackUrl:    p.trackUrl || '',
    carrier:     (p.carrier || 'ONE').toUpperCase()
  };
  if (!rec.blNumber) throw new Error('blNumber required');
  writeToSheet(rec);
  return rec;
}

// ────────────────────────────────────────────────────────────
// FETCH LIVE DATA FROM ONE LINE
// ────────────────────────────────────────────────────────────
function fetchONELineData(cleanBL) {
  const empty = { containerNo:'', type:'', origin:'', destination:'',
    vessel:'', voyage:'', eta:'', status:'Pending' };
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
    'Accept':     'application/json',
    'Referer':    ONE_BASE + '/one-ecom/manage-shipment/cargo-tracking'
  };
  const result = {};

  // Primary: search endpoint (container no + type, per v6.0 fix).
  try {
    const r0 = UrlFetchApp.fetch(
      ONE_BASE + '/api/v1/edh/containers/track-and-trace/search',
      { method:'post', contentType:'application/json',
        headers: headers, muteHttpExceptions: true,
        payload: JSON.stringify({
          page:1, page_length:10,
          filters:{ search_text: cleanBL, search_type:'BKG_NO' },
          timestamp: Date.now()
        }) });
    if (r0.getResponseCode() === 200) {
      const j0 = JSON.parse(r0.getContentText('UTF-8'));
      if (j0.status === 200 && j0.data && j0.data.length) {
        const it = j0.data[0];
        const c0 = (it.cntrList || it.containers || [])[0] || {};
        result.containerNo = it.containerNo || it.cntrNo || c0.cntrNo || c0.containerNo || '';
        const ts = it.containerTypeSize || it.cntrSzTpCd || c0.cntrSzTpCd || c0.containerTypeSize || '';
        const wt = it.weight || it.wt || c0.wt || c0.weight || '';
        result.type = (ts && wt) ? ts + ' | ' + wt : (ts || wt);
        if (it.vesselVoyage) {
          result.vessel = it.vesselVoyage.vesselName || it.vesselVoyage.vesselEngName || '';
          result.voyage = (it.vesselVoyage.voyageNo || '') + (it.vesselVoyage.directionCode || '');
        }
        if (it.por) result.origin      = [it.por.locationName, it.por.countryName].filter(Boolean).join(', ');
        if (it.pod) result.destination = [it.pod.locationName, it.pod.countryName].filter(Boolean).join(', ');
        if (it.latestEvent) {
          const en = it.latestEvent.eventName || '';
          result.status = STATUS_MAP[en] || en || 'Active';
        }
      }
    }
  } catch (e0) { Logger.log('search err: ' + e0.message); }

  // Fallback: voyage-list for vessel/route/eta.
  try {
    const r1 = UrlFetchApp.fetch(
      ONE_BASE + '/api/v1/edh/vessel/track-and-trace/voyage-list?booking_no=' + cleanBL,
      { method:'get', headers: headers, muteHttpExceptions: true });
    if (r1.getResponseCode() === 200) {
      const j1 = JSON.parse(r1.getContentText('UTF-8'));
      if (j1.status === 200 && j1.data && j1.data.length) {
        const v = j1.data[0];
        if (!result.vessel)      result.vessel      = v.vesselEngName || '';
        if (!result.voyage)      result.voyage      = (v.scheduleVoyageNumber || '') + (v.scheduleDirectionCode || '');
        if (!result.origin)      result.origin      = (v.pol && v.pol.locationName) || '';
        if (!result.destination) result.destination = (v.pod && v.pod.locationName) || '';
        if (!result.eta)         result.eta         = (v.pod && (v.pod.berthingDate || v.pod.arrivalDate)) || '';
      }
    }
  } catch (e1) { Logger.log('voyage-list err: ' + e1.message); }

  // Fallback: cop-events for status.
  try {
    const r2 = UrlFetchApp.fetch(
      ONE_BASE + '/api/v1/edh/containers/track-and-trace/cop-events?booking_no=' + cleanBL,
      { method:'get', headers: headers, muteHttpExceptions: true });
    if (r2.getResponseCode() === 200) {
      const j2 = JSON.parse(r2.getContentText('UTF-8'));
      if (j2.status === 200 && j2.data && j2.data.length) {
        const last = j2.data[j2.data.length - 1];
        if (!result.status || result.status === 'Pending')
          result.status = STATUS_MAP[last.eventName || ''] || last.eventName || 'Active';
      }
    }
  } catch (e2) { Logger.log('cop-events err: ' + e2.message); }

  return Object.assign(empty, result);
}

// ────────────────────────────────────────────────────────────
// SHEET HELPERS
// ────────────────────────────────────────────────────────────
function getSheet() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  for (const s of ss.getSheets()) if (s.getSheetId() === SHEET_GID) return s;
  return ss.getSheetByName(SHEET_NAME_FALLBACK) || ss.getSheets()[0];
}

function ensureHeaders(sheet) {
  if (!sheet.getRange(1, 1).getValue()) {
    const h = ['BL Number','Search Code','Container No','Type','Origin','Destination',
      'Vessel','Voyage','ETA','Status','Last Updated','Notes','Track URL','Carrier'];
    sheet.getRange(1, 1, 1, h.length).setValues([h])
      .setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#fff');
    sheet.setFrozenRows(1);
  }
}

// Write/upsert a record. CRITICAL GUARDS:
//   • Match by BL number (column A), case-insensitive.
//   • Preserve the existing Carrier (column N) unless the incoming record is
//     explicitly tagged — and NEVER downgrade WANHAI→ONE. This is the fix that
//     stops the N3 carrier tag from reverting.
function writeToSheet(rec) {
  const sheet = getSheet();
  ensureHeaders(sheet);
  const last = sheet.getLastRow();

  let targetRow = -1, existingCarrier = '';
  if (last > 1) {
    const blCol  = sheet.getRange(2, 1, last - 1, 1).getValues();
    const carCol = sheet.getRange(2, COL.CARRIER + 1, last - 1, 1).getValues();
    for (let i = 0; i < blCol.length; i++) {
      if (String(blCol[i][0]).toUpperCase() === rec.blNumber.toUpperCase()) {
        targetRow = i + 2;
        existingCarrier = String(carCol[i][0] || '').trim().toUpperCase();
        break;
      }
    }
  }

  // Decide the carrier to persist: keep WANHAI sticky; otherwise honour the
  // incoming tag; otherwise fall back to the existing one or ONE.
  let carrier = (rec.carrier || '').toUpperCase();
  if (existingCarrier === 'WANHAI') carrier = 'WANHAI';      // never revert WANHAI
  if (!carrier) carrier = existingCarrier || 'ONE';

  const row = [
    rec.blNumber, rec.searchCode, rec.containerNo, rec.type, rec.origin,
    rec.destination, rec.vessel, rec.voyage, rec.eta, rec.status,
    rec.lastUpdated, rec.notes, rec.trackUrl, carrier
  ];

  if (targetRow > 0) sheet.getRange(targetRow, 1, 1, NUM_COLS).setValues([row]);
  else               sheet.getRange(Math.max(last + 1, 2), 1, 1, NUM_COLS).setValues([row]);
}

function getSheetData() {
  const sheet = getSheet();
  const last  = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, NUM_COLS).getValues()
    .filter(r => r[COL.BL])
    .map(r => ({
      blNumber:    r[COL.BL]      || '',
      searchCode:  r[COL.SEARCH]  || '',
      containerNo: r[COL.CONTAINER] || '',
      type:        r[COL.TYPE]    || '',
      origin:      r[COL.ORIGIN]  || '',
      destination: r[COL.DEST]    || '',
      vessel:      r[COL.VESSEL]  || '',
      voyage:      r[COL.VOYAGE]  || '',
      eta:         r[COL.ETA]     || '',
      status:      r[COL.STATUS]  || 'Pending',
      lastUpdated: r[COL.UPDATED] || '',
      notes:       r[COL.NOTES]   || '',
      trackUrl:    r[COL.TRACKURL]|| '',
      carrier:     (r[COL.CARRIER] || 'ONE').toString().toUpperCase()
    }));
}

function deleteFromSheet(blNumber) {
  if (!blNumber) return { deleted: false };
  const sheet = getSheet();
  const last  = sheet.getLastRow();
  if (last < 2) return { deleted: false };
  const col = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (let i = col.length - 1; i >= 0; i--) {
    if (String(col[i][0]).toUpperCase() === blNumber.toUpperCase()) {
      sheet.deleteRow(i + 2);
      return { deleted: true };
    }
  }
  return { deleted: false };
}

// ────────────────────────────────────────────────────────────
// REFRESH ALL — ONE Line rows only. THE WAN HAI GUARD LIVES HERE.
// ────────────────────────────────────────────────────────────
function refreshAllBLs() {
  const records = getSheetData();
  const updated = [];
  for (const rec of records) {
    // GUARD: skip Wan Hai rows entirely. They are owned by the GitHub Actions
    // scraper. Touching them here is exactly what blanked their data and
    // reverted the Carrier tag in v3.1.
    if (rec.carrier === 'WANHAI') { updated.push(rec); continue; }
    try {
      const cleanBL = rec.blNumber.replace(/^ONEY/i, '').trim().toUpperCase();
      const live    = fetchONELineData(cleanBL);
      const fresh   = { ...rec, ...live, carrier: 'ONE', lastUpdated: new Date().toISOString() };
      writeToSheet(fresh);
      updated.push(fresh);
      Utilities.sleep(800);
    } catch (e) {
      Logger.log('refreshAllBLs error for ' + rec.blNumber + ': ' + e.message);
      updated.push(rec);
    }
  }
  return updated;
}

// ────────────────────────────────────────────────────────────
// TRIGGERS
// ────────────────────────────────────────────────────────────
function setupAutoRefresh() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'scheduledRefresh')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('scheduledRefresh').timeBased().everyHours(6).create();
  return { ok: true };
}

// Trigger entry point. Uses the SAME guarded refreshAllBLs, so the time-driven
// trigger can no longer revert the Wan Hai carrier tag or blank Wan Hai rows.
function scheduledRefresh() {
  try { refreshAllBLs(); }
  catch (e) { Logger.log('scheduledRefresh error: ' + e.message); }
}
