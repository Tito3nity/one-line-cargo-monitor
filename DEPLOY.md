# Migration: Netlify → Render (API) + GitHub Pages (dashboard)

Your dashboard is split into two free pieces:

- **Dashboard (static page)** → GitHub Pages
- **Live tracking proxy** → Render free web service (replaces the dead Netlify function)

The Google Sheet sync and the GitHub Actions scraper are unchanged.

---

## Files in this bundle

| File | Goes where in your repo | Purpose |
|------|-------------------------|---------|
| `server/index.js` | `server/index.js` | ONE Line proxy (was `netlify/functions/track.js`) |
| `server/package.json` | `server/package.json` | Express dependency + Node engine |
| `server/.gitignore` | `server/.gitignore` | Keep `node_modules` out of git |
| `render.yaml` | repo root | One-click Render Blueprint deploy |
| `index.html` | repo root (replaces existing) | `TRACK_API` now points at Render |
| `.github/workflows/deploy-pages.yml` | `.github/workflows/` | Publishes `index.html` to GitHub Pages |

---

## Step 1 — Add these files to your repo

Copy the files above into your `one-line-cargo-monitor` repo (overwrite `index.html`),
then commit and push to `main`.

## Step 2 — Deploy the API on Render

1. Go to https://dashboard.render.com → **New** → **Blueprint**.
2. Connect your GitHub and select `one-line-cargo-monitor`.
3. Render reads `render.yaml` and creates a free web service named `one-line-tracker-api`.
4. Click **Apply**. First build takes ~2-3 min.
5. Copy the live URL, e.g. `https://one-line-tracker-api.onrender.com`.

> If Render's default name differs, your URL will differ too — note the real one.

**Verify it works:** open `https://YOUR-SERVICE.onrender.com/api/track?action=ping`
→ should return `{"ok":true}`. (First hit after idle waits ~30-60s — that's the free-tier cold start.)

## Step 3 — Point the dashboard at your Render URL

If your Render URL is **not** exactly `https://one-line-tracker-api.onrender.com`,
edit `index.html` and change this line near the top of the `<script>` block:

```js
const DEFAULT_TRACK_API = 'https://one-line-tracker-api.onrender.com/api/track';
```

…to your actual URL (keep the `/api/track` suffix). Commit and push.

> No-code alternative: in the browser console on the live page, run
> `localStorage.setItem('one_track_api','https://YOUR-SERVICE.onrender.com/api/track')`
> then reload. This overrides the default without editing code.

## Step 4 — Turn on GitHub Pages

1. Repo → **Settings** → **Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Push to `main` (or run the *Deploy dashboard to GitHub Pages* workflow manually
   under the **Actions** tab).
4. Your dashboard goes live at `https://tito3nity.github.io/one-line-cargo-monitor/`.

---

## What changed vs. the old setup

- `TRACK_API` was `/api/track` (Netlify same-origin). It's now the absolute Render URL.
- A wake-up ping fires on page load so Render is warming during reading time.
- The proxy logic is byte-for-byte identical in behaviour — same endpoints, same
  headers, same status mapping.

## Tradeoffs to know

- **Cold start:** free Render services sleep after 15 min idle; first request then
  takes ~30-60s. After that it's fast.
- **Credit card:** Render's free tier generally needs no card, but some accounts/regions
  get prompted for a $1 verification (refunded). If that blocks you, the zero-card
  fallback is scraper → Google Sheet → GitHub Pages reads the sheet (no instant
  per-click tracking). Ask and I'll build that variant.
