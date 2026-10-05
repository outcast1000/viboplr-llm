// A fake plugin API: enough of ViboplrPluginAPI for activate() and the flows
// the tests drive. Calls are recorded so tests can assert on them.

function makeHost(opts = {}) {
  const calls = [];
  const storage = Object.assign({}, opts.storage);
  const ui = { views: {}, headers: {}, badges: {}, actions: {}, navigated: [] };
  const menus = {};
  const infoHandlers = {};
  const tools = {};
  const search = { providers: [], handlers: {} };
  const modelReplies = (opts.modelReplies || []).slice();
  const modelRequests = [];

  function record(name, args) {
    calls.push({ name, args });
  }

  const network = {
    async fetch(url, init) {
      record("network.fetch", [url, init]);
      if (opts.fetch) return opts.fetch(url, init);
      if (/\/models$/.test(url)) {
        return response(200, { data: (opts.models || ["qwen3:14b"]).map((id) => ({ id })) });
      }
      if (/\/chat\/completions$/.test(url)) {
        const body = JSON.parse(init.body);
        modelRequests.push(body);
        const next = modelReplies.shift();
        if (!next) return response(200, { choices: [{ message: { content: "(no scripted reply)" } }] });
        if (next.status) return response(next.status, next.body);
        // { gate, reply }: a model call that hangs until the test opens the gate.
        if (next.gate) {
          // Honour the signal as the host does: abort rejects with AbortError.
          const signal = init.signal;
          await new Promise((resolve, reject) => {
            next.gate.then(resolve);
            if (signal) {
              signal.addEventListener("abort", () => {
                const e = new Error("The request was cancelled.");
                e.name = "AbortError";
                reject(e);
              });
            }
          });
          return response(200, { choices: [{ message: next.reply }] });
        }
        return response(200, { choices: [{ message: next }] });
      }
      return response(404, { error: "no route" });
    },
  };

  const hostToolCalls = [];
  const assistantHost = opts.noHost
    ? undefined
    : {
        async listTools() {
          return opts.hostTools || [];
        },
        instructions() {
          return "App notes.";
        },
        async invoke(name, args) {
          hostToolCalls.push({ name, args });
          if (opts.invoke) return opts.invoke(name, args);
          return { ok: true };
        },
      };

  const api = {
    appVersion: "1.0.85",
    log: (level, message) => record("log", [level, message]),
    network,
    storage: {
      async get(k) {
        return storage[k];
      },
      async set(k, v) {
        storage[k] = JSON.parse(JSON.stringify(v));
      },
    },
    ui: {
      setViewData: (id, data) => (ui.views[id] = data),
      setViewHeader: (id, h) => (ui.headers[id] = h),
      setBadge: (id, b) => (ui.badges[id] = b),
      onAction: (id, handler) => { ui.actions[id] = handler; },
      navigateToView: (id) => ui.navigated.push(id),
    },
    contextMenu: { onAction: (id, handler) => { menus[id] = handler; } },
    informationTypes: {
      onFetch: (id, handler) => { infoHandlers[id] = handler; return () => delete infoHandlers[id]; },
      async getValue(typeId, entity) {
        record("info.getValue", [typeId, entity]);
        return opts.cachedLyrics ? { typeId, status: "ok", value: { text: opts.cachedLyrics } } : null;
      },
      async fetch(typeId, entity) {
        record("info.fetch", [typeId, entity]);
        return opts.fetchedLyrics ? { typeId, status: "ok", source: "fetch", value: { text: opts.fetchedLyrics } } : { status: "not_found" };
      },
    },
    assistant: {
      onTool: (name, handler) => { tools[name] = handler; return () => delete tools[name]; },
      host: assistantHost,
    },
    search: {
      registerProvider: (d) => { search.providers.push(d); return () => {}; },
      onQuery: (id, handler) => { search.handlers[id] = handler; return () => delete search.handlers[id]; },
    },
  };

  return { api, calls, storage, ui, menus, infoHandlers, tools, search, modelRequests, hostToolCalls };
}

function response(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, headers: { "content-type": "application/json" }, text: async () => text, json: async () => JSON.parse(text) };
}

/** Let queued promise callbacks run. */
function flush(times = 20) {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) p = p.then(() => new Promise((r) => setImmediate(r)));
  return p;
}

/** All text node contents in a rendered view, depth-first. */
function viewTexts(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.type === "text") out.push(node.content);
  if (node.type === "loading" && node.message) out.push(node.message);
  if (node.type === "chat") {
    if (node.notice) out.push(node.notice.message);
    node.messages.forEach((m) => {
      if (m.text) out.push(m.text);
      (m.steps || []).forEach((s) => out.push(s.label));
    });
    if (node.approval) out.push(node.approval.message);
    if (node.status) out.push(node.status.label);
  }
  for (const k of ["children"]) if (Array.isArray(node[k])) node[k].forEach((c) => viewTexts(c, out));
  if (node.control) viewTexts(node.control, out);
  return out;
}

module.exports = { makeHost, flush, viewTexts };
