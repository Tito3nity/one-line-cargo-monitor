// netlify/functions/track.js
// ONE Line BL Tracker - Netlify Serverless Function v5.0
// Fixed: Container No & Type extracted from cop-events + dedicated BL endpoint
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

const ISO_TYPE_MAP = {
  '20G0':"20'DRY ST.",'20G1':"20'DRY ST.",'22G0':"20'DRY ST.",'22G1':"20'DRY ST.",
  '22GP':"20'DRY ST.",
  '40G0':"40'DRY ST.",'40G1':"40'DRY ST.",'42G0':"40'DRY ST.",'42G1':"40'DRY ST.",
  '42GP':"40'DRY ST.",
  '45G0':"40'DRY HC",'45G1':"40'DRY HC",'45GP':"40'DRY HC",
  'L5G0':"45'DRY HC",'L5G1':"45'DRY HC",'L5GP':"45'DRY HC",
  '22R0':"20'REEFER",'22R1':"20'REEFER",'42R0':"40'REEFER",'42R1':"40'REEFER",
  '45R1':"40'REEFER HC",
  '22T0':"20'OPEN TOP",'22T1':"20'OPEN TOP",'42T0':"40'OPEN TOP",'42T1':"40'OPEN TOP",
  '22P0':"20'FLAT RACK",'22P1':"20'FLAT RACK",'42P0':"40'FLAT RACK",'42P1':"40'FLAT RACK",
  '22U0':"20'OPEN SIDE",'42U0':"40'OPEN SIDE",
  '22B0':"20'BULK",'22B1':"20'BULK"
};

function buildTypeFromCodes(szCd, tpCd, grCd, weightKg) {
  if (!szCd && !tpCd) return '';
  const sz = String(szCd || '').replace(/[^0-9]/g,'');
  let tp = String(tpCd || '').toUpperCase();
  if (/^G(P|0|1)?$/.test(tp) || tp === 'GP' || tp === 'DRY') tp = 'DRY';
  if (tp === 'R' || tp === 'RF') tp = 'REEFER';
  if (tp === 'T' || tp === 'OT') tp = 'OPEN TOP';
  if (tp === 'P' || tp === 'FR') tp = 'FLAT RACK';
  const gr = String(grCd || '').toUpperCase();
  const grade = (gr === 'HC' || gr === 'HQ') ? 'HC' : 'ST.';
  let typeStr = '';
  if (sz) typeStr += sz + "'";
  if (tp) typeStr += tp + ' ' + grade;
  if (weightKg) {
    const wt = parseFloat(weightKg);
    if (!isNaN(wt) && wt > 0) typeStr += ' | ' + wt.toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3}) + ' KGS';
  }
  return typeStr.trim();
}

function extractContainerInfo(obj) {
  if (!obj || typeof obj !== 'object') return { containerNo:'', type:'' };
  const containerNo = obj.cntrNo || obj.containerNo || obj.cntr_no || obj.cntrNbr || obj.containerNumber || obj.equipmentReference || obj.equipmentNo || obj.unitNo || obj.containerRef || '';
  let type = obj.cntrTypNm || obj.containerTypeName || obj.cntrTypeNm || obj.typeFullNm || obj.containerTypeDesc || obj.equipmentTypeDesc || '';
  if (!type) {
    const iso = (obj.isoCode || obj.isoCd || obj.cntrIsoCode || obj.isoTypCd || obj.cntrSzTypCd || '').toUpperCase();
    if (iso && ISO_TYPE_MAP[iso]) {
      const base = ISO_TYPE_MAP[iso];
      const wt = obj.grossWtKg || obj.grossWeight || obj.totalWeightKg || obj.weightKg || 0;
      type = wt ? base + ' | ' + parseFloat(wt).toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3}) + ' KGS' : base;
    }
  }
  if (!type) {
    const sz = obj.cntrSzCd || obj.containerSize || obj.cntrSize || obj.sizeCd || obj.cntrSzTypCd || '';
    const tp = obj.cntrTpCd || obj.containerType || obj.cntrType || obj.typeCd || obj.cntrTpNm || '';
    const gr = obj.cntrGrdCd || obj.grade || obj.heightType || obj.cntrHtCd || '';
    const wt = obj.grossWtKg || obj.grossWeight || obj.totalWeightKg || obj.weightKg || 0;
    type = buildTypeFromCodes(sz, tp, gr, wt);
  }
  return { containerNo: String(containerNo).trim(), type: String(type).trim() };
}

function findContainers(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const key of ['containers','containerList','cntrList','units','unitList','cntrInfo']) {
      if (Array.isArray(data[key]) && data[key].length > 0) return data[key];
    }
    for (const key of Object.keys(data)) {
      if (Array.isArray(data[key]) && data[key].length > 0) {
        const first = data[key][0];
        if (first && (first.cntrNo || first.containerNo || first.cntrSzCd)) return data[key];
      }
    }
  }
  return null;
}

const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type'                : 'application/json'
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
    const data = await fetchONELineData(cleanBL, params.notes || '');
    return { statusCode:200, headers:CORS, body: JSON.stringify(data) };
  } catch(err) {
    return { statusCode:200, headers:CORS, body: JSON.stringify({error:err.message, status:'Pending', blNumber:bl}) };
  }
};

async function fetchONELineData(cleanBL, notes) {
  const hdrs = {
    'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept'         : 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer'        : ONE_BASE + '/one-ecom/manage-shipment/cargo-tracking',
    'Origin'         : ONE_BASE,
    'x-application' : 'ONE-ECOM'
  };
  const result = {
    blNumber:cleanBL, searchCode:cleanBL, containerNo:'', type:'',
    origin:'', destination:'', vessel:'', voyage:'', eta:'',
    status:'Pending', notes,
    trackUrl: ONE_BASE + '/one-ecom/manage-shipment/cargo-tracking?trakNoParam=' + cleanBL + '&trakNoTpCdParam=B',
    lastUpdated: new Date().toISOString()
  };
  const paramVariants = ['bl_no='+cleanBL, 'booking_no='+cleanBL, 'bno='+cleanBL];

  // API 1: voyage-list
  for (const param of paramVariants) {
    try {
      const r1 = await fetch(ONE_BASE+'/api/v1/edh/vessel/track-and-trace/voyage-list?'+param, {headers:hdrs});
      if (!r1.ok) continue;
      const j1 = await r1.json();
      if (j1.status===200 && j1.data && j1.data.length>0) {
        const v = j1.data[0];
        result.vessel      = v.vesselEngName || v.vslEngNm || v.vesselName || '';
        result.voyage      = (v.scheduleVoyageNumber||v.voyageNo||v.voyNo||'')+(v.scheduleDirectionCode||v.dirCd||'');
        result.origin      = (v.pol&&(v.pol.locationName||v.pol.locNm||v.pol.portName))||'';
        result.destination = (v.pod&&(v.pod.locationName||v.pod.locNm||v.pod.portName))||'';
        result.eta         = (v.pod&&(v.pod.berthingDate||v.pod.arrivalDate||v.pod.etaDate))||(v.pol&&v.pol.date)||'';
        const cntrList = findContainers(v) || findContainers(j1.data);
        if (cntrList && cntrList.length>0) {
          const info = extractContainerInfo(cntrList[0]);
          if (!result.containerNo && info.containerNo) result.containerNo = info.containerNo;
          if (!result.type && info.type) result.type = info.type;
        }
        break;
      }
    } catch(e) { console.error('voyage-list:',e.message); }
  }

  // API 2: cop-events (status + container info)
  for (const param of paramVariants) {
    try {
      const r2 = await fetch(ONE_BASE+'/api/v1/edh/containers/track-and-trace/cop-events?'+param, {headers:hdrs});
      if (!r2.ok) continue;
      const j2 = await r2.json();
      if (j2.status===200 && j2.data) {
        const events = Array.isArray(j2.data) ? j2.data : findContainers(j2.data)||[j2.data];
        if (events.length>0) {
          const last = events[events.length-1];
          const evName = last.eventName||last.eventCd||last.statusNm||'';
          result.status = STATUS_MAP[evName]||evName||'Active';
          for (const ev of events) {
            const info = extractContainerInfo(ev);
            if (!result.containerNo && info.containerNo) result.containerNo = info.containerNo;
            if (!result.type && info.type) result.type = info.type;
            if (result.containerNo && result.type) break;
          }
          break;
        }
      }
    } catch(e) { console.error('cop-events:',e.message); }
  }

  // API 3: dedicated container endpoints
  if (!result.containerNo) {
    const eps = [
      '/api/v1/edh/containers/track-and-trace/unit-list',
      '/api/v1/edh/booking/bl-cntr-list',
      '/api/v1/edh/booking/bl-detail',
      '/api/v1/edh/cargo-tracking/unit-list',
      '/api/v1/edh/booking/bkg-dtl-info'
    ];
    outer3:
    for (const param of paramVariants) {
      for (const ep of eps) {
        try {
          const r3 = await fetch(ONE_BASE+ep+'?'+param, {headers:hdrs});
          if (!r3.ok) continue;
          const j3 = await r3.json();
          if (j3.status!==200 || !j3.data) continue;
          const items = findContainers(j3.data)||(Array.isArray(j3.data)?j3.data:[j3.data]);
          if (items && items.length>0) {
            const info = extractContainerInfo(items[0]);
            if (info.containerNo) {
              result.containerNo = info.containerNo;
              if (info.type) result.type = info.type;
              break outer3;
            }
          }
        } catch(e) { /* try next */ }
      }
    }
  }
  return result;
}
