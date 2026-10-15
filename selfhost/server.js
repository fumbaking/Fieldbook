// Fieldbook self-host server. Uses Node's built-in SQLite support (Node 22.13+).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { serve } = require("@hono/node-server");
const { Hono } = require("hono");
const { bodyLimit } = require("hono/body-limit");
const { streamSSE } = require("hono/streaming");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const DB_FILE = path.resolve(process.env.DB_FILE || path.join(__dirname, "data", "fieldbook.sqlite"));
const LEGACY_FILE = path.resolve(process.env.DATA_FILE || path.join(__dirname, "data", "store.json"));
const SEED_FILE = path.join(__dirname, "..", "db", "database.json");
const APP_FILE = path.join(__dirname, "..", "app", "index.html");
const SHIM_FILE = path.join(__dirname, "shim.js");
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_LIMIT = 5000;
const NO_STORE = { "Cache-Control": "no-store" };

if (!ADMIN_KEY || ADMIN_KEY.length < 12) {
  console.error("Set ADMIN_KEY (12+ characters) before starting the server.");
  process.exit(1);
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error("PORT must be an integer between 1 and 65535.");
  process.exit(1);
}

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const dbExisted = fs.existsSync(DB_FILE);
const database = new DatabaseSync(DB_FILE);
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS documents (
    collection TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT NOT NULL CHECK (json_valid(data)),
    PRIMARY KEY (collection, id)
  );
`);

const readDoc = database.prepare("SELECT data FROM documents WHERE collection = ? AND id = ?");
const readCollection = database.prepare(
  "SELECT id, data FROM documents WHERE collection = ? ORDER BY rowid LIMIT ?"
);
const countDocuments = database.prepare("SELECT count(*) AS count FROM documents");
const upsertDoc = database.prepare(`
  INSERT INTO documents (collection, id, data) VALUES (?, ?, ?)
  ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data
`);
const deleteDoc = database.prepare("DELETE FROM documents WHERE collection = ? AND id = ?");

function loadJsonStore(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const collections = parsed && parsed.collections ? parsed.collections : parsed;
  if (!collections || typeof collections !== "object" || Array.isArray(collections)) {
    throw new Error("Database file must contain a collections object.");
  }
  return collections;
}

function importStore(collections, source) {
  let imported = 0;
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const [collection, docs] of Object.entries(collections)) {
      if (!docs || typeof docs !== "object" || Array.isArray(docs)) {
        throw new Error(`Invalid document collection in ${source}: ${collection}`);
      }
      for (const [id, data] of Object.entries(docs)) {
        upsertDoc.run(collection, id, JSON.stringify(data));
        imported++;
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  console.log(`database: imported ${imported} documents from ${source}`);
}

if (!dbExisted) {
  if (fs.existsSync(LEGACY_FILE)) {
    importStore(loadJsonStore(LEGACY_FILE), LEGACY_FILE);
  } else if (fs.existsSync(SEED_FILE)) {
    importStore(loadJsonStore(SEED_FILE), SEED_FILE);
  } else {
    console.log("database: starting with an empty SQLite database");
  }
} else {
  console.log(`database: opened existing SQLite database (${countDocuments.get().count} documents)`);
}

const streams = new Set();
const requestLogs = new WeakMap();
let nextRequestId = 0;

function snapDoc(collection, id) {
  const row = readDoc.get(collection, id);
  return { exists: !!row, id, data: row ? JSON.parse(row.data) : null };
}

function effectiveLimit(value) {
  const limit = Number(value);
  return Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), MAX_LIMIT) : 1000;
}

function snapCollection(collection, limit) {
  return {
    docs: readCollection.all(collection, effectiveLimit(limit)).map(row => ({
      id: row.id,
      data: JSON.parse(row.data)
    }))
  };
}

function notify(collection, id) {
  for (const stream of streams) {
    if (stream.collection !== collection) continue;
    if (stream.kind === "doc" && stream.id !== id) continue;
    stream.write(stream.kind === "doc"
      ? snapDoc(collection, id)
      : snapCollection(collection, stream.limit));
  }
}

function isAdmin(c) {
  const provided = Buffer.from(
    c.req.header("x-admin-key") || c.req.query("k") || "",
    "utf8"
  );
  const expected = Buffer.from(ADMIN_KEY, "utf8");
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

const guestMayWrite = collection => collection === "requests";
const safe = value => /^[A-Za-z0-9_.~:@+-]{1,200}$/.test(value);
const json = (c, status, value) => c.json(value, status, NO_STORE);
const fail = (message, status) => Object.assign(new Error(message), { status });
const limitedBody = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: c => {
    const incoming = c.env && c.env.incoming;
    if (incoming && !incoming.complete) incoming.resume();
    return c.json(
      { error: "request body exceeds 5 MB" },
      413,
      { ...NO_STORE, Connection: "close" }
    );
  }
});

async function readJsonBody(c) {
  let value;
  try {
    const text = await c.req.text();
    value = text ? JSON.parse(text) : {};
  } catch {
    throw fail("invalid JSON request body", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail("invalid JSON request body", 400);
  }
  return value;
}

function apiError(c, message, status) {
  return json(c, status, { error: message });
}

function pathParts(c) {
  try {
    return c.req.path.slice(5).split("/").map(decodeURIComponent);
  } catch {
    throw fail("invalid path encoding", 400);
  }
}

const app = new Hono({ strict: true });

app.onError((error, c) => {
  const status = Number(error.status) || (error instanceof URIError ? 400 : 500);
  const message = error.message || "request failed";
  const meta = requestLogs.get(c);
  if (meta) meta.error = message;
  return json(c, status, {
    error: status === 500 ? "internal server error" : message
  });
});

app.notFound(c => json(c, 404, {
  error: c.req.path.startsWith("/api/") ? "unknown API endpoint" : "not found"
}));

app.use("/api/*", async (c, next) => {
  const startedAt = Date.now();
  const requestId = ++nextRequestId;
  const meta = { startedAt, requestId, isStream: false };
  requestLogs.set(c, meta);
  await next();

  const elapsed = Date.now() - startedAt;
  const status = c.res.status;
  const prefix = elapsed >= 1000 ? "api:slow" : "api";
  const outcome = meta.error || (meta.isStream ? "stream opened" : status >= 400 ? "request rejected" : "");
  const address = c.env && c.env.incoming && c.env.incoming.socket.remoteAddress || "unknown";
  console.log(
    `[${prefix}#${requestId}] ${c.req.method} ${c.req.path} -> ${status} ${elapsed}ms` +
    `${outcome ? ` (${outcome})` : ""} ${address}`
  );
});

app.get("/", async c => {
  let html = await fs.promises.readFile(APP_FILE, "utf8");
  html = html.replace(/<script/i, '<script src="/shim.js"></script>\n<script');
  return c.html(html, 200, NO_STORE);
});
app.get("/index.html", async c => {
  let html = await fs.promises.readFile(APP_FILE, "utf8");
  html = html.replace(/<script/i, '<script src="/shim.js"></script>\n<script');
  return c.html(html, 200, NO_STORE);
});
app.get("/shim.js", async c => c.body(
  await fs.promises.readFile(SHIM_FILE),
  200,
  { ...NO_STORE, "Content-Type": "application/javascript; charset=utf-8" }
));
app.get("/health", c => json(c, 200, { ok: true }));

async function handleDocument(c) {
  const collection = c.req.param("collection");
  const id = c.req.param("id");
  if (!safe(collection) || !safe(id)) return apiError(c, "bad path", 400);
  const admin = isAdmin(c);

  if (c.req.method === "GET") {
    if (collection === "secure" && !admin) return apiError(c, "owner key required", 403);
    return json(c, 200, snapDoc(collection, id));
  }
  if (!["PUT", "PATCH", "DELETE"].includes(c.req.method)) {
    c.header("Allow", "GET, PUT, PATCH, DELETE");
    return apiError(c, "method not allowed", 405);
  }
  if (!admin && !guestMayWrite(collection)) return apiError(c, "owner only", 403);

  if (c.req.method === "DELETE") {
    deleteDoc.run(collection, id);
  } else {
    const value = await readJsonBody(c);
    if (c.req.method === "PATCH") {
      const current = readDoc.get(collection, id);
      if (!current) return apiError(c, "no such document", 404);
      upsertDoc.run(collection, id, JSON.stringify(Object.assign({}, JSON.parse(current.data), value)));
    } else {
      upsertDoc.run(collection, id, JSON.stringify(value));
    }
  }
  notify(collection, id);
  return json(c, 200, { ok: true });
}

async function handleCollection(c) {
  const collection = c.req.param("collection");
  if (!safe(collection)) return apiError(c, "bad path", 400);
  const admin = isAdmin(c);

  if (c.req.method === "GET") {
    if (collection === "secure" && !admin) return apiError(c, "owner key required", 403);
    return json(c, 200, snapCollection(collection, c.req.query("limit")));
  }
  if (c.req.method !== "POST") {
    c.header("Allow", "GET, POST");
    return apiError(c, "method not allowed", 405);
  }
  if (!admin && !guestMayWrite(collection)) return apiError(c, "owner only", 403);

  const value = await readJsonBody(c);
  const id = crypto.randomBytes(10).toString("hex");
  upsertDoc.run(collection, id, JSON.stringify(value));
  notify(collection, id);
  return json(c, 200, { id });
}

function handleStream(c) {
  const collection = c.req.param("collection");
  const id = c.req.param("id");
  if (!safe(collection) || (id !== undefined && !safe(id))) {
    return apiError(c, "bad path", 400);
  }
  if (c.req.method !== "GET") {
    c.header("Allow", "GET");
    return apiError(c, "method not allowed", 405);
  }
  if (collection === "secure" && !isAdmin(c)) return apiError(c, "owner key required", 403);

  const meta = requestLogs.get(c);
  if (meta) meta.isStream = true;
  const streamInfo = {
    kind: id === undefined ? "col" : "doc",
    collection,
    id,
    limit: effectiveLimit(c.req.query("limit")),
    write: null
  };
  const response = streamSSE(c, async stream => {
    let finish;
    const closed = new Promise(resolve => { finish = resolve; });
    streamInfo.write = data => { void stream.writeSSE({ data: JSON.stringify(data) }); };
    streamInfo.close = finish;
    streams.add(streamInfo);
    stream.onAbort(finish);
    try {
      streamInfo.write(streamInfo.kind === "doc"
        ? snapDoc(collection, id)
        : snapCollection(collection, streamInfo.limit));
      await closed;
    } finally {
      streams.delete(streamInfo);
      const elapsed = Date.now() - (meta ? meta.startedAt : Date.now());
      const requestId = meta ? meta.requestId : 0;
      console.log(`[api#${requestId}] GET ${c.req.path} -> 200 stream closed after ${elapsed}ms`);
    }
  });
  response.headers.set("Cache-Control", "no-cache, no-transform");
  response.headers.set("X-Accel-Buffering", "no");
  return response;
}

app.all("/api/doc/:collection/:id", limitedBody, handleDocument);
app.all("/api/col/:collection", limitedBody, handleCollection);
app.all("/api/stream/:collection", handleStream);
app.all("/api/stream/:collection/:id", handleStream);

app.all("/api/*", c => {
  const parts = pathParts(c);
  const [kind, collection] = parts;
  if (kind === "doc" && parts.length !== 3) {
    return apiError(c, "document path requires collection and id", 400);
  }
  if (kind === "col" && parts.length !== 2) {
    return apiError(c, "collection path must not include a document id", 400);
  }
  if (kind === "stream" && parts.length !== 2 && parts.length !== 3) {
    return apiError(c, "bad stream path", 400);
  }
  if (["doc", "col", "stream"].includes(kind) && !safe(collection || "")) {
    return apiError(c, "bad path", 400);
  }
  return apiError(c, "unknown API endpoint", 404);
});
app.all("/api", c => apiError(c, "unknown API endpoint", 404));

const server = serve({
  fetch: app.fetch,
  port: PORT,
  hostname: "0.0.0.0"
}, () => {
  console.log(`Fieldbook listening on http://localhost:${PORT}`);
  console.log(`SQLite database: ${DB_FILE}`);
  console.log("API logging enabled (method, path, status, duration; secrets and bodies excluded).");
});

server.headersTimeout = 10000;
server.requestTimeout = 30000;
server.keepAliveTimeout = 5000;

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`server: received ${signal}, closing connections`);
  for (const stream of streams) stream.close();
  server.close(() => {
    database.close();
    console.log("server: shutdown complete");
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
