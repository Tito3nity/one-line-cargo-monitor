// ============================================================
// ONE LINE BL TRACKER — Google Apps Script Backend v3.1
// FIXED: getSheetData() rs→r typo + missing containerNo/type/searchCode
// ============================================================

const SPREADSHEET_ID = '1e1smHhHSIZ89xltCWhDuK-tQI0LqQN7a0tPSxyLeZzs';
const SHEET_GID = 120157833;
const SHEET_NAME_FALLBACK = 'Sheet1';

// ────────────────────────────────────────────────────────────
// ONE LINE CONFIRMED API ENDPOINTS (no auth, no cookies)
//
// 1. voyage-list → vessel, voyage, origin, destination, ETA
//    GET /api/v1/edh/vessel/track-and-trace/voyage-list?booking_no={BL}
//
// 2. cop-events → current status (last event in array)
//    GET /api/v1/edh/containers/track-and-trace/cop-events?booking_no={BL}
// ────────────────────────────────────────────────────────────

const ONE_BASE = 'https://ecomm.one-line.com';

const STATUS_MAP = {
  'Empty Container Release to Shipper'                                                       : 'Released',
  'Gate In to Outbound Terminal'                                                             : 'Gate In (Pre-load)',
  'Loaded on Vessel at Port of Loading'                                                      : 'In Transit',
  'Vessel Departure from Port of Loading'                                                    : 'In Transit (Departed)',
  'Vessel Arrival at Port of Discharge'                                                      : 'Arrived',
  'Unloaded from Vessel at Port of Discharging'                                              : 'Arrived (Unloading)',
  'Gate Out from Inbound Terminal for Delivery to Consignee (or Port Shuttle)'               : 'Delivered',
  'Empty Container Returned from Customer'                                                   : 'Completed ✓'
};

// ────────────────────────────────────────────────────────────
// ROUTER
// ────────────────────────────────────────────────────────────
function doGet(e) {
  const action = (e.parameter.action || 'list').toLowerCase();
  let result;

  try {
    switch (action) {
      case 'track':
        result = trackSingleBL(
          (e.parameter.bl    || '').trim(),
          (e.parameter.notes || '').trim()
        );
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

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ────────────────────────────────────────────────────────────
// TRACK SINGLE BL
// ────────────────────────────────────────────────────────────
function trackSingleBL(blNumber, notes) {
  if (!blNumber) throw new Error('BL number is required');

  const cleanBL   = blNumber.replace(/^ONEY/i, '').trim().toUpperCase();
  const trackUrl  = ONE_BASE + '/one-ecom/manage-shipment/cargo-tracking?trakNoParam=' + cleanBL + '&trakNoTpCdParam=B';
  const live      = fetchONELineData(cleanBL);

  const record = {
    blNumber    : blNumber.toUpperCase(),
    searchCode  : cleanBL,
    containerNo : live.containerNo  || '',
    type        : live.type         || '',
    origin      : live.origin       || '',
    destination : live.destination  || '',
    vessel      : live.vessel       || '',
    voyage      : live.voyage       || '',
    eta         : live.eta          || '',
    status      : live.status       || 'Pending',
    lastUpdated : new Date().toISOString(),
    notes       : notes,
    trackUrl    : trackUrl
  };

  writeToSheet(record);
  return record;
}

// ────────────────────────────────────────────────────────────
// FETCH LIVE DATA FROM ONE LINE
// ────────────────────────────────────────────────────────────
function fetchONELineData(cleanBL) {
  const empty = {
    containerNo: '', type: '', origin: '', destination: '',
    vessel: '', voyage: '', eta: '', status: 'Pending'
  };

  const headers = {
    'User-Agent' : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
    'Accept'     : 'application/json',
    'Referer'    : ONE_BASE + '/one-ecom/manage-shipment/cargo-tracking'
  };

  const result = {};

  try {
    const r1 = UrlFetchApp.fetch(
      ONE_BASE + '/api/v1/edh/vessel/track-and-trace/voyage-list?booking_no=' + cleanBL,
      { method: 'GET', headers: headers, muteHttpExceptions: true }
    );
    if (r1.getResponseCode() === 200) {
      const j1 = JSON.parse(r1.getContentText('UTF-8'));
      if (j1.status === 200 && j1.data && j1.data.length > 0) {
        const v = j1.data[0];
        result.vessel      = v.vesselEngName || '';
        result.voyage      = (v.scheduleVoyageNumber || '') + (v.scheduleDirectionCode || '');
        result.origin      = (v.pol && v.pol.locationName) || '';
        result.destination = (v.pod && v.pod.locationName) || '';
        result.eta         = (v.pod && (v.pod.berthingDate || v.pod.arrivalDate))
                           || (v.pol && v.pol.date) || '';
      }
    }
  } catch (e1) { Logger.log('voyage-list err: ' + e1.message); }

  try {
    const r2 = UrlFetchApp.fetch(
      ONE_BASE + '/api/v1/edh/containers/track-and-trace/cop-events?booking_no=' + cleanBL,
      { method: 'GET', headers: headers, muteHttpExceptions: true }
    );
    if (r2.getResponseCode() === 200) {
      const j2 = JSON.parse(r2.getContentText('UTF-8'));
      if (j2.status === 200 && j2.data && j2.data.length > 0) {
        const last = j2.data[j2.data.length - 1];
        result.status = STATUS_MAP[last.eventName || ''] || last.eventName || 'Active';
      }
    }
  } catch (e2) { Logger.log('cop-events err: ' + e2.message); }

  return Object.assign(empty, result);
}

function getSheet() {
  const ss     = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheets = ss.getSheets();
  for (const s of sheets) {
    if (s.getSheetId() === SHEET_GID) return s;
  }
  return ss.getSheetByName(SHEET_NAME_FALLBACK) || sheets[0];
}

function ensureHeaders(sheet) {
  if (!sheet.getRange(1, 1).getValue()) {
    const h = [
      'BL Number', 'Search Code', 'Container No', 'Type',
      'Origin', 'Destination', 'Vessel', 'Voyage',
      'ETA', 'Status', 'Last Updated', 'Notes', 'Track URL'
    ];
    const r = sheet.getRange(1, 1, 1, h.length);
    r.setValues([h]).setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#fff');
    sheet.setFrozenRows(1);
  }
}

function writeToSheet(rec) {
  const sheet = getSheet();
  ensureHeaders(sheet);
  const row = [
    rec.blNumber, rec.searchCode, rec.containerNo, rec.type,
    rec.origin,   rec.destination, rec.vessel,      rec.voyage,
    rec.eta,      rec.status,      rec.lastUpdated, rec.notes, rec.trackUrl
  ];
  const last = sheet.getLastRow();
  if (last > 1) {
    const col = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (let i = 0; i < col.length; i++) {
      if (String(col[i][0]).toUpperCase() === rec.blNumber.toUpperCase()) {
        sheet.getRange(i + 2, 1, 1, row.length).setValues([row]);
        return;
      }
    }
  }
  sheet.getRange(Math.max(last + 1, 2), 1, 1, row.length).setValues([row]);
}

// GET SHEET DATA  ← BUG-01 FIXED (rs → r) + BUG-02 FIXED (added fields)
function getSheetData() {
  const sheet = getSheet();
  const last  = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, 13)
    .getValues()
    .filter(r => r[0])
    .map(r => ({
      blNumber    : r[0]  || '',
      searchCode  : r[1]  || '',
      containerNo : r[2]  || '',
      type        : r[3]  || '',
      origin      : r[4]  || '',
      destination : r[5]  || '',
      vessel      : r[6]  || '',
      voyage      : r[7]  || '',
      eta         : r[8]  || '',
      status      : r[9]  || 'Pending',
      lastUpdated : r[10] || '',
      notes       : r[11] || '',
      trackUrl    : r[12] || ''
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

function refreshAllBLs() {
  const records = getSheetData();
  const updated = [];
  for (const rec of records) {
    try {
      const cleanBL = rec.blNumber.replace(/^ONEY/i, '').trim().toUpperCase();
      const live    = fetchONELineData(cleanBL);
      const fresh   = { ...rec, ...live, lastUpdated: new Date().toISOString() };
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

function setupAutoRefresh() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'scheduledRefresh')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('scheduledRefresh').timeBased().everyHours(6).create();
  return { ok: true };
}

function scheduledRefresh() {
  try { refreshAllBLs(); } catch (e) { Logger.log('scheduledRefresh error: ' + e.message); }
}
