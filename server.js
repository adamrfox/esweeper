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

// Rejects if the given promise doesn't settle within ms milliseconds
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`TIMEOUT: ${label} (${ms}ms)`));
    }, ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e);  }
    );
  });
}

function sseStream(res) {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  // Heartbeat keeps nginx and browser from closing an idle SSE connection
  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch (_) {}
  }, 15000);

  return {
    send: (type, payload) => {
      try { res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`); } catch (_) {}
    },
    end: () => {
      clearInterval(heartbeat);
      res.end();
    },
  };
}

const RATE = { baseDelay: 300, backoffFactor: 2, maxDelay: 30000, jitter: 150 };

function imapDate(d) {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d.getDate()}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

// mode: "older" | "between"
// older:   ageVal + ageUnit
// between: dateFrom + dateTo (ISO date strings)
function buildSearchCriteria({ mode, ageVal, ageUnit, dateFrom, dateTo, readStatus }) {
  const criteria = [];

  if (mode === "between") {
    // IMAP SINCE is inclusive, BEFORE is exclusive — add one day to dateTo
    const from = new Date(dateFrom);
    const to   = new Date(dateTo);
    to.setDate(to.getDate() + 1);
    criteria.push(["SINCE",  imapDate(from)]);
    criteria.push(["BEFORE", imapDate(to)]);
  } else {
    // Default: older than N units
    const now    = new Date();
    const cutoff = new Date(now);
    if      (ageUnit === "days")   cutoff.setDate(now.getDate() - ageVal);
    else if (ageUnit === "weeks")  cutoff.setDate(now.getDate() - ageVal * 7);
    else if (ageUnit === "months") cutoff.setMonth(now.getMonth() - ageVal);
    else if (ageUnit === "years")  cutoff.setFullYear(now.getFullYear() - ageVal);
    criteria.push(["BEFORE", imapDate(cutoff)]);
  }

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

  const { dateFrom, dateTo, filterMode } = req.query;
  const criteria = buildSearchCriteria({
    mode:       filterMode || "older",
    ageVal:     parseInt(ageVal) || 30,
    ageUnit:    ageUnit || "days",
    dateFrom:   dateFrom || "",
    dateTo:     dateTo   || "",
    readStatus: readStatus || "all",
  });

  // State that persists across reconnects
  let allUids    = null;   // set after first successful search
  let allEmails  = [];
  let remaining  = null;   // UIDs not yet fetched
  let reconnects = 0;
  const MAX_SCAN_RECONNECTS = 20;
  const RECONNECT_WAIT      = 10000;

  const runScan = () => new Promise((resolve, reject) => {
    // Always open a fresh connection for scan — don't share with pool
    const imap = makeImap(cfg);

    imap.on("error", (err) => {
      console.error(`[scan] imap error:`, err.message);
      reject(err);
    });

    imap.once("ready", () => {
      send("status", { message: "connected — opening folder…" });
      imap.openBox(folder || "INBOX", true, (err) => {
        if (err) { reject(err); return; }
        send("status", { message: "searching for matching messages…" });

        // Only search on first connect — subsequent reconnects reuse the UID list
        const doSearch = (cb) => {
          if (allUids !== null) { cb(null, allUids); return; }
          imap.search(criteria, (err, uids) => {
            if (err) { cb(err); return; }
            console.log(`[scan] found ${uids ? uids.length : 0} UIDs`);
            allUids   = uids || [];
            remaining = [...allUids];
            cb(null, allUids);
          });
        };

        doSearch((err, uids) => {
          if (err) { reject(err); return; }

          if (uids.length === 0) {
            send("done", { total: 0 });
            imap.end();
            resolve();
            return;
          }

          // On reconnect, remaining is already trimmed to unsent UIDs
          if (remaining === null) remaining = [...uids];
          send("total", { count: uids.length });

          const fetchBatch = () => {
            if (remaining.length === 0) {
              const totalSize = allEmails.reduce((s, e) => s + (e.size || 0), 0);
              console.log(`[scan] complete — ${allEmails.length} emails, ${totalSize} bytes`);
              send("done", { total: uids.length, totalSize });
              imap.end();
              resolve();
              return;
            }

            const batch = remaining.slice(0, 50);
            console.log(`[scan] fetching batch of ${batch.length}, first=${batch[0]}, last=${batch[batch.length-1]}, ${remaining.length} remaining`);

            // Ensure all UIDs are integers — malformed UIDs cause "Illegal arguments"
            const cleanBatch = batch.map(u => parseInt(u)).filter(n => !isNaN(n) && n > 0);
            if (cleanBatch.length === 0) {
              console.warn(`[scan] batch had no valid UIDs, skipping`);
              remaining.splice(0, batch.length);
              fetchBatch();
              return;
            }

            let batchDone = false;
            const f = imap.fetch(cleanBatch, {
              bodies: ["HEADER.FIELDS (FROM SUBJECT DATE)"],
              struct: false,
              size:   true,
            });

            f.on("message", (msg) => {
              const email = { uid: null, from: "", subject: "", date: "", size: 0, read: false };
              let headerDone = false, attrDone = false;

              const tryEmit = () => {
                if (headerDone && attrDone) {
                  allEmails.push(email);
                  // Remove this UID from remaining as we confirm it's fetched
                  const idx = remaining.indexOf(email.uid);
                  if (idx !== -1) remaining.splice(idx, 1);
                  send("email", email);
                }
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

            f.once("end", () => {
              // Any UIDs still in the batch that weren't emitted are left in
              // remaining for the next reconnect to retry
              batchDone = true;
              fetchBatch();
            });

            f.once("error", (e) => {
              console.error(`[scan] fetch error:`, e.message);
              if (isTransientError(e)) {
                reject(e); // triggers reconnect
              } else {
                send("error", { message: e.message });
                res.end();
              }
            });
          };

          fetchBatch();
        });
      });
    });

    imap.connect();
  });

  // Reconnect loop
  while (true) {
    try {
      await runScan();
      break; // completed cleanly
    } catch (err) {
      if (isTransientError(err) && reconnects < MAX_SCAN_RECONNECTS) {
        reconnects++;
        const fetched = allEmails.length;
        const total   = allUids ? allUids.length : "?";
        const left    = remaining ? remaining.length : "?";
        console.log(`[scan] reconnect #${reconnects} after error: ${err.message} — ${fetched}/${total} fetched, ${left} remaining`);
        send("status", { message: `Connection dropped — reconnecting (${fetched.toLocaleString()} fetched so far)…` });
        await sleep(RECONNECT_WAIT);
      } else {
        console.error(`[scan] giving up after ${reconnects} reconnects:`, err.message);
        send("error", { message: err.message });
        res.end();
        break;
      }
    }
  }
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

  let deleted          = 0;
  let rateLimitHits    = 0;
  let remaining        = [...allUids];
  let sinceExpunge     = 0;
  const BATCH_SIZE     = 100;   // flag this many UIDs per IMAP command
  const EXPUNGE_EVERY  = 1000;  // expunge after this many deletes
  const MAX_RECONNECTS = 50;    // keep retrying — large jobs need many reconnects
  let reconnects       = 0;

  const runDelete = () => new Promise((resolve, reject) => {
    const imap = makeImap(cfg);

    imap.on("error", (err) => {
      console.error(`[delete] imap error:`, err.message);
      // Only reject if we haven't already resolved/rejected
      reject(err);
    });

    imap.once("ready", () => {
      console.log(`[delete] connected, opening ${folder || "INBOX"}`);
      imap.openBox(folder || "INBOX", false, async (err) => {
        if (err) { reject(err); return; }
        console.log(`[delete] box open — ${remaining.length} remaining`);
        send("status", { message: `deleting — ${remaining.length} messages remaining…` });

        while (remaining.length > 0) {
          // Take a batch of UIDs and flag them all in one IMAP command
          const batch   = remaining.slice(0, BATCH_SIZE);
          let   success = false;
          let   retries = 0;

          while (!success && retries < 5) {
            try {
              // Pass batch as an array — node-imap addFlags() is UID-based
              // and accepts an array of UIDs as the message source
              await withTimeout(
                new Promise((res2, rej2) => {
                  imap.addFlags(batch, ["\\Deleted"], (e) => {
                    if (e) {
                      console.error(`[delete] addFlags error:`, e.message);
                      rej2(e);
                    } else {
                      res2();
                    }
                  });
                }),
                60000,
                `addFlags timed out for batch of ${batch.length}`
              );

              // Batch succeeded — remove from remaining
              remaining.splice(0, batch.length);
              success  = true;
              deleted += batch.length;
              sinceExpunge += batch.length;

              if (deleted % 500 === 0 || remaining.length === 0)
                console.log(`[delete] ${deleted}/${allUids.length} (${remaining.length} left)`);

              send("progress", { deleted, total: allUids.length, delay: 0 });

              // Small pause between batches to be a good IMAP citizen
              if (remaining.length > 0) await sleep(200 + Math.random() * 100);

              // Periodic expunge
              if (sinceExpunge >= EXPUNGE_EVERY) {
                console.log(`[delete] periodic expunge at ${deleted}…`);
                send("status", { message: `expunging (${deleted.toLocaleString()}/${allUids.length.toLocaleString()} done)…` });
                await withTimeout(
                  new Promise(r => imap.expunge(e => {
                    if (e) console.error(`[delete] expunge error:`, e.message);
                    else console.log(`[delete] expunge ok`);
                    r();
                  })),
                  60000,
                  "expunge timed out"
                );
                sinceExpunge = 0;
              }

            } catch (err) {
              const msg = err.message || String(err);
              const isConnDrop  = /ECONNRESET|EPIPE|socket|closed|timeout/i.test(msg);
              const isRateLimit = /rate|too many|slow down|THROTTL|\[UNAVAILABLE\]/i.test(msg);

              if (isConnDrop) {
                console.warn(`[delete] connection/timeout on batch: ${msg} — reconnecting`);
                send("ratelimit", { retryIn: 3000, hits: ++rateLimitHits, message: `Connection dropped after ${deleted.toLocaleString()} — reconnecting…` });
                try { imap.destroy(); } catch (_) {}
                reject(new Error("RECONNECT"));
                return;
              } else if (isRateLimit) {
                rateLimitHits++;
                const wait = Math.min(5000 * rateLimitHits, 60000);
                const secs = (wait / 1000).toFixed(0);
                console.warn(`[delete] rate limit #${rateLimitHits}, backing off ${secs}s`);
                send("ratelimit", { retryIn: wait, hits: rateLimitHits, message: `Rate limited — waiting ${secs}s` });
                await sleep(wait);
              } else {
                // Non-retryable error on this batch — skip it and move on
                console.error(`[delete] error on batch, skipping ${batch.length} UIDs:`, msg);
                send("error", { message: `Skipped ${batch.length} messages: ${msg.slice(0, 80)}` });
                remaining.splice(0, batch.length);
                break;
              }
              retries++;
            }
          }

          if (!success && retries >= 5) {
            console.warn(`[delete] batch skipped after max retries, skipping ${batch.length} UIDs`);
            send("skipped", { reason: `batch of ${batch.length} skipped after max retries` });
            remaining.splice(0, batch.length);
          }
        }

        // closeBox(true) expunges all \Deleted messages and closes —
        // more reliable than a separate EXPUNGE command
        console.log(`[delete] closing box with expunge…`);
        send("status", { message: "expunging and closing…" });
        try {
          await withTimeout(
            new Promise(r => imap.closeBox(true, (e) => {
              if (e) console.warn(`[delete] closeBox warning:`, e.message);
              r();
            })),
            120000,
            "closeBox timed out"
          );
        } catch (e) {
          console.warn(`[delete] closeBox error:`, e.message);
          send("warning", { message: `Close warning: ${e.message}` });
        }
        imap.end();
        resolve();
      });
    });

    imap.connect();
  });

  // Outer reconnect loop — keeps retrying until done or MAX_RECONNECTS
  // consecutive failures with no progress between them.
  // Uses exponential backoff starting at 15s so the server has time to
  // cool down before we attempt to re-authenticate.
  let consecutiveFailures = 0;
  const BASE_RECONNECT_WAIT = 15000;  // start at 15s — gives server time to recover
  const MAX_RECONNECT_WAIT  = 120000; // cap at 2 minutes

  while (remaining.length > 0 && consecutiveFailures <= MAX_RECONNECTS) {
    const progressBefore = deleted;
    try {
      await runDelete();
      break; // finished cleanly
    } catch (err) {
      const isReconnect  = err.message === "RECONNECT";
      const isAuthFail   = /auth|login|timeout.*auth|authenticat/i.test(err.message);
      const madeProgress = deleted > progressBefore;

      if (madeProgress) {
        // Reset consecutive failure count whenever we make progress
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
      }

      if ((isReconnect || isAuthFail) && remaining.length > 0) {
        reconnects++;
        // Exponential backoff — longer waits give the server more recovery time
        const wait = Math.min(BASE_RECONNECT_WAIT * Math.pow(1.8, consecutiveFailures), MAX_RECONNECT_WAIT);
        const secs = Math.round(wait / 1000);
        console.log(`[delete] reconnect #${reconnects} (${consecutiveFailures} consecutive failures) — waiting ${secs}s, ${remaining.length} remaining`);
        send("ratelimit", {
          retryIn: wait,
          hits: rateLimitHits,
          message: `Server cooling down — waiting ${secs}s before retry (${remaining.length.toLocaleString()} messages left)`,
        });
        await sleep(wait);
        console.log(`[delete] attempting reconnect #${reconnects}…`);
      } else {
        // Unrecoverable error
        console.error(`[delete] unrecoverable error:`, err.message);
        send("error", { message: err.message });
        break;
      }
    }
  }

  if (consecutiveFailures > MAX_RECONNECTS) {
    console.error(`[delete] gave up after ${MAX_RECONNECTS} consecutive failed reconnects`);
    send("error", { message: `Gave up after ${MAX_RECONNECTS} failed reconnects — ${deleted.toLocaleString()} of ${allUids.length.toLocaleString()} deleted. Try running again to continue.` });
  }

  console.log(`[delete] complete — ${deleted}/${allUids.length} deleted, ${reconnects} reconnects`);
  send("done", { deleted, total: allUids.length, rateLimitHits });
  end();
});

const fs   = require("fs");
const os   = require("os");
const crypto = require("crypto");

// In-progress and completed archive jobs
const archiveJobs = new Map(); // jobId -> { status, file, written, total, error, filename }

// ── POST /api/archive/start — begin archiving, stream SSE progress ────────────
app.post("/api/archive/start", async (req, res) => {
  const { host, port, tls, user, password, folder, uids: uidsParam } = req.body;
  const cfg = { host, port, tls: tls === true || tls === "true", user, password };

  const uids = Array.isArray(uidsParam)
    ? uidsParam.map(Number).filter(Boolean)
    : (uidsParam ? String(uidsParam).split(",").map(Number).filter(Boolean) : []);
  if (uids.length === 0) { res.status(400).json({ error: "No UIDs provided" }); return; }

  // Create a temp file to write the mbox into
  const jobId   = crypto.randomBytes(8).toString("hex");
  const tmpFile = path.join(os.tmpdir(), `imap-archive-${jobId}.mbox`);
  const filename = `archive-${new Date().toISOString().slice(0,10)}.mbox`;
  const job = { status: "running", file: tmpFile, filename, written: 0, total: uids.length, error: null };
  archiveJobs.set(jobId, job);

  // SSE stream for progress
  const { send, end } = sseStream(res);
  send("started", { jobId, total: uids.length });

  console.log(`[archive:${jobId}] ${uids.length} UIDs from ${folder || "INBOX"}, tls=${cfg.tls}`);

  const BATCH          = 5;    // small batches — messages can be very large
  const BATCH_TIMEOUT  = 600000; // 10 min per batch
  const MAX_RECONNECTS = 20;
  let written          = 0;
  let remaining        = [...uids];
  let reconnects       = 0;
  let fileStream       = fs.createWriteStream(tmpFile, { flags: "a" });

  const runArchive = () => new Promise((resolve, reject) => {
    const imap = makeImap(cfg);
    imap.on("error", (err) => { reject(err); });

    imap.once("ready", () => {
      imap.openBox(folder || "INBOX", true, async (err) => {
        if (err) { reject(err); return; }
        console.log(`[archive:${jobId}] box open — ${remaining.length} remaining`);

        while (remaining.length > 0) {
          const batch = remaining.slice(0, BATCH);

          try {
            await withTimeout(new Promise((res2, rej2) => {
              const f       = imap.fetch(batch, { bodies: "", struct: false });
              let   pending = batch.length;
              const msgs    = new Map();

              f.on("message", (msg, seqno) => {
                let uid  = null;
                let body = "";
                let date = new Date();
                msg.on("attributes", (attrs) => { uid = attrs.uid; date = attrs.date || new Date(); });
                msg.on("body", (stream) => { stream.on("data", c => { body += c.toString("binary"); }); });
                msg.once("end", () => {
                  msgs.set(uid || seqno, { body, date });
                  pending--;
                  if (pending === 0) {
                    for (const buid of batch) {
                      const m = msgs.get(buid);
                      if (!m) continue;
                      const dateLine = (m.date instanceof Date ? m.date : new Date()).toUTCString();
                      const envelope = `From MAILER-DAEMON ${dateLine}\r\n`;
                      const escaped  = m.body.replace(/^From /gm, ">From ");
                      const sep      = escaped.endsWith("\r\n\r\n") ? "" : "\r\n\r\n";
                      fileStream.write(Buffer.from(envelope + escaped + sep, "binary"));
                      written++;
                      job.written = written;
                    }
                    res2();
                  }
                });
              });

              f.once("error", rej2);
              f.once("end", () => { if (pending > 0) res2(); });
            }), BATCH_TIMEOUT, `fetch timed out for batch of ${batch.length}`);

            remaining.splice(0, batch.length);
            const sizeMB = (fs.existsSync(tmpFile) ? fs.statSync(tmpFile).size : 0) / 1024 / 1024;
            console.log(`[archive:${jobId}] ${written}/${uids.length} written, ${sizeMB.toFixed(1)} MB`);
            send("progress", { written, total: uids.length, sizeMB: parseFloat(sizeMB.toFixed(1)) });

          } catch (err) {
            if (isTransientError(err)) {
              imap.destroy();
              reject(err);
              return;
            }
            console.error(`[archive:${jobId}] batch error, skipping ${batch.length}:`, err.message);
            send("warning", { message: `Skipped ${batch.length} messages: ${err.message.slice(0,80)}` });
            remaining.splice(0, batch.length);
          }
        }

        imap.end();
        resolve();
      });
    });

    imap.connect();
  });

  // Reconnect loop
  while (remaining.length > 0 && reconnects <= MAX_RECONNECTS) {
    try {
      await runArchive();
      break;
    } catch (err) {
      if (isTransientError(err) && reconnects < MAX_RECONNECTS) {
        reconnects++;
        const wait = Math.min(10000 * reconnects, 60000);
        console.log(`[archive:${jobId}] reconnect #${reconnects} in ${wait/1000}s, ${remaining.length} remaining`);
        send("reconnect", { attempt: reconnects, retryIn: wait, remaining: remaining.length });
        // Reopen file stream for append after reconnect
        fileStream = fs.createWriteStream(tmpFile, { flags: "a" });
        await sleep(wait);
      } else {
        console.error(`[archive:${jobId}] giving up:`, err.message);
        job.error = err.message;
        break;
      }
    }
  }

  // Finalise
  await new Promise(r => fileStream.end(r));
  const finalSize = fs.existsSync(tmpFile) ? fs.statSync(tmpFile).size : 0;
  job.status = job.error ? "error" : "done";

  console.log(`[archive:${jobId}] complete — ${written}/${uids.length} written, ${(finalSize/1024/1024).toFixed(1)} MB`);
  send("done", {
    jobId,
    written,
    total: uids.length,
    sizeMB: parseFloat((finalSize / 1024 / 1024).toFixed(1)),
    error: job.error,
  });
  end();
});

// ── GET /api/archive/download/:jobId — download the completed mbox file ───────
app.get("/api/archive/download/:jobId", (req, res) => {
  const job = archiveJobs.get(req.params.jobId);
  if (!job)                          { res.status(404).send("Job not found"); return; }
  if (job.status === "running")      { res.status(409).send("Still in progress"); return; }
  if (!fs.existsSync(job.file))      { res.status(410).send("File no longer available"); return; }

  res.setHeader("Content-Type",        "application/mbox");
  res.setHeader("Content-Disposition", `attachment; filename="${job.filename}"`);
  res.setHeader("Content-Length",      fs.statSync(job.file).size);

  const stream = fs.createReadStream(job.file);
  stream.pipe(res);
  stream.on("end", () => {
    // Clean up temp file after download
    fs.unlink(job.file, () => {});
    archiveJobs.delete(req.params.jobId);
  });
});

// ── start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`\n✓ IMAP Email Cleaner running at http://localhost:${PORT}`);
  console.log(`  (proxied via nginx at http://localhost:80)\n`);
});

