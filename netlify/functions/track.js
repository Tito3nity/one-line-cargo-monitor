// netlify/functions/track.js
// ONE Line BL Tracker - Netlify Serverless Function v6.0
// FIXED: Uses correct POST /search endpoint discovered via live bundle + network analysis
// Container No, Type, Weight, Vessel, Status all from a SINGLE search call
// GET /api/track?action=track&bl=BLNUMBER

const ONE_BASE = 'https://ecomm.one-line.com';

const STATUS_MAP = {
  'Empty Container Release to Shipper'                                         : 'Released',
  'Gate In to Outbound Terminal'                                               : 'Gate In (Pre-load)',
  'Loaded on Vessel at Port of Loading'                                        : 'In Transit',
  'Vessel Departure from Port of Loading'                                      : 'In Transit (Departed)',
  'Vessel Arrival at Port of Discharge'                                        : 'Arrived',
  'Unloaded from Vessel at Port of Discharging'                               : 'Arrived (Unloading)',
  'Gate Out from Inbound Terminal for Delivery to Consignee (or Port Shuttle)': 'Delivered',
  'Empty Container Returned from Customer'                                     : 'Completed v'
};

const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type'                : 'application/json'
};

const HDRS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Accept'         : 'application/json, text/plain, */*',
  'Content-Type'   : 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer'        : ONE_BASE + '/one-ecom/manage-shipment/cargo-tracking',
  'Origin'         : ONE_BASE
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers:CORS, body:'' };
  const params = event.queryStringParameters || {};
  const action = (params.action || 'track').toLowerCase();
  const bl     = (params.bl || '').trim();
  if (action === 'ping') return { statusCode:200, headers:CORS, body: JSON.stringify({ok:true}) };
  if (!bl)               return { statusCode:400, headers:CORS, body: JSON.stringify({error:'bl required'}) };
  try {
    const cleanBL = bl.replace(/^ONEY/i,'').trim().toUpperCase();
    const data    = await fetchONELineData(cleanBL, params.notes || '');
    return { statusCode:200, headers:CORS, body: JSON.stringify(data) };
  } catch(err) {
    return { statusCode:200, headers:CORS, body: JSON.stringify({error:err.message, status:'Pending', blNumber:bl}) };
  }
};

async function fetchONELineData(cleanBL, notes) {
  const result = {
    blNumber:cleanBL, searchCode:cleanBL, containerNo:'', type:'',
    origin:'', destination:'', vessel:'', voyage:'', eta:'',
    status:'Pending', notes,
    trackUrl: ONE_BASE + '/one-ecom/manage-shipment/cargo-tracking?trakNoParam=' + cleanBL + '&trakNoTpCdParam=B',
    lastUpdated: new Date().toISOString()
  };
  await callSearch(cleanBL, result);
  // If container info is still missing, retry with BL_NO search type
  if (!result.containerNo) await callSearchByBL(cleanBL, result);
  if (!result.vessel || !result.eta) await callVoyageList(cleanBL, result);
  if (!result.status || result.status === 'Pending') await callCopEvents(cleanBL, result);
  return result;
}

async function callSearch(cleanBL, result) {
  try {
    const r = await fetch(ONE_BASE + '/api/v1/edh/containers/track-and-trace/search', {
      method : 'POST',
      headers: HDRS,
      body   : JSON.stringify({
        page: 1, page_length: 10,
        filters: { search_text: cleanBL, search_type: 'BKG_NO' },
        timestamp: Date.now()
      })
    });
    if (!r.ok) return false;
    const j = await r.json();
    if (j.status !== 200 || !j.data || !j.data.length) return false;
    const item = j.data[0];

    // --- Container No: ONE Line stores containers in cntrList[] array ---
    // Top-level fields tried first, then nested cntrList / containers array
    const cntrArr = item.cntrList || item.containers || item.containerList || [];
    const cntr0   = cntrArr[0] || {};

    result.containerNo =
      item.containerNo  || item.cntrNo  || item.cntrNumber ||
      cntr0.cntrNo      || cntr0.containerNo               ||
      '';

    // --- Container Type/Size: try both naming conventions ---
    const ts =
      item.containerTypeSize || item.cntrSzTpCd || item.cntrTyp  ||
      cntr0.cntrSzTpCd       || cntr0.containerTypeSize           ||
      cntr0.cntrTyp          || cntr0.containerType               ||
      '';
    const wt =
      item.weight || item.wt ||
      cntr0.wt    || cntr0.weight || cntr0.grossWeight ||
      '';
    result.type = (ts && wt) ? ts + ' | ' + wt : (ts || wt);
    if (item.vesselVoyage) {
      result.vessel = item.vesselVoyage.vesselName || item.vesselVoyage.vesselEngName || '';
      result.voyage = (item.vesselVoyage.voyageNo || '') + (item.vesselVoyage.directionCode || '');
    }
    if (item.por) result.origin      = [item.por.locationName, item.por.countryName].filter(Boolean).join(', ');
    if (item.pod) result.destination = [item.pod.locationName, item.pod.countryName].filter(Boolean).join(', ');
    if (item.deadlineEvents && item.deadlineEvents.length) {
      const etaEv = item.deadlineEvents.find(function(e) { return /eta|arrival|berth/i.test(e.eventType || ''); });
      if (etaEv) result.eta = etaEv.date || etaEv.eventDate || '';
    }
    if (!result.eta && item.pod) result.eta = item.pod.eta || item.pod.arrivalDate || '';
    if (item.latestEvent) {
      const evName = item.latestEvent.eventName || '';
      result.status = STATUS_MAP[evName] || evName || 'Active';
    }
    return true;
  } catch(e) { console.error('search error:', e.message); return false; }
}

// Fallback: retry search with BL_NO type if BKG_NO returned no container info
async function callSearchByBL(cleanBL, result) {
  try {
    const r = await fetch(ONE_BASE + '/api/v1/edh/containers/track-and-trace/search', {
      method : 'POST',
      headers: HDRS,
      body   : JSON.stringify({
        page: 1, page_length: 10,
        filters: { search_text: cleanBL, search_type: 'BL_NO' },
        timestamp: Date.now()
      })
    });
    if (!r.ok) return;
    const j = await r.json();
    if (j.status !== 200 || !j.data || !j.data.length) return;
    const item   = j.data[0];
    const cntrArr = item.cntrList || item.containers || item.containerList || [];
    const cntr0   = cntrArr[0] || {};
    if (!result.containerNo)
      result.containerNo = item.containerNo || item.cntrNo || cntr0.cntrNo || cntr0.containerNo || '';
    if (!result.type) {
      const ts = item.containerTypeSize || item.cntrSzTpCd || cntr0.cntrSzTpCd || cntr0.containerTypeSize || '';
      const wt = item.weight || item.wt || cntr0.wt || cntr0.weight || '';
      result.type = (ts && wt) ? ts + ' | ' + wt : (ts || wt);
    }
  } catch(e) { console.error('searchByBL error:', e.message); }
}

async function callVoyageList(cleanBL, result) {
  try {
    const r = await fetch(ONE_BASE + '/api/v1/edh/vessel/track-and-trace/voyage-list?booking_no=' + cleanBL, { headers: HDRS });
    if (!r.ok) return;
    const j = await r.json();
    if (j.status !== 200 || !j.data || !j.data.length) return;
    const v = j.data[0];
    if (!result.vessel)      result.vessel      = v.vesselEngName || v.vslEngNm || '';
    if (!result.voyage)      result.voyage      = (v.scheduleVoyageNumber || '') + (v.scheduleDirectionCode || '');
    if (!result.origin)      result.origin      = (v.pol && (v.pol.locationName || v.pol.locNm)) || '';
    if (!result.destination) result.destination = (v.pod && (v.pod.locationName || v.pod.locNm)) || '';
    if (!result.eta)         result.eta         = (v.pod && (v.pod.berthingDate || v.pod.arrivalDate)) || '';
  } catch(e) { console.error('voyage-list error:', e.message); }
}

async function callCopEvents(cleanBL, result) {
  try {
    const r = await fetch(ONE_BASE + '/api/v1/edh/containers/track-and-trace/cop-events?booking_no=' + cleanBL, { headers: HDRS });
    if (!r.ok) return;
    const j = await r.json();
    if (j.status !== 200 || !j.data || !j.data.length) return;
    const last = j.data[j.data.length - 1];
    const evName = last.eventName || last.eventCd || '';
    result.status = STATUS_MAP[evName] || evName || 'Active';
  } catch(e) { console.error('cop-events error:', e.message); }
}
