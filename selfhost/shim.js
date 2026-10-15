// Replaces the Claude artifact runtime: window.claude.use("db") and ("downloads").
// The owner opens the site once with  https://your-host/#key=<ADMIN_KEY>  ; the key is kept for the tab only.
(function () {
  var API_TIMEOUT_MS = 15000;
  var m = location.hash.match(/key=([^&]+)/);
  if (m) { try { sessionStorage.setItem("fb-key", decodeURIComponent(m[1])); } catch (e) {} history.replaceState(null, "", location.pathname); }
  function key() { try { return sessionStorage.getItem("fb-key") || ""; } catch (e) { return ""; } }
  function api(method, url, data) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, API_TIMEOUT_MS);
    return fetch(url, { method: method, headers: { "Content-Type": "application/json", "X-Admin-Key": key() },
      body: data === undefined ? undefined : JSON.stringify(data), signal: controller.signal })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw new Error(j.error || r.statusText || ("HTTP " + r.status));
          return j;
        });
      })
      .catch(function (e) {
        if (e.name === "AbortError") throw new Error("API request timed out after " + (API_TIMEOUT_MS / 1000) + " seconds: " + method + " " + url);
        throw e;
      })
      .then(function (result) { clearTimeout(timer); return result; }, function (error) { clearTimeout(timer); throw error; });
  }
  function snapOf(j) { return { exists: j.exists, id: j.id, data: function () { return j.data; } }; }
  function colSnap(j) { var d = j.docs.map(function (x) { return { id: x.id, data: function () { return x.data; } }; });
    return { docs: d, size: d.length, empty: !d.length, forEach: function (f) { d.forEach(f); } }; }
  function listen(url, make, ok, bad) {
    // EventSource cannot send headers, so the owner key goes in the query string for streams.
    var es = new EventSource(url + (url.indexOf("?") > -1 ? "&" : "?") + "k=" + encodeURIComponent(key()));
    es.onmessage = function (e) { try { ok(make(JSON.parse(e.data))); } catch (x) {} };
    es.onerror = function () { if (bad) bad(new Error("stream error")); };
    return function () { es.close(); };
  }
  function doc(p) { var s = p.split("/"), base = "/api/doc/" + encodeURIComponent(s[0]) + "/" + encodeURIComponent(s[1]);
    return { get: function () { return api("GET", base).then(snapOf); },
      set: function (d) { return api("PUT", base, d); }, update: function (d) { return api("PATCH", base, d); },
      delete: function () { return api("DELETE", base); },
      onSnapshot: function (ok, bad) { return listen("/api/stream/" + encodeURIComponent(s[0]) + "/" + encodeURIComponent(s[1]), snapOf, ok, bad); } }; }
  function col(name, limit) { var base = "/api/col/" + encodeURIComponent(name);
    return { add: function (d) { return api("POST", base, d).then(function (r) { return { id: r.id }; }); },
      limit: function (n) { return col(name, n); },
      get: function () { return api("GET", base + (limit ? "?limit=" + limit : "")).then(colSnap); },
      onSnapshot: function (ok, bad) { return listen("/api/stream/" + encodeURIComponent(name) + (limit ? "?limit=" + limit : ""), colSnap, ok, bad); } }; }
  window.claude = { use: function (cap) {
    if (cap === "db") return Promise.resolve({ doc: doc, collection: function (n) { return col(n); } });
    if (cap === "downloads") return Promise.resolve({ save: function (o) {
      var blob = o.data instanceof Blob ? o.data : new Blob([o.data]); var a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = o.filename; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000); return Promise.resolve({ saved: true }); } });
    return Promise.reject(new Error("Unsupported capability: " + cap)); } };
})();
