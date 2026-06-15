// server/wanhai.js
// Wan Hai Lines (WHL) cargo tracking module for the multi-carrier dashboard.
// Reverse-engineered flow (JSF / PrimeFaces, www.wanhai.com):
//   1) GET  tracking_data_page_by_bl_redirect.xhtml?ref_no=<BL>&ref_type=MFT
//          -> intermediate page; scrape javax.faces.ViewState + the autoLink command id.
//          -> keep the JSESSIONID cookie from Set-Cookie.
//   2) POST same URL (full-page, form-encoded, send cookie, follow redirect)
//          body: cargoTrackV2Bean=cargoTrackV2Bean
//                <cmdId>=<cmdId>            (e.g. j_idt29:0:autoLink_)
//                q_ref_no=<BL> & q_ref_type=MFT
//                javax.faces.ViewState=<token>
//          -> 302 -> tracking_data_page_by_bl.xhtml?file_num=...&top_file_num=...&parent_id=...
//             which contains the fully-rendered result tables (HTML).
//   3) Parse the result HTML tables into structured JSON.
//
// MFT (cargoType=2 on the site) covers BOTH BL numbers and booking numbers.
// No API key / auth required. Runs on the Render web service (proxy rationale
// identical to ONE Line: carrier blocks some cloud IPs intermittently).

const BASE = "https://www.wanhai.com/views/cargo_track_v2";
const REDIRECT_EP = BASE + "/tracking_data_page_by_bl_redirect.xhtml";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// --- tiny HTML helpers (no cheerio dependency) -----------------------------

function stripTags(s) {
  return (s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function parseRows(tableHtml) {
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(tableHtml))) {
    const cellRe = /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi;
    const cells = [];
    let c;
    while ((c = cellRe.exec(m[1]))) cells.push(stripTags(c[1]));
    if (cells.some((x) => x.length)) rows.push(cells);
  }
  return rows;
}

function extractTblLists(html) {
  const out = [];
  const re = /<table\b[^>]*class="[^"]*tbl-list[^"]*"[^>]*>([\s\S]*?)<\/table>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[0]);
  return out;
}

// --- step 1: GET intermediate page, harvest ViewState + cmdId + cookie -----

async function getRedirectContext(refNo, refType) {
  const url =
    REDIRECT_EP +
    "?ref_no=" + encodeURIComponent(refNo) +
    "&ref_type=" + encodeURIComponent(refType);

  const res = await fetch(url, {
    method: "GET",
    headers: { "User-Agent": UA, Accept: "text/html" },
    redirect: "follow",
  });
  const html = await res.text();

  const setCookie = res.headers.get("set-cookie") || "";
  const cookie = setCookie
    .split(/,(?=[^;]+?=)/)
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");

  const viewState =
    (html.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/) ||
      html.match(/id="javax\.faces\.ViewState"[^>]*value="([^"]*)"/) ||
      [])[1];

  const onclick = (html.match(/mojarra\.jsfcljs\([^)]*\)/) || [])[0] || "";
  const cmdId = (onclick.match(/'(j_idt\d+:0:autoLink_)'/) || [])[1];
  const pageRefNo = (onclick.match(/'q_ref_no':'([^']+)'/) || [])[1] || refNo;
  const pageRefType =
    (onclick.match(/'q_ref_type':'([^']+)'/) || [])[1] || refType;

  return { html, cookie, viewState, cmdId, pageRefNo, pageRefType };
}

// --- step 2: POST to resolve to the result page ----------------------------

async function fetchResultHtml(refNo, refType) {
  const ctx = await getRedirectContext(refNo, refType);
  if (!ctx.viewState || !ctx.cmdId) {
    throw new Error(
      "WHL: could not establish tracking session (no ViewState/command). " +
        "BL may be invalid or the site layout changed."
    );
  }

  const body = new URLSearchParams();
  body.set("cargoTrackV2Bean", "cargoTrackV2Bean");
  body.set(ctx.cmdId, ctx.cmdId);
  body.set("q_ref_no", ctx.pageRefNo);
  body.set("q_ref_type", ctx.pageRefType);
  body.set("javax.faces.ViewState", ctx.viewState);

  const res = await fetch(REDIRECT_EP, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html",
      ...(ctx.cookie ? { Cookie: ctx.cookie } : {}),
    },
    body: body.toString(),
    redirect: "follow",
  });

  const html = await res.text();
  return { html, finalUrl: res.url };
}

// --- step 3: parse result tables into structured JSON ----------------------

function parseResult(html, refNo) {
  const tables = extractTblLists(html);
  const result = {
    carrier: "WAN HAI",
    blNo: refNo,
    blIssueDate: null,
    blType: null,
    vesselName: null,
    voyage: null,
    gateInLastContainer: null,
    placeOfReceipt: null,
    portOfLoading: null,
    portOfDischarging: null,
    placeOfDelivery: null,
    finalDestination: null,
    etd: null,
    eta: null,
    containers: [],
  };

  const flat = [];
  for (const t of tables) for (const r of parseRows(t)) flat.push(r);

  const findVal = (label) => {
    for (const row of flat) {
      const i = row.findIndex((c) => c.toLowerCase() === label.toLowerCase());
      if (i !== -1 && row[i + 1] !== undefined) return row[i + 1];
    }
    return null;
  };

  result.blNo = findVal("BL no.") || refNo;
  result.blIssueDate = findVal("B/L Issue Date");
  result.blType = findVal("B/L Type");
  result.vesselName = findVal("Vessel Name");
  result.voyage = findVal("Voyage");
  result.gateInLastContainer = findVal("Gate-in Date Of the last Container");

  for (const row of flat) {
    const label = (row[0] || "").toLowerCase();
    const loc = row[1] || null;
    const date = row[row.length - 1] || null;
    if (label.startsWith("place of receipt")) result.placeOfReceipt = loc;
    else if (label.startsWith("port of loading")) {
      result.portOfLoading = loc;
      if (/depart/i.test(row.join(" "))) result.etd = date;
    } else if (label.startsWith("port of discharg")) {
      result.portOfDischarging = loc;
      if (/arriv/i.test(row.join(" "))) result.eta = date;
    } else if (label.startsWith("place of delivery")) result.placeOfDelivery = loc;
    else if (label.startsWith("final destination"))
      result.finalDestination = loc && loc !== "---" ? loc : null;
  }

  let inCtnr = false;
  for (const row of flat) {
    const joined = row.join(" ").toLowerCase();
    if (joined.includes("ctnr no.") && joined.includes("current status")) {
      inCtnr = true;
      continue;
    }
    if (inCtnr) {
      if (/^\d+$/.test(row[0]) && /^[A-Z]{4}\d{6,7}$/.test(row[1] || "")) {
        result.containers.push({
          containerNo: row[1] || null,
          typeSize: row[2] || null,
          sealNo: row[3] || null,
          maxGrossWeight: row[4] || null,
          maxCargoWeight: row[5] || null,
          packageCargoWeight: row[6] || null,
          currentStatus: row[7] || null,
          statusDate: row[8] || null,
        });
      }
    }
  }

  if (result.containers.length) {
    result.latestStatus = result.containers[0].currentStatus;
    result.latestStatusDate = result.containers[0].statusDate;
    result.containerNo = result.containers.map((c) => c.containerNo).join(", ");
    result.containerType = result.containers
      .map((c) => c.typeSize)
      .filter(Boolean)
      .join(", ");
  }

  return result;
}

// --- public API ------------------------------------------------------------

async function trackWanHai(refNo, refType = "MFT") {
  if (!refNo || typeof refNo !== "string") {
    throw new Error("WHL: missing BL/booking number");
  }
  const cleaned = refNo.trim().toUpperCase();
  const { html, finalUrl } = await fetchResultHtml(cleaned, refType);

  if (
    !/tracking_data_page_by_bl\.xhtml/.test(finalUrl) &&
    !/tbl-list/.test(html)
  ) {
    throw new Error(
      "WHL: no tracking result for " +
        cleaned +
        " (BL not found or not yet available)."
    );
  }

  const data = parseResult(html, cleaned);
  data.sourceUrl = finalUrl;
  data.fetchedAt = new Date().toISOString();
  return data;
}

module.exports = { trackWanHai };
