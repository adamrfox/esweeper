# IMAP Email Cleaner

A self-hosted web tool for cleaning up large IMAP mailboxes. Scan, preview, bulk-delete, and archive old emails — with live progress, rate-limit handling, automatic reconnection, and mbox export.

Built for internal use on a local network. Credentials never leave your machine.

---

## Features

- **Flexible filtering** — find emails older than N days/weeks/months/years, or between two specific dates
- **Folder selection** — dynamically loads all folders from the mail server
- **Read status filter** — all, unread only, or read only
- **Scan preview** — see sender, subject, date and size before deleting anything
- **Sortable columns** — click any column header to sort the preview
- **Bulk delete** — flags and expunges messages in batches with live progress
- **mbox archive** — download matching messages as a standard `.mbox` file before deleting
- **Rate-limit handling** — exponential backoff when the server throttles requests
- **Auto-reconnect** — resumes from where it left off if the IMAP connection drops
- **Works with any IMAP server** — Gmail, Yahoo (app password required), purelymail, Dovecot, etc.

---

## Architecture

```
Browser (index.html)
      │  HTTP / SSE  (port 80 or 443)
      ▼
nginx  ──────────────────────────────────────────────
      │  proxy_pass  (127.0.0.1:3002)
      ▼
server.js  (Node.js / Express)
      │  IMAP over TLS  (port 993)
      ▼
Mail server
```

The browser never touches IMAP directly. The Node server maintains a persistent connection pool and handles all mail operations. Credentials are only ever sent to `localhost`.

---

## Requirements

- Node.js 18+
- nginx
- An IMAP-enabled mail account

---

## Installation

```bash
# Clone the repository
git clone https://github.com/adamrfox/esweeper
cd esweeper

# Install dependencies
npm install
```

---

## Configuration

### 1. nginx

Copy the nginx config and reload:

```bash
sudo cp imap-cleaner.nginx.conf /etc/nginx/sites-available/imap-cleaner
sudo ln -s /etc/nginx/sites-available/imap-cleaner /etc/nginx/sites-enabled/
sudo nginx -t && sudo nginx -s reload
```

By default the config listens on port **80** and proxies to Node on **3002**.

#### HTTPS (recommended — required for the file save picker)

Generate a self-signed certificate:

```bash
sudo mkdir -p /etc/nginx/ssl
sudo openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/imap-cleaner.key \
  -out    /etc/nginx/ssl/imap-cleaner.crt \
  -subj   "/CN=<your-server-ip>"
```

Then switch to the HTTPS nginx config (uncomment the SSL server block and add a redirect from port 80). Reload nginx after.

When accessing over HTTPS, the browser will show a certificate warning on first visit — click **Advanced → Proceed**. After that, the file save picker will work when archiving.

### 2. Start the server

```bash
node server.js
```

You should see:
```
✓ IMAP Email Cleaner running at http://localhost:3002
```

### 3. Open the tool

Navigate to `http://<your-server-ip>` (or `https://` if you set up SSL).

---

## Running as a service with PM2

```bash
npm install -g pm2

pm2 start server.js --name imap-cleaner
pm2 save
pm2 startup   # follow the printed instructions to enable boot persistence
```

Useful commands:

```bash
pm2 status                        # check if running
pm2 logs imap-cleaner             # live log output
pm2 logs imap-cleaner --lines 100 # last 100 lines
pm2 restart imap-cleaner          # restart after updating server.js
pm2 stop imap-cleaner
```

---

## Usage

### Connect

Enter your IMAP server hostname, port (993 for TLS, 143 for plain), and credentials. Click **connect**. Once connected, click **load folders** to populate the folder dropdown.

**Yahoo Mail** requires an app-specific password — your regular Yahoo password will not work. Generate one at myaccount.yahoo.com → Security → App passwords.

### Scan

Choose your filter:

- **Older than** — finds messages older than N days, weeks, months, or years
- **Between dates** — finds messages between two specific dates

Select a folder, set the read status filter, and click **scan**. A live preview table populates as headers arrive from the server, showing sender, subject, date, and size. The scan will automatically reconnect and resume if the connection drops mid-way through a large mailbox.

### Sort

Click any column header (From, Subject, Date, Size) to sort the preview. Click again to reverse the direction.

### Archive

Click **archive to mbox →** to download matching messages as a `.mbox` file before deleting. The server writes the archive to a temporary file on disk while streaming live progress to the browser. When complete:

- On **HTTPS**: the browser's native file save dialog lets you choose the location and filename.
- On **HTTP**: the file downloads to your browser's default downloads folder.

The `.mbox` format is compatible with Thunderbird, Apple Mail, mutt, and most other mail clients and archiving tools.

### Delete

Click **delete all →** to permanently remove all scanned messages. Messages are flagged `\Deleted` in batches and expunged periodically. Live progress shows the count and estimated rate. Click **stop** at any time to halt mid-run — messages already deleted will remain deleted.

The delete operation handles:
- **Rate limiting** — backs off exponentially and retries when the server throttles requests
- **Connection drops** — reconnects automatically and resumes from where it left off
- **Large mailboxes** — tested with 70,000+ message jobs

---

## Project files

| File | Purpose |
|---|---|
| `server.js` | Express backend — all IMAP operations, SSE streaming |
| `index.html` | Single-file frontend — no build step required |
| `package.json` | Node dependencies |
| `imap-cleaner.nginx.conf` | nginx reverse proxy config |
| `.gitignore` | Excludes `node_modules/` |

---

## Notes

- Tested against **purelymail** and **Yahoo Mail** (with app password)
- The `imap` npm package (`node-imap`) is used for all IMAP operations
- mbox archives are written to the system temp directory and deleted automatically after download
- The IMAP connection pool keeps one persistent connection per account to avoid hitting concurrent connection limits

