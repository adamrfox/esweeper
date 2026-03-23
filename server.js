/**
 * IMAP Email Cleaner — Backend Server
 * Run: npm install express imap cors && node server.js
 * Served via nginx at http://localhost:80 -> proxied to :3002
 */

const express = require("express");
const Imap    = require("imap");
const cors    = require("cors");
const path    = require("path");

// Prevent any single IMAP event from crashing the server
process.on("uncaughtException",  (err) => console.error("[server] uncaughtException:", err.message));
process.on("unhandledRejection", (err) => console.error("[server] unhandledRejection:", err));

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.dirname(__filename)));

// ── helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sseStream(res) {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();
  return {
    send: (type, payload) => res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`),
    end:  ()              => res.end(),
  };
}

const RATE = { baseDelay: 300, backoffFactor: 2, maxDelay: 30000, jitter: 150 };

function buildSearchCriteria(ageVal, ageUnit, readStatus) {
  const now    = new Date();
  const cutoff = new Date(now);
  if      (ageUnit === "days")   cutoff.setDate(now.getDate() - ageVal);
  else if (ageUnit === "weeks")  cutoff.setDate(now.getDate() - ageVal * 7);
  else if (ageUnit === "months") cutoff.setMonth(now.getMonth() - ageVal);
  else if (ageUnit === "years")  cutoff.setFullYear(now.getFullYear() - ageVal);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const before = `${cutoff.getDate()}-${months[cutoff.getMonth()]}-${cutoff.getFullYear()}`;
  const criteria = [["BEFORE", before]];
  if (readStatus === "unread") criteria.push("UNSEEN");
  if (readStatus === "read")   criteria.push("SEEN");
  return criteria;
}

function makeImap(cfg) {
  return new Imap({
    user:       cfg.user,
    password:   cfg.password,
    host:       cfg.host,
    port:       parseInt(cfg.port) || (cfg.tls ? 993 : 143),
    tls:        !!cfg.tls,
    tlsOptions: { rejectUnauthorized: false },
    connTimeout: 30000,
    authTimeout: 30000,
    keepalive:  { interval: 10000, idleInterval: 30000, forceNoop: true },
  });
}

// ── Shared connection pool ────────────────────────────────────────────────────
// One persistent IMAP connection per user@host — avoids hitting concurrent
// connection limits on the mail server.

const pool = new Map(); // key -> { imap, busy }

function poolKey(cfg) {
  return `${cfg.user}@${cfg.host}:${parseInt(cfg.port) || (cfg.tls ? 993 : 143)}`;
}

const CONN_RETRIES  = 5;
const CONN_BACKOFF  = [1000, 2000, 4000, 8000, 16000]; // ms between attempts

function isTransientError(err) {
  const msg = (err && err.message) || String(err);
  return /ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|socket|closed|read |write /i.test(msg);
}

// Opens a fresh IMAP connection, with retry/backoff on transient errors.
function openConnection(cfg) {
  return new Promise((resolve, reject) => {
    const key = poolKey(cfg);
    const imap = makeImap(cfg);

    imap.once("ready", () => {
      console.log(`[pool] ready: ${key}`);
      pool.set(key, { imap });

      // Keep the pool clean if this connection later drops
      const cleanup = () => {
        if (pool.get(key)?.imap === imap) {
          console.log(`[pool] connection lost: ${key}`);
          pool.delete(key);
        }
      };
      imap.on("error", (err) => { console.error(`[pool] error: ${key}:`, err.message); cleanup(); });
      imap.on("end",   cleanup);
      imap.on("close", cleanup);

      resolve(imap);
    });

    imap.once("error", (err) => {
      console.error(`[pool] connect error on ${key}:`, err.message);
      pool.delete(key);
      reject(err);
    });

    imap.connect();
  });
}

async function getConnection(cfg) {
  const key   = poolKey(cfg);
  const entry = pool.get(key);

  // Reuse existing live connection
  if (entry && entry.imap.state !== "disconnected") {
    console.log(`[pool] reusing: ${key}`);
    return entry.imap;
  }

  if (entry) pool.delete(key);

  // Attempt connection with retry/backoff
  let lastErr;
  for (let attempt = 0; attempt < CONN_RETRIES; attempt++) {
    if (attempt > 0) {
      const wait = CONN_BACKOFF[Math.min(attempt - 1, CONN_BACKOFF.length - 1)];
      console.log(`[pool] retry ${attempt}/${CONN_RETRIES - 1} in ${wait}ms for ${key}`);
      await sleep(wait);
    }
    try {
      return await openConnection(cfg);
    } catch (err) {
      lastErr = err;
      if (isTransientError(err)) {
        console.warn(`[pool] transient error on attempt ${attempt + 1}: ${err.message}`);
      } else {
        // Non-transient (auth failure, bad hostname) — don't retry
        throw err;
      }
    }
  }
  throw lastErr;
}

function closeConnection(cfg) {
  const key   = poolKey(cfg);
  const entry = pool.get(key);
  if (entry) {
    try { entry.imap.end(); } catch (_) {}
    pool.delete(key);
    console.log(`[pool] closed: ${key}`);
  }
}

// ── POST /api/connect ─────────────────────────────────────────────────────────
app.post("/api/connect", async (req, res) => {
  const cfg = req.body;
  console.log(`[connect] ${cfg.user}@${cfg.host}`);
  try {
    await getConnection(cfg);
    res.json({ ok: true });
  } catch (err) {
    const msg = err.message || String(err);
    const hint =
      /ECONNREFUSED/.test(msg) ? msg + " — nothing is listening on that host/port" :
      /ENOTFOUND/.test(msg)    ? msg + " — hostname not found, check spelling"     :
      /ETIMEDOUT/.test(msg)    ? msg + " — connection timed out"                   :
      /auth|login|cred/i.test(msg) ? msg + " — authentication failed"              : msg;
    console.error(`[connect] failed:`, hint);
    res.json({ ok: false, error: hint });
  }
});

// ── POST /api/folders ─────────────────────────────────────────────────────────
app.post("/api/folders", async (req, res) => {
  const cfg = req.body;
  try {
    const imap = await getConnection(cfg);
    imap.getBoxes((err, boxes) => {
      if (err) return res.json({ ok: false, error: err.message });
      const folders = [];
      const flatten = (obj, prefix) => {
        if (!obj || typeof obj !== "object") return;
        for (const [name, box] of Object.entries(obj)) {
          if (name === "parent") continue;          // skip circular back-reference
          const sep  = (box && box.delimiter) || "/";
          const full = prefix ? `${prefix}${sep}${name}` : name;
          folders.push(full);
          if (box && box.children && typeof box.children === "object") {
            flatten(box.children, full);
          }
        }
      };
      flatten(boxes, "");
      folders.sort();
      console.log("[folders] found:", folders);
      res.json({ ok: true, folders });
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── GET /api/scan ─────────────────────────────────────────────────────────────
app.get("/api/scan", async (req, res) => {
  const { host, port, tls, user, password, folder, ageVal, ageUnit, readStatus } = req.query;
  const cfg = { host, port, tls: tls === "true", user, password };
  const { send } = sseStream(res);

  console.log(`[scan] ${user}@${host} folder=${folder}`);
  send("status", { message: "connecting…" });

  let imap;
  try {
    imap = await getConnection(cfg);
  } catch (err) {
    send("error", { message: err.message });
    res.end();
    return;
  }

  send("status", { message: "connected — opening folder…" });

  imap.openBox(folder || "INBOX", true, (err) => {
    if (err) { send("error", { message: err.message }); res.end(); return; }

    send("status", { message: "searching for matching messages…" });
    const criteria = buildSearchCriteria(parseInt(ageVal) || 30, ageUnit || "days", readStatus || "all");
    console.log(`[scan] criteria:`, JSON.stringify(criteria));

    imap.search(criteria, (err, uids) => {
      if (err) { send("error", { message: err.message }); res.end(); return; }
      console.log(`[scan] found ${uids ? uids.length : 0} UIDs`);

      if (!uids || uids.length === 0) {
        send("done", { total: 0 });
        res.end();
        return;
      }

      send("total", { count: uids.length });

      const allEmails = [];
      let   remaining = [...uids];

      const fetchBatch = () => {
        const batch = remaining.splice(0, 50);
        if (batch.length === 0) {
          const totalSize = allEmails.reduce((s, e) => s + (e.size || 0), 0);
          console.log(`[scan] complete — ${allEmails.length} emails, ${totalSize} bytes`);
          send("done", { total: uids.length, totalSize });
          res.end();
          return;
        }

        console.log(`[scan] fetching batch of ${batch.length}, ${remaining.length} remaining`);
        const f = imap.fetch(batch, {
          bodies: ["HEADER.FIELDS (FROM SUBJECT DATE)"],
          struct: false,
          size:   true,
        });

        f.on("message", (msg) => {
          const email = { uid: null, from: "", subject: "", date: "", size: 0, read: false };
          let headerDone = false, attrDone = false;

          const tryEmit = () => {
            if (headerDone && attrDone) { allEmails.push(email); send("email", email); }
          };

          msg.on("attributes", (attrs) => {
            email.uid  = attrs.uid;
            email.size = attrs.size || 0;
            email.read = !!(attrs.flags && attrs.flags.includes("\\Seen"));
            attrDone   = true;
            tryEmit();
          });

          msg.on("body", (stream) => {
            let buf = "";
            stream.on("data", c => { buf += c.toString(); });
            stream.once("end", () => {
              email.from    = (buf.match(/^From:\s*(.+)$/mi)    || [])[1]?.trim().slice(0, 80)  || "(no sender)";
              email.subject = (buf.match(/^Subject:\s*(.+)$/mi) || [])[1]?.trim().slice(0, 100) || "(no subject)";
              email.date    = (buf.match(/^Date:\s*(.+)$/mi)    || [])[1]?.trim()               || "";
              headerDone    = true;
              tryEmit();
            });
          });
        });

        f.once("end",   fetchBatch);
        f.once("error", (e) => { send("error", { message: e.message }); res.end(); });
      };

      fetchBatch();
    });
  });
});

// ── POST /api/delete ──────────────────────────────────────────────────────────
app.post("/api/delete", async (req, res) => {
  const { host, port, tls, user, password, folder, uids: uidsParam } = req.body;
  const cfg = { host, port, tls: !!tls, user, password };
  const { send, end } = sseStream(res);

  const allUids = (Array.isArray(uidsParam) ? uidsParam : String(uidsParam || "").split(","))
    .map(Number).filter(Boolean);

  console.log(`[delete] ${allUids.length} UIDs, folder=${folder}`);
  if (allUids.length === 0) { send("error", { message: "No UIDs provided" }); end(); return; }

  // Delete gets its own fresh connection — don't share with scan/browse
  closeConnection(cfg);

  let deleted         = 0;
  let rateLimitHits   = 0;
  let delay           = RATE.baseDelay;
  let remaining       = [...allUids];
  let sinceExpunge    = 0;
  const EXPUNGE_EVERY = 500;
  const MAX_RECONNECTS = 10;
  let reconnects      = 0;

  const runDelete = () => new Promise((resolve, reject) => {
    const imap = makeImap(cfg);

    imap.on("error", (err) => {
      console.error(`[delete] imap error:`, err.message);
      reject(err);
    });

    imap.once("ready", () => {
      console.log(`[delete] connected, opening ${folder || "INBOX"}`);
      imap.openBox(folder || "INBOX", false, async (err) => {
        if (err) { reject(err); return; }
        console.log(`[delete] box open — ${remaining.length} remaining`);
        send("status", { message: `starting deletion — ${remaining.length} messages…` });

        while (remaining.length > 0) {
          const uid     = remaining[0];
          let   success = false;
          let   retries = 0;

          while (!success && retries < 5) {
            await sleep(delay + Math.random() * RATE.jitter);
            try {
              await new Promise((res2, rej2) => {
                imap.addFlags(uid, "\\Deleted", (e) => e ? rej2(e) : res2());
              });

              remaining.shift();
              success = true;
              deleted++;
              sinceExpunge++;
              delay = Math.max(RATE.baseDelay, delay * 0.9);

              if (deleted % 100 === 0)
                console.log(`[delete] ${deleted}/${allUids.length} (${remaining.length} left)`);

              send("deleted", { uid, deleted, total: allUids.length, delay: Math.round(delay) });

              // Periodic expunge
              if (sinceExpunge >= EXPUNGE_EVERY) {
                console.log(`[delete] periodic expunge at ${deleted}…`);
                send("status", { message: `expunging batch (${deleted}/${allUids.length} done)…` });
                await new Promise(r => imap.expunge(e => {
                  if (e) console.warn(`[delete] periodic expunge warning:`, e.message);
                  r();
                }));
                sinceExpunge = 0;
              }

            } catch (err) {
              const msg = err.message || String(err);
              const isConnDrop  = /ECONNRESET|EPIPE|socket|closed|timeout/i.test(msg);
              const isRateLimit = /rate|too many|slow down|THROTTL|\[UNAVAILABLE\]/i.test(msg);

              if (isConnDrop) {
                console.warn(`[delete] connection dropped at UID ${uid}: ${msg}`);
                send("ratelimit", { uid, retryIn: 3000, hits: ++rateLimitHits, message: "Connection dropped — reconnecting…" });
                try { imap.destroy(); } catch (_) {}
                reject(new Error("RECONNECT"));
                return;
              } else if (isRateLimit) {
                rateLimitHits++;
                delay = Math.min(delay * RATE.backoffFactor, RATE.maxDelay);
                const secs = (delay / 1000).toFixed(1);
                console.warn(`[delete] rate limit #${rateLimitHits} on UID ${uid}, backing off ${secs}s`);
                send("ratelimit", { uid, retryIn: Math.round(delay), hits: rateLimitHits, message: `Rate limited — waiting ${secs}s` });
                await sleep(delay);
              } else {
                console.error(`[delete] error on UID ${uid}:`, msg);
                send("error", { uid, message: msg.slice(0, 80) });
                remaining.shift();
                break;
              }
              retries++;
            }
          }

          if (!success && retries >= 5) {
            console.warn(`[delete] UID ${uid} skipped after max retries`);
            send("skipped", { uid, reason: "max retries exceeded" });
            remaining.shift();
          }
        }

        // Final expunge
        console.log(`[delete] final expunge…`);
        send("status", { message: "final expunge…" });
        imap.expunge((e) => {
          if (e) send("warning", { message: `Expunge warning: ${e.message}` });
          imap.end();
          resolve();
        });
      });
    });

    imap.connect();
  });

  // Outer reconnect loop
  while (remaining.length > 0 && reconnects <= MAX_RECONNECTS) {
    try {
      await runDelete();
      break;
    } catch (err) {
      if (err.message === "RECONNECT" && remaining.length > 0) {
        reconnects++;
        const wait = Math.min(3000 * reconnects, 30000);
        console.log(`[delete] reconnect #${reconnects} in ${wait}ms, ${remaining.length} left`);
        send("ratelimit", { retryIn: wait, hits: rateLimitHits, message: `Reconnecting (attempt ${reconnects})… ${remaining.length} messages left` });
        await sleep(wait);
      } else {
        send("error", { message: err.message });
        break;
      }
    }
  }

  console.log(`[delete] complete — ${deleted}/${allUids.length} deleted, ${reconnects} reconnects`);
  send("done", { deleted, total: allUids.length, rateLimitHits });
  end();
});

// ── start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`\n✓ IMAP Email Cleaner running at http://localhost:${PORT}`);
  console.log(`  (proxied via nginx at http://localhost:80)\n`);
});

