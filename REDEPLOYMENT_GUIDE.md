# Kiin Fieldbook: backup and redeployment guide

Backup taken 15 Oct 2026 from the artifact "Fieldbook"
(https://claude.ai/artifact/JVWTy8x7zMcZ8vzYjrmdfo).

## 1. What is in this package

| Path | What it is |
|---|---|
| `app/index.html` | The whole application: one 335 KB file (HTML, CSS, JavaScript, React from a CDN). |
| `db/database.json` | Full database dump: 11 collections, 157 documents. This is the file you restore from. |
| `db/*.csv` | The same data per collection, for reading in Excel. Not used for restore. `secure` and `settings` are left out on purpose (they hold sign-in hashes). |
| `selfhost/server.js` | A Hono server on Node that serves the page, database API, and live updates. |
| `selfhost/shim.js` | Browser adapter that makes the page talk to that server. |
| `Dockerfile`, `docker-compose.yml`, `.env.example` | One-command deployment. |

Document counts: accounts 85, activities 20, followups 16, logs 20, stagehistory 6,
requests 3, settings 3, campaigns 1, quotes 1, sessions 1, secure 1.
Empty at backup time: commitments, leads, customers, templates.

NOT included: the separate "encrypted tracker" version. Its records are encrypted and
live in another artifact. Back that one up on its own.

## 2. How the app stores data (why you need a backend)

The page does not save anything itself. It calls two Claude-runtime services:

- `claude.use("db")`: a document database with `doc(path).get/set/update/delete/onSnapshot`
  and `collection(name).add/limit/onSnapshot`. Collections used: accounts, activities,
  followups, commitments, leads, customers, templates, campaigns, quotes, stagehistory,
  requests, sessions, logs, settings, secure.
- `claude.use("downloads")`: the save-to-disk prompt for CSV, JSON and PDF exports.

Outside Claude those do not exist, so the page shows "Saved data isn't reachable".
Path A keeps them (Claude provides them). Path B supplies replacements.

## 3. Path A: republish as a Claude artifact (easiest, same behaviour)

Use this if you still have a Claude account and want it exactly as it was.

1. Start a chat in Claude and attach `app/index.html` and `db/database.json`.
2. Ask: "Publish app/index.html as an artifact, then import database.json into its database,
   one write per document, keeping the document ids."
3. Claude publishes the page and writes each document (collections are in `database.json`
   under `collections.<name>.<id>`).
4. Open the new link and check the counts: 85 accounts, 20 touchpoints.
5. Sharing is private to you until you choose to share it.

Notes: the artifact database has a shared size cap and owner-only write rules, which is
what stops guests from approving themselves. Path A keeps that protection.

## 4. Path B: self-host on your own server

### 4.1 Requirements

- Node 22.13+ (built-in SQLite support) or Docker.
- For a plain Node deployment, install the server dependencies with `npm ci` before starting it.
- HTTPS in front of it. The sign-in code hashing uses the browser's `crypto.subtle`,
  which only works on `https://` or `http://localhost`. Plain `http://yourserver` will fail.
- Outbound internet in the browser for Google Fonts and cdnjs (React, jsPDF).
  For fully offline use, download those files and edit the `<script>`/`<link>` tags.

### 4.2 Run with Docker

```bash
cd kiin-fieldbook-backup
cp .env.example .env
# put a long random value after ADMIN_KEY=   (openssl rand -hex 24)
docker compose up -d --build
```

Open `http://localhost:8080/#key=YOUR_ADMIN_KEY` once. The key is kept for that tab only,
then removed from the address bar. SQLite data lives in `/data/fieldbook.sqlite` in the
`fieldbook-data` Docker volume. On the first SQLite startup, the server imports an existing
`/data/store.json`; if there is no legacy store, it imports the packaged database dump.

### 4.3 Run with plain Node

```bash
cd kiin-fieldbook-backup
npm ci
npm start
```

The root `.env` file supplies `ADMIN_KEY`; `npm start` loads it and starts the API with
terminal request logs at `http://localhost:3000`. Open
`http://localhost:3000/#key=YOUR_ADMIN_KEY` to sign in. The default SQLite database is
`selfhost/data/fieldbook.sqlite` (override with `DB_FILE=/path/fieldbook.sqlite`).

On first SQLite startup, the server imports `selfhost/data/store.json` if present; otherwise
it seeds itself from `db/database.json`. For an intentional fresh restore, back up and remove
the SQLite database file while the server is stopped, then start it again. The old JSON file
is left in place as a backup and is imported only when the SQLite file does not yet exist.
For an existing Docker volume, `store.json` is imported once into the new SQLite database.

### 4.4 Put HTTPS in front (Caddy example)

```
fieldbook.example.com {
    reverse_proxy localhost:8080
}
```

Caddy gets the certificate automatically. Nginx and Cloudflare Tunnel work equally well.
Do not buffer the `/api/stream/` path (live updates use server-sent events); in nginx add
`proxy_buffering off;` for it.

### 4.5 Hosting options

Any machine that keeps a disk: a small VPS (Hetzner, DigitalOcean), a home server,
Fly.io or Railway with a volume. Free hosts that wipe the disk on restart (for example
Render free tier) will lose your data unless you attach persistent storage.

### 4.6 First-login checklist

1. Open the owner link with `#key=...`.
2. Choose Admin and sign in with your admin code (see section 6).
3. Confirm the Accounts page shows 85 accounts.
4. Add a test touchpoint, reload, confirm it stayed.
5. Export a CSV and a quote PDF to confirm downloads work.

## 5. Security: what Path B does and does not enforce

Enforced by `server.js`:
- Writes need the owner key, except guests may write documents in the `requests` collection.
- The `secure` collection (admin code hash) is readable only with the owner key.

Not enforced, and different from Path A:
- Anyone who can reach the server can read every collection except `secure`, because the
  page's own gate runs in the browser. Treat the URL as private, or protect the whole site
  with a reverse-proxy login (Caddy `basicauth`, Cloudflare Access, a VPN).
- Guest request IDs are browser-generated and are not independently authenticated by the
  API. Protect the site with a reverse-proxy login if request data must be private.
- The owner key is a single shared secret. Rotate it by changing `ADMIN_KEY` and restarting.
- The guest approval system (Guest/Admin choice, watermark) still runs, but it is a
  courtesy layer, not a security boundary.

## 6. Secrets in this package: read before you share it

`db/database.json` contains `secure/admin` and `settings/guestauth`: salted hashes of
your admin code and guest code. They are not the codes, but they can be attacked offline.
Also contained: customer names, phone numbers and emails. Store the package like you
would store the customer list. Do not put it in a public GitHub repository.

`app/index.html` still has placeholder defaults near the top: `ADMIN_CODE =
"kiin-admin-change-me"` and `GUEST_CODE = "kiin-guest-change-me"`. The codes you actually
use are the ones stored (hashed) in the database, which is why the restore carries them.
If you start from an empty database those placeholders become live, so change the admin
code immediately in the console.

## 7. Routine backups after you are running

- Path B: back up `fieldbook.sqlite` nightly. Stop the server before copying the file so
  SQLite can checkpoint its write-ahead log; restart it after the copy.
- Path A: ask Claude to export the database again, or re-run this process.

## 8. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "Saved data isn't reachable in this view" | The shim did not load. Open `/` from the server, not the raw `index.html` file. |
| Admin sign-in fails or does nothing | Not on HTTPS (`crypto.subtle` missing), or you did not open the `#key=` link. |
| Admin sign-in says "owner key required" | Open the owner link with `#key=<ADMIN_KEY>`; a configured admin code is checked against a protected database record. |
| Edits do not save | Banner says owner only: you are in a tab without the key. Reopen the `#key=` link. |
| Changes appear only after reload | Proxy is buffering the event stream. Disable buffering for `/api/stream/`. |
| Server exits at start | `ADMIN_KEY` missing or under 12 characters. |
| Fonts look different | Google Fonts blocked. Allow `fonts.googleapis.com` or self-host the fonts. |

API requests are logged to the server terminal with method, path, response status,
duration, and client address. Requests taking at least one second are marked `api:slow`;
event streams log when they open and close. Credentials and request bodies are not logged.
Browser API calls time out after 15 seconds with an endpoint-specific error. SQLite data
changes are written per document in transactions, and updates are pushed to open event
streams.

## 9. What was and was not tested

The Hono server uses the Node adapter and Node's built-in SQLite support. The Docker image
installs its locked HTTP dependencies during build.

Tested here: the server (seeding from the dump, owner and guest permissions, add, update,
delete, live stream, persistence across restart) with curl.
Not tested: the page itself running in a browser against the server, Docker build, and
HTTPS setups. Do the first-login checklist in 4.6 before relying on it.
