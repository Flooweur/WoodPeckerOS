// The bridge, thing side. Injected by the canvas into every thing's document.
// It is the thing's only way out of its frame: messages to the frame page,
// which answers according to which frame the message came from.
(() => {
  const frame = window.parent;
  const pending = new Map();
  const feeds = new Map();
  let seq = 0;

  function call(op, args) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, [resolve, reject]);
      frame.postMessage({ woody: 1, id, op, args }, "*");
    });
  }

  window.addEventListener("message", (e) => {
    // Only the frame page may speak to a thing. Another thing can post a
    // message here, so anything else is counted and dropped.
    if (e.source !== frame) {
      frame.postMessage({ woody: 1, id: 0, op: "foreign", args: {} }, "*");
      return;
    }
    const m = e.data;
    if (!m || m.woody !== 1) return;
    if (m.re) {
      const p = pending.get(m.re);
      if (!p) return;
      pending.delete(m.re);
      if (m.ok) p[0](m.value);
      else p[1](new Error(m.error || "refused"));
    } else if (m.feed) {
      for (const cb of feeds.get(m.feed) ?? []) {
        try {
          cb(m.value);
        } catch (err) {
          call("error", { message: String(err) });
        }
      }
    }
  });

  window.addEventListener("error", (e) => call("error", { message: `${e.message} (line ${e.lineno})` }));
  window.addEventListener("unhandledrejection", (e) => call("error", { message: `unhandled: ${e.reason}` }));
  document.addEventListener("securitypolicyviolation", (e) => call("csp", { directive: e.effectiveDirective, blocked: e.blockedURI }));

  window.woody = {
    /** Call once the thing is working. A thing that never says so is not shown. */
    ready: () => call("ready", {}),
    /** One reading of a feed: "meters". */
    read: (feed) => call("read", { feed }),
    /** Readings as they come. */
    subscribe: (feed, cb) => {
      if (!feeds.has(feed)) feeds.set(feed, []);
      feeds.get(feed).push(cb);
      return call("subscribe", { feed });
    },
    /** The thing's own saved state: one JSON value, kept by the canvas. */
    state: { get: () => call("state.get", {}), set: (value) => call("state.set", { value }) },
    /** Tell Woody something happened. Paced like any other wake-up. */
    emit: (name, data) => call("emit", { name, data }),
    /** Spike only: hand a measurement to the test runner. */
    report: (data) => call("report", data),
  };
})();
