// netlify/functions/track.js
// ONE Line BL Tracker — Netlify Serverless Function v3.0
// Direct ONE Line API calls confirmed working (no auth required)
// GET /api/track?action=track&bl=BLNUMBER

const ONE_BASE = 'https://ecomm.one-line.com';
const STATUS_MAP = {
  'Empty Container Release to Shipper'                                         : 'Released',
  'Gate In to Outbound Terminal'                                               : 'Gate In (Pre-load)',
  'Loaded on Vessel at Port of Loading'                                        : 'In Transit',
  'Vessel Departure from Port of Loading'                                      : 'In Transit (Departed)',
  'Vessel Arrival at Port of Discharge'                                        : 'Arrived',
  'Unloaded from Vessel at Port of Discharging'                                : 'Arrived (Unloading)',
  'Gate Out from Inbound Terminal for Delivery to Consignee (or Port Shuttle)' : 'Delivered',
  'Empty Container Returned from Customer'                                     : 'Completed ✓'
};
const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type'                : 'application/json'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers:CORS, body:'' };
  const params = event.queryStringParameters || {};
  const action = (params.action || 'track').toLowerCase();
  const bl     = (params.bl || '').trim();
  if (action === 'ping') return { statusCode:200, headers:CORS, body: JSON.stringify({ok:true}) };
  if (!bl) return { statusCode:400, headers:CORS, body: JSON.stringify({error:'bl required'}) };
  try {
    const cleanBL = bl.replace(/^ONEY/i,'').trim().toUpperCase();
    const data = await fetchONELineData(cleanBL, params.notes||'');
    return { statusCode:200, headers:CORS, body: JSON.stringify(data) };
  } catch(err) {
    return { statusCode:200, headers:CORS, body: JSON.stringify({error:err.message,status:'Pending',blNumber:bl}) };
  }
};

async function fetchONELineData(cleanBL, notes) {
  const hdrs = {
    'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
    'Accept':'application/json, text/plain, */*',
    'Referer': ONE_BASE + '/one-ecom/manage-shipment/cargo-tracking'
  };
  const result = {
    blNumber:cleanBL, searchCode:cleanBL, containerNo:'', type:'',
    origin:'', destination:'', vessel:'', voyage:'', eta:'', status:'Pending', notes,
    trackUrl: ONE_BASE+'/one-ecom/manage-shipment/cargo-tracking?trakNoParam='+cleanBL+'&trakNoTpCdParam=B',
    lastUpdated: new Date().toISOString()
  };
  // API 1: voyage-list
  try {
    const r1 = await fetch(ONE_BASE+'/api/v1/edh/vessel/track-and-trace/voyage-list?booking_no='+cleanBL, {headers:hdrs});
    if (r1.ok) {
      const j1 = await r1.json();
      if (j1.status===200 && j1.data && j1.data.length>0) {
        const v=j1.data[0];
        result.vessel=v.vesselEngName||'';
        result.voyage=(v.scheduleVoyageNumber||'')+(v.scheduleDirectionCode||'');
        result.origin=(v.pol&&v.pol.locationName)||'';
        result.destination=(v.pod&&v.pod.locationName)||'';
        result.eta=(v.pod&&(v.pod.berthingDate||v.pod.arrivalDate))||(v.pol&&v.pol.date)||'';
      }
    }
  } catch(e){ console.error('voyage-list:',e.message); }
  // API 2: cop-events
  try {
    const r2 = await fetch(ONE_BASE+'/api/v1/edh/containers/track-and-trace/cop-events?booking_no='+cleanBL, {headers:hdrs});
    if (r2.ok) {
      const j2 = await r2.json();
      if (j2.status===200 && j2.data && j2.data.length>0) {
        const last=j2.data[j2.data.length-1];
        result.status=STATUS_MAP[last.eventName||'']||last.eventName||'Active';
      }
    }
  } catch(e){ console.error('cop-events:',e.message); }
  return result;
}
