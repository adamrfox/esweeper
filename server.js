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
process.on("uncaughtException", (err) => {
  // Suppress the known Node.js TLS socket assertion bug — it is harmless,
  // triggered by destroying an IMAP connection that is already half-closed.
  // We match on code, message content, and stack trace content to be thorough.
  const msg   = (err && err.message) || "";
  const stack = (err && err.stack)   || "";
  const isTlsBug =
    err.code === "ERR_INTERNAL_ASSERTION" ||
    msg.includes("finishShutdown")        ||
    msg.includes("This is caused by either a bug in Node.js") ||
    stack.includes("js_stream_socket")    ||
    stack.includes("JSStreamSocket")      ||
    stack.includes("doShutdown")          ||
    stack.includes("doWrite");
  if (isTlsBug) return; // silently ignore — server continues normally
  console.error("[server] uncaughtException:", msg);
});
process.on("unhandledRejection", (err) => {
  const msg = (err && err.message) || String(err);
  console.error("[server] unhandledRejection:", msg);
});

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

// Parse an IMAP date string like "1-Jan-2024" back into a Date
function parseImapDate(str) {
  const months = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
  const m = String(str).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  return new Date(Date.UTC(parseInt(m[3]), months[m[2]], parseInt(m[1])));
}

// Search with automatic bisection when hitting the server's result cap.
// Some servers (Yahoo, others) cap SEARCH at exactly 1000 results —
// when we hit that we split the date range in half and search each half,
// recursively, until every sub-range fits under the cap.
function searchWithBisection(imap, criteria, onProgress) {
  // Yahoo caps IMAP SEARCH results at ~1000 but the actual returned count
  // can be anything from ~900 to exactly 1000. We use a conservative 900
  // threshold to catch all cases, then bisect the date range and re-search.
  const RESULT_CAP = 900;

  // Extract the SINCE/BEFORE range from the criteria, if present
  const extractRange = (crit) => {
    let since = null, before = null;
    const rest = [];
    for (const item of crit) {
      if (Array.isArray(item) && item[0] === "SINCE")  since  = parseImapDate(item[1]);
      else if (Array.isArray(item) && item[0] === "BEFORE") before = parseImapDate(item[1]);
      else rest.push(item);
    }
    return { since, before, rest };
  };

  const runOne = (crit) => new Promise((res, rej) => {
    imap.search(crit, (err, uids) => err ? rej(err) : res(uids || []));
  });

  const search = async (crit) => {
    const uids = await runOne(crit);
    const { since, before, rest } = extractRange(crit);
    const rangeStr = since && before ? `${imapDate(since)}..${imapDate(before)}` : "(no range)";
    console.log(`[search] ${rangeStr} returned ${uids.length} UIDs`);

    // If we didn't hit the cap, or we can't bisect further, return as-is
    if (uids.length < RESULT_CAP) return uids;

    if (!since || !before) {
      console.warn(`[search] hit result cap of ${RESULT_CAP} but no date range to split`);
      return uids;
    }

    const spanMs = before.getTime() - since.getTime();
    if (spanMs <= 24 * 60 * 60 * 1000) {
      // Can't split below one day — return what we have
      console.warn(`[search] hit cap on single-day range ${imapDate(since)}..${imapDate(before)}`);
      return uids;
    }

    // Split the range in half
    const mid = new Date(since.getTime() + Math.floor(spanMs / 2));
    console.log(`[search] cap hit on ${imapDate(since)}..${imapDate(before)} — splitting at ${imapDate(mid)}`);
    if (onProgress) onProgress(`splitting date range at ${imapDate(mid)}…`);

    const leftCrit  = [...rest, ["SINCE",  imapDate(since)], ["BEFORE", imapDate(mid)]];
    const rightCrit = [...rest, ["SINCE",  imapDate(mid)],   ["BEFORE", imapDate(before)]];

    const leftUids  = await search(leftCrit);
    const rightUids = await search(rightCrit);

    // De-duplicate — the mid date could be in both halves due to inclusivity
    const combined = [...new Set([...leftUids, ...rightUids])];
    combined.sort((a, b) => a - b);
    return combined;
  };

  return search(criteria);
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
    // Add a SINCE lower bound (1970) so bisection can split the range if needed
    const now    = new Date();
    const cutoff = new Date(now);
    if      (ageUnit === "days")   cutoff.setDate(now.getDate() - ageVal);
    else if (ageUnit === "weeks")  cutoff.setDate(now.getDate() - ageVal * 7);
    else if (ageUnit === "months") cutoff.setMonth(now.getMonth() - ageVal);
    else if (ageUnit === "years")  cutoff.setFullYear(now.getFullYear() - ageVal);
    criteria.push(["SINCE",  imapDate(new Date(1970, 0, 1))]);
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
    connTimeout: 60000,
    authTimeout: 60000,
    keepalive:  { interval: 10000, idleInterval: 30000, forceNoop: true },
  });
}

// Safely tear down an IMAP connection without triggering Node's TLS
// ERR_INTERNAL_ASSERTION bug, which fires when socket.end() is called
// on an already-closing TLS socket.
function safeDestroy(imap) {
  try {
    // Access the underlying socket directly and destroy it forcefully.
    // socket.destroy() skips the graceful TLS shutdown that causes the crash.
    const sock = imap?._socket || imap?.socket;
    if (sock && !sock.destroyed) {
      sock.destroy();
    } else {
      // Fallback — wrapped in try/catch to swallow any assertion errors
      safeDestroy(imap)
    }
  } catch (_) {}
}

// ── Shared connection pool ────────────────────────────────────────────────────
// One persistent IMAP connection per user@host — avoids hitting concurrent
// connection limits on the mail server.

const pool = new Map(); // key -> { imap, busy }

function poolKey(cfg) {
  return `${cfg.user}@${cfg.host}:${parseInt(cfg.port) || (cfg.tls ? 993 : 143)}`;
}

const CONN_RETRIES  = 3;
const CONN_BACKOFF  = [5000, 15000, 30000]; // ms between attempts — longer to avoid rate limiting

function isTransientError(err) {
  const msg = (err && err.message) || String(err);
  return /ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|socket|closed|read |write |^TIMEOUT:/i.test(msg);
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
      const isAuthErr = /auth|login|cred|authenticat/i.test(err.message);
      if (isAuthErr) {
        // Auth errors are never transient — fail immediately, don't hammer the server
        throw err;
      } else if (isTransientError(err)) {
        console.warn(`[pool] transient error on attempt ${attempt + 1}: ${err.message}`);
      } else {
        // Non-transient (bad hostname etc) — don't retry
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
    safeDestroy(entry.imap);
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
        const doSearch = async () => {
          if (allUids !== null) return allUids;
          const uids = await searchWithBisection(imap, criteria, (msg) => {
            send("status", { message: msg });
          });
          console.log(`[scan] found ${uids.length} UIDs (after any bisection)`);
          allUids   = uids;
          remaining = [...allUids];
          return allUids;
        };

        doSearch().then(uids => {
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
        }).catch(err => {
          console.error(`[scan] search error:`, err.message);
          reject(err);
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
                safeDestroy(imap)
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

  const BATCH          = 5;      // small batches — messages can be very large
  const BATCH_TIMEOUT  = 600000; // 10 min per batch
  const RETRY_TIMEOUT  = 1200000;// 20 min for individual retry of a skipped message
  const MAX_RECONNECTS = 20;
  let written          = 0;
  let remaining        = [...uids];
  let skipped          = [];     // UIDs that failed — retried one-at-a-time at end
  let reconnects       = 0;
  let fileStream       = fs.createWriteStream(tmpFile, { flags: "a" });

  // Fetch a set of UIDs and write them to fileStream
  const fetchAndWrite = (imap, batch, timeout) => new Promise((res2, rej2) => {
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
  });

  const runArchive = (queue, batchSize, timeout) => new Promise((resolve, reject) => {
    const imap = makeImap(cfg);
    imap.on("error", (err) => { reject(err); });

    imap.once("ready", () => {
      imap.openBox(folder || "INBOX", true, async (err) => {
        if (err) { reject(err); return; }
        console.log(`[archive:${jobId}] box open — ${queue.length} remaining`);

        let consecutiveTimeouts = 0;
        const MAX_CONSECUTIVE_TIMEOUTS = 2; // force reconnect after this many in a row

        while (queue.length > 0) {
          const batch = queue.slice(0, batchSize);

          try {
            await withTimeout(fetchAndWrite(imap, batch, timeout), timeout,
              `fetch timed out for batch of ${batch.length}`);

            consecutiveTimeouts = 0; // reset on success
            queue.splice(0, batch.length);
            const sizeMB = (fs.existsSync(tmpFile) ? fs.statSync(tmpFile).size : 0) / 1024 / 1024;
            console.log(`[archive:${jobId}] ${written}/${uids.length} written, ${sizeMB.toFixed(1)} MB`);
            send("progress", { written, total: uids.length, sizeMB: parseFloat(sizeMB.toFixed(1)), skipped: skipped.length });

          } catch (err) {
            consecutiveTimeouts++;
            const isTimeout = /^TIMEOUT:/i.test(err.message);

            // Force reconnect if connection appears dead (multiple consecutive timeouts)
            if (isTransientError(err) || (isTimeout && consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS)) {
              console.warn(`[archive:${jobId}] ${consecutiveTimeouts} consecutive timeout(s), forcing reconnect`);
              safeDestroy(imap)
              reject(err);
              return;
            }

            // Single timeout or non-transient — queue for retry
            console.error(`[archive:${jobId}] batch error, queuing for retry UIDs ${batch.join(',')}: ${err.message}`);
            send("warning", { message: `Queued ${batch.length} messages for retry: ${err.message.slice(0,80)}` });
            skipped.push(...batch);
            queue.splice(0, batch.length);
          }
        }

        imap.end();
        resolve();
      });
    });

    imap.connect();
  });

  // ── Main pass — batches of BATCH ─────────────────────────────────────────
  while (remaining.length > 0 && reconnects <= MAX_RECONNECTS) {
    try {
      await runArchive(remaining, BATCH, BATCH_TIMEOUT);
      break;
    } catch (err) {
      if (isTransientError(err) && reconnects < MAX_RECONNECTS) {
        reconnects++;
        const wait = Math.min(10000 * reconnects, 60000);
        console.log(`[archive:${jobId}] reconnect #${reconnects} in ${wait/1000}s, ${remaining.length} remaining`);
        send("reconnect", { attempt: reconnects, retryIn: wait, remaining: remaining.length });
        fileStream = fs.createWriteStream(tmpFile, { flags: "a" });
        await sleep(wait);
      } else {
        console.error(`[archive:${jobId}] giving up on main pass:`, err.message);
        job.error = err.message;
        break;
      }
    }
  }

  // ── Retry pass — skipped UIDs one at a time with longer timeout ───────────
  if (skipped.length > 0) {
    console.log(`[archive:${jobId}] retry pass — ${skipped.length} skipped UIDs`);
    send("status", { message: `Retrying ${skipped.length} skipped messages one at a time…` });
    fileStream = fs.createWriteStream(tmpFile, { flags: "a" });
    const stillSkipped = [];
    let retryReconnects = 0;
    const retryQueue = [...skipped];
    skipped = [];

    while (retryQueue.length > 0 && retryReconnects <= MAX_RECONNECTS) {
      try {
        await runArchive(retryQueue, 1, RETRY_TIMEOUT);
        break;
      } catch (err) {
        if (isTransientError(err) && retryReconnects < MAX_RECONNECTS) {
          retryReconnects++;
          const wait = Math.min(15000 * retryReconnects, 60000);
          console.log(`[archive:${jobId}] retry reconnect #${retryReconnects} in ${wait/1000}s`);
          send("reconnect", { attempt: retryReconnects, retryIn: wait, remaining: retryQueue.length });
          fileStream = fs.createWriteStream(tmpFile, { flags: "a" });
          await sleep(wait);
        } else {
          console.error(`[archive:${jobId}] giving up on retry pass:`, err.message);
          stillSkipped.push(...retryQueue);
          break;
        }
      }
    }

    // skipped[] is now populated by runArchive with any that failed the retry too
    stillSkipped.push(...skipped);
    if (stillSkipped.length > 0) {
      console.warn(`[archive:${jobId}] permanently skipped UIDs: ${stillSkipped.join(',')}`);
      send("skipped", { uids: stillSkipped });
    }
    skipped = stillSkipped;
  }

  // Finalise
  await new Promise(r => fileStream.end(r));
  const finalSize = fs.existsSync(tmpFile) ? fs.statSync(tmpFile).size : 0;
  job.status = (job.error && written === 0) ? "error" : "done";
  job.skipped = skipped;

  console.log(`[archive:${jobId}] complete — ${written}/${uids.length} written, ${skipped.length} skipped, ${(finalSize/1024/1024).toFixed(1)} MB`);
  send("done", {
    jobId,
    written,
    total:   uids.length,
    skipped: skipped.length,
    skippedUids: skipped,
    sizeMB:  parseFloat((finalSize / 1024 / 1024).toFixed(1)),
    error:   job.error,
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

  // Handle client disconnect cleanly — prevents ERR_INTERNAL_ASSERTION
  // crash in Node.js when browser closes connection mid-stream (e.g. for
  // large files where the user cancels or navigates away)
  const cleanup = () => {
    try { stream.destroy(); } catch (_) {}
  };
  req.on("close",   cleanup);
  req.on("aborted", cleanup);
  res.on("close",   cleanup);

  stream.on("error", (err) => {
    console.error("[download] stream error:", err.message);
    cleanup();
  });

  stream.on("end", () => {
    // Only delete if the response finished cleanly (not aborted)
    if (res.writableEnded) {
      fs.unlink(job.file, () => {});
      archiveJobs.delete(req.params.jobId);
      console.log(`[download] complete, file cleaned up`);
    } else {
      console.log(`[download] client disconnected before completion — file preserved for retry`);
    }
  });

  stream.pipe(res, { end: true });
});

// ── GET /api/archive/jobs — list all known jobs (running + done) ──────────────
app.get("/api/archive/jobs", (req, res) => {
  const jobs = [];
  for (const [jobId, job] of archiveJobs.entries()) {
    const fileExists = fs.existsSync(job.file);
    const sizeMB     = fileExists ? parseFloat((fs.statSync(job.file).size / 1024 / 1024).toFixed(1)) : 0;
    jobs.push({
      jobId,
      status:   job.status,
      filename: job.filename,
      written:  job.written,
      total:    job.total,
      sizeMB,
      fileExists,
      error:    job.error || null,
      skipped:  (job.skipped || []).length,
    });
  }
  // Also scan /tmp for any imap-archive-*.mbox files not in the map
  // (e.g. from a previous session that survived a client reload)
  try {
    const tmpFiles = fs.readdirSync(os.tmpdir())
      .filter(f => f.startsWith("imap-archive-") && f.endsWith(".mbox"));
    for (const f of tmpFiles) {
      const jobId = f.replace("imap-archive-", "").replace(".mbox", "");
      if (!archiveJobs.has(jobId)) {
        const filePath = path.join(os.tmpdir(), f);
        const sizeMB   = parseFloat((fs.statSync(filePath).size / 1024 / 1024).toFixed(1));
        // Re-register it so it can be downloaded
        archiveJobs.set(jobId, {
          status:   "done",
          file:     filePath,
          filename: f.replace(`imap-archive-${jobId}-`, "") || `archive-recovered.mbox`,
          written:  null,
          total:    null,
          error:    null,
          skipped:  [],
        });
        jobs.push({ jobId, status: "done", filename: f, written: null, total: null, sizeMB, fileExists: true, error: null, skipped: 0 });
      }
    }
  } catch (_) {}

  res.json({ jobs });
});

// ── DELETE /api/archive/jobs/:jobId — delete a completed job and its file ─────
app.delete("/api/archive/jobs/:jobId", (req, res) => {
  const job = archiveJobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  if (job.status === "running") { res.status(409).json({ error: "Job still running" }); return; }
  if (fs.existsSync(job.file)) fs.unlink(job.file, () => {});
  archiveJobs.delete(req.params.jobId);
  res.json({ ok: true });
});

// ── GET /health — liveness check for monitoring tools ────────────────────────
app.get("/health", (req, res) => {
  const runningJobs = [...archiveJobs.values()].filter(j => j.status === "running").length;
  const doneJobs    = [...archiveJobs.values()].filter(j => j.status === "done").length;
  res.json({
    status:   "ok",
    uptime:   Math.round(process.uptime()),
    memory:   Math.round(process.memoryUsage().rss / 1024 / 1024),
    jobs: { running: runningJobs, done: doneJobs },
    pool:     pool.size,
  });
});

// ── start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`\n✓ IMAP Email Cleaner running at http://localhost:${PORT}`);
  console.log(`  (proxied via nginx at http://localhost:80)\n`);
});

