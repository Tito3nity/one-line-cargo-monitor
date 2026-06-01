/**
 * ONE Line Cargo Tracker — Automatic Scraper
 * ─────────────────────────────────────────────────────────────────────
 * Runs daily via GitHub Actions (free) or Railway.
 * Opens ONE Line in headless browser, checks each BL, updates Google Sheets,
 * and sends email alert when any status changes.
 *
 * ✅ Verified URL: ?trakNoParam={BL_without_ONEY}&trakNoTpCdParam=B
 * ─────────────────────────────────────────────────────────────────────
 * Required env variables (set as GitHub Secrets or Railway variables):
 *   GOOGLE_SHEET_ID   → your Google Sheet ID
 *   GOOGLE_CREDS      → Service Account JSON (base64 encoded)
 *   ALERT_EMAIL       → email address to notify on status change
 *   SMTP_HOST         → e.g. smtp.gmail.com
 *   SMTP_USER         → your Gmail address
 *   SMTP_PASS         → your Gmail App Password (not regular password)
 */

const puppeteer  = require("puppeteer");
const { google } = require("googleapis");
const nodemailer = require("nodemailer");

/* ─── CONFIG ─────────────────────────────────────────────────────────── */
const SHEET_ID    = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME  = "ONE Line Daily Monitor";
const ALERT_EMAIL = process.env.ALERT_EMAIL || "";
const ONE_LINE_URL = "https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking";

/* ─── ONE LINE STATUS MAPPING ────────────────────────────────────────── */
// Maps ONE Line event text → our status labels
function mapStatus(eventText = "", place = "") {
  const t = (eventText + " " + place).toLowerCase();
  if (t.includes("gate out") || t.includes("delivered") || t.includes("returned"))          return "Delivered";
  if (t.includes("discharg") || t.includes("unload"))             return "At Port";
  if (t.includes("customs") || t.includes("clearance"))           return "Customs";
  if (t.includes("delay") || t.includes("weather"))               return "Delayed";
  if (t.includes("arrival") || t.includes("arrived"))             return "Arrived";
  if (t.includes("depart") || t.includes("vessel sailing"))       return "In Transit";
  if (t.includes("loaded") || t.includes("on board"))             return "In Transit";
  if (t.includes("receiv") || t.includes("empty"))                return "Departed";
  return "In Transit";   // default
}

/* ─── GOOGLE SHEETS AUTH ─────────────────────────────────────────────── */
async function getSheets() {
  let creds;
  try {
    // Support base64 encoded JSON or raw JSON string
    const raw = process.env.GOOGLE_CREDS || "";
    creds = JSON.parse(
      raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf-8")
    );
  } catch (e) {
    console.error("❌ GOOGLE_CREDS env var is missing or invalid JSON");
    process.exit(1);
  }
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

/* ─── READ BL LIST FROM SHEET ────────────────────────────────────────── */
async function readSheetData(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range:         `${SHEET_NAME}!A2:L200`,
  });
  const rows = res.data.values || [];
  return rows
    .filter(r => r[0])   // skip empty rows
    .map((r, i) => ({
      rowIndex: i + 2,   // 1-indexed, +1 for header
      bl:       r[0]?.trim() || "",
      searchBL: r[1]?.trim() || (r[0]?.startsWith("ONEY") ? r[0].slice(4) : r[0]),
      ctr:      r[2]?.trim() || "",
      type:     r[3]?.trim() || "",
      orig:     r[4]?.trim() || "",
      dest:     r[5]?.trim() || "",
      vessel:   r[6]?.trim() || "",
      voy:      r[7]?.trim() || "",
      eta:      r[8]?.trim() || "",
      prevStatus: r[9]?.trim() || "",
      prevUpd:    r[10]?.trim() || "",
    }));
}

/* ─── SCRAPE ONE LINE ────────────────────────────────────────────────── */
async function scrapeOneLine(page, searchCode) {
  const url = `${ONE_LINE_URL}?trakNoParam=${searchCode}&trakNoTpCdParam=B`;
  console.log(`   → Fetching: ${url}`);

  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
    // Wait for results table or "No Data" message
    await page.waitForFunction(
      () => document.querySelector("table tbody tr") ||
            document.querySelector(".no-data") ||
            document.body.innerText.includes("No Data"),
      { timeout: 45000 }
    );
    await new Promise(r => setTimeout(r, 1500));   // extra wait for JS render

    const result = await page.evaluate(() => {
      // ONE Line table columns: Booking Ref | Container No | Latest Place | Latest Event Status/Time | POD/Vessel Arrival
      const rows = document.querySelectorAll("table tbody tr");
      if (!rows.length) return null;

      // Collect all rows (may have multiple containers per BL)
      const data = [];
      rows.forEach(tr => {
        const cells = tr.querySelectorAll("td");
        if (cells.length >= 4) {
          data.push({
            bookingRef:    cells[0]?.textContent?.trim() || "",
            containerNo:   cells[1]?.textContent?.trim() || "",
            latestPlace:   cells[2]?.textContent?.trim() || "",
            eventStatus:   cells[3]?.textContent?.trim() || "",
            vesselArrival: cells[4]?.textContent?.trim() || "",
          });
        }
      });
      return data.length > 0 ? data : null;
    });

    return result;
  } catch (err) {
    console.log(`   ⚠ Timeout or error for ${searchCode}: ${err.message}`);
    return null;
  }
}

/* ─── UPDATE GOOGLE SHEET ────────────────────────────────────────────── */
async function updateSheet(sheets, updates) {
  if (!updates.length) return;
  const data = updates.map(u => ({
    range:  `${SHEET_NAME}!J${u.rowIndex}:L${u.rowIndex}`,
    values: [[u.newStatus, u.timestamp, u.note]],
  }));
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    resource: { valueInputOption: "RAW", data },
  });
  console.log(`✅ Updated ${updates.length} rows in Google Sheets`);
}

/* ─── SEND EMAIL ALERT ───────────────────────────────────────────────── */
async function sendAlertEmail(changes) {
  if (!changes.length || !ALERT_EMAIL || !process.env.SMTP_HOST) return;

  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST || "smtp.gmail.com",
    port:   587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const lines = changes.map(c =>
    `  ${c.bl}\n  ${c.prevStatus} → ${c.newStatus}  ${c.newStatus === "Arrived" ? "✅" : c.newStatus === "Delayed" ? "⚠️" : "📋"}\n  ${c.note}\n  Track: ${ONE_LINE_URL}?trakNoParam=${c.searchBL}&trakNoTpCdParam=B\n`
  ).join("\n");

  const body = `ONE LINE CARGO STATUS CHANGE ALERT
${"═".repeat(44)}
Date: ${new Date().toLocaleString("en-ID", {timeZone:"Asia/Jakarta"})} WIB
Changes: ${changes.length} shipment(s)

${"─".repeat(44)}
${lines}
${"─".repeat(44)}
Track all shipments:
${ONE_LINE_URL}

Auto-generated by ONE Line Live Monitor
`;

  try {
    await transporter.sendMail({
      from:    process.env.SMTP_USER,
      to:      ALERT_EMAIL,
      subject: `🚢 ONE Line Status Change — ${changes.length} update(s) — ${new Date().toLocaleDateString("en-ID")}`,
      text:    body,
    });
    console.log(`📧 Alert email sent to ${ALERT_EMAIL}`);
  } catch (err) {
    console.error("❌ Email failed:", err.message);
  }
}

/* ─── MAIN ───────────────────────────────────────────────────────────── */
async function main() {
  console.log("═".repeat(60));
  console.log("  ONE LINE CARGO TRACKER — DAILY SYNC");
  console.log("  " + new Date().toLocaleString("en-ID", {timeZone:"Asia/Jakarta"}) + " WIB");
  console.log("═".repeat(60));

  if (!SHEET_ID) {
    console.error("❌ GOOGLE_SHEET_ID env var not set"); process.exit(1);
  }

  // 1. Connect to Google Sheets
  console.log("\n📊 Connecting to Google Sheets...");
  const sheets = await getSheets();
  const rows   = await readSheetData(sheets);
  console.log(`✅ Found ${rows.length} shipments to check`);

  if (!rows.length) { console.log("No data found in sheet. Exiting."); return; }

  // 2. Launch headless browser
  console.log("\n🌐 Launching headless browser...");
  const browser = await puppeteer.launch({
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
    headless: "new",
  });
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36");
  await page.setViewport({ width: 1280, height: 800 });

  // 3. Accept cookies on first visit
  await page.goto(ONE_LINE_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));
  try {
    // Try to dismiss cookie banner if it appears
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button")];
      const accept = btns.find(b => /accept|agree|ok/i.test(b.textContent));
      if (accept) accept.click();
    });
  } catch (e) { /* ignore */ }

  // 4. Check each BL
  const updates  = [];
  const changes  = [];
  const now      = new Date().toLocaleString("en-GB", {hour12:false,day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"}).replace(","," ").slice(0,16);

  for (const row of rows) {
    console.log(`\n[${rows.indexOf(row)+1}/${rows.length}] Checking: ${row.bl}  (code: ${row.searchBL})`);

    const scraped = await scrapeOneLine(page, row.searchBL);

    let newStatus = row.prevStatus || "In Transit";
    let note      = "";

    if (scraped && scraped.length > 0) {
      const latest = scraped[0];   // use first container row
      newStatus = mapStatus(latest.eventStatus, latest.latestPlace);
      note      = [latest.eventStatus, latest.latestPlace].filter(Boolean).join(" · ").slice(0, 120);
      console.log(`   Status: ${latest.eventStatus} @ ${latest.latestPlace} → mapped to: ${newStatus}`);
    } else {
      console.log("   No data returned from ONE Line");
    }

    updates.push({ rowIndex: row.rowIndex, newStatus, timestamp: now, note });

    // Track status changes for email alert
    if (row.prevStatus && row.prevStatus !== newStatus) {
      console.log(`   🔔 STATUS CHANGED: ${row.prevStatus} → ${newStatus}`);
      changes.push({ ...row, newStatus, note });
    }

    // Polite delay between requests (3 seconds)
    await new Promise(r => setTimeout(r, 3000));
  }

  await browser.close();
  console.log("\n✅ Browser closed");

  // 5. Write updates to Google Sheets
  console.log("\n📊 Updating Google Sheets...");
  await updateSheet(sheets, updates);

  // 6. Send alert email if statuses changed
  if (changes.length > 0) {
    console.log(`\n📧 Sending alert for ${changes.length} status change(s)...`);
    await sendAlertEmail(changes);
  } else {
    console.log("\n✅ No status changes detected");
  }

  console.log("\n" + "═".repeat(60));
  console.log(`  DONE — ${updates.length} shipments checked, ${changes.length} changes`);
  console.log("═".repeat(60));
}

main().catch(err => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
