// End-to-end through activate(): the fake host plays Viboplr, the fake
// endpoint plays the model.
const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { makeHost, flush, viewTexts } = require("./harness/host.js");

const HOST_TOOLS = [
  { name: "search_library", description: "Search", inputSchema: { type: "object", properties: {} }, readOnly: true, categories: ["library"] },
  { name: "browse", description: "Browse", inputSchema: { type: "object", properties: {} }, readOnly: true, categories: ["library"] },
  { name: "play_tracks", description: "Play", inputSchema: { type: "object", properties: {} }, readOnly: false, categories: ["playback", "queue"] },
];

function toolCall(name, args, id) {
  return { id: id || "c1", type: "function", function: { name, arguments: JSON.stringify(args) } };
}

async function activated(opts) {
  const plugin = loadPlugin();
  const host = makeHost(Object.assign({ storage: { settings: { model: "qwen3:14b" } }, hostTools: HOST_TOOLS }, opts));
  await plugin.activate(host.api);
  await flush();
  return { plugin, host };
}

test("activate renders the chat, registers its surfaces and checks the endpoint", async () => {
  const { host } = await activated();
  assert.ok(host.ui.views.assistant, "view rendered");
  assert.deepEqual(host.search.providers, [{ id: "ask", name: "AI Assistant" }]);
  assert.ok(host.infoHandlers.lyrics_meaning);
  assert.ok(host.tools.complete);
  assert.deepEqual(Object.keys(host.menus).sort(), ["ask-album", "ask-artist", "ask-track", "cleanup", "fill-album", "upgrade"]);
  assert.ok(host.calls.some((c) => c.name === "network.fetch" && /\/models$/.test(c.args[0])), "probed /models");
  assert.deepEqual(host.ui.headers.assistant.status, { variant: "success", label: "Ready" });
});

test("on an old host the chat says to update, and Ask isn't offered", async () => {
  const { host } = await activated({ noHost: true });
  assert.deepEqual(host.search.providers, []);
  assert.ok(viewTexts(host.ui.views.assistant).some((t) => /update the app/i.test(t) || /can't lend its tools/.test(t)));
});

test("a chat turn: read-only tool runs, the write waits for Approve, the answer lands", async () => {
  const { host } = await activated({
    modelReplies: [
      { content: "", tool_calls: [toolCall("search_library", { query: "rain" }, "a")] },
      { content: "", tool_calls: [toolCall("play_tracks", { trackIds: [3] }, "b")] },
      { content: "Playing it now.", tool_calls: [] },
    ],
    invoke: async (name) => (name === "search_library" ? { tracks: [{ id: 3 }] } : { ok: true }),
  });
  host.ui.actions.send({ query: "play something for rain" });
  await flush();
  assert.deepEqual(host.hostToolCalls.map((c) => c.name), ["search_library"], "write not yet run");
  assert.ok(viewTexts(host.ui.views.assistant).some((t) => /play_tracks\(trackIds: \[3\]\)/.test(t)), "approval card shown");
  assert.deepEqual(host.ui.badges.assistant, { type: "dot", variant: "warning", tooltip: "Waiting for your approval" });

  host.ui.actions.approve();
  await flush();
  assert.deepEqual(host.hostToolCalls.map((c) => c.name), ["search_library", "play_tracks"]);
  assert.ok(viewTexts(host.ui.views.assistant).includes("Playing it now."));
  assert.equal(host.ui.badges.assistant, null);

  // The model got a system prompt built from ours + the app's notes, and only
  // the chat feature's tools (all three here) plus web_fetch.
  const first = host.modelRequests[0];
  assert.equal(first.messages[0].role, "system");
  assert.match(first.messages[0].content, /App notes\./);
  assert.deepEqual(first.tools.map((t) => t.function.name), ["search_library", "browse", "play_tracks", "web_fetch"]);
  assert.equal(first.model, "qwen3:14b");
});

test("Deny keeps the write away from the app and tells the model", async () => {
  const { host } = await activated({
    modelReplies: [
      { content: "", tool_calls: [toolCall("play_tracks", { trackIds: [1] })] },
      { content: "Okay, I won't.", tool_calls: [] },
    ],
  });
  host.ui.actions.send({ query: "play" });
  await flush();
  host.ui.actions.deny();
  await flush();
  assert.deepEqual(host.hostToolCalls, []);
  const toolMsg = host.modelRequests[1].messages.find((m) => m.role === "tool");
  assert.match(toolMsg.content, /declined/);
});

test("a model that can't be reached shows the reason in the chat", async () => {
  const { host } = await activated({
    fetch: async (url) => {
      if (/\/models$/.test(url)) throw new Error("connection refused");
      throw new Error("connection refused");
    },
  });
  assert.deepEqual(host.ui.headers.assistant.status, { variant: "error", label: "Offline" });
  host.ui.actions.send({ query: "hi" });
  await flush();
  assert.ok(viewTexts(host.ui.views.assistant).some((t) => /Can't reach the model at 127\.0\.0\.1:11434/.test(t)));
});

test("Ask (Cmd+K) answers only grounded library tracks", async () => {
  const lib = { 3: { id: 3, title: "Jóga", artist_name: "Björk" }, 5: { id: 5, title: "Hyperballad", artist_name: "Björk" } };
  const { host } = await activated({
    modelReplies: [
      { content: "", tool_calls: [toolCall("search_library", { query: "bjork" })] },
      { content: '```json\n{"trackIds": [5, 404, 3]}\n```', tool_calls: [] },
    ],
    invoke: async (name, args) => {
      if (name === "browse") {
        if (!lib[args.id]) throw new Error("HTTP 404: no track");
        return lib[args.id];
      }
      return { tracks: Object.values(lib) };
    },
  });
  const result = await host.search.handlers.ask("icelandic art pop", 10);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.tracks.map((t) => t.title), ["Hyperballad", "Jóga"]);
  // Only read-only library tools were offered — no play, no web.
  assert.deepEqual(host.modelRequests[0].tools.map((t) => t.function.name), ["search_library", "browse"]);
});

test("Meaning explains cached lyrics; no lyrics anywhere is not_found", async () => {
  const { host } = await activated({
    cachedLyrics: "Emotional landscapes, they puzzle me",
    modelReplies: [{ content: '{"summary":"About feeling overwhelmed.","full":"Longer text."}' }],
  });
  const res = await host.infoHandlers.lyrics_meaning({ kind: "track", name: "Jóga", artistName: "Björk", id: 3 });
  assert.deepEqual(res, { status: "ok", value: { summary: "About feeling overwhelmed.", full: "Longer text." } });
  assert.deepEqual(host.modelRequests[0].response_format, { type: "json_object" });

  const bare = await activated({});
  const miss = await bare.host.infoHandlers.lyrics_meaning({ kind: "track", name: "x", id: 0 });
  assert.deepEqual(miss, { status: "not_found" });
  assert.ok(bare.host.calls.some((c) => c.name === "info.fetch"), "asked the lyrics chain before giving up");
});

test("the complete tool runs one prompt with no tools", async () => {
  const { host } = await activated({ modelReplies: [{ content: '{"genre":"trip hop"}' }] });
  const out = await host.tools.complete({ prompt: "classify", json: true });
  assert.deepEqual(out, { genre: "trip hop" });
  assert.equal(host.modelRequests[0].tools, undefined);
  await assert.rejects(host.tools.complete({}), /prompt is required/);
});

test("settings: Save and connect normalises the URL, keeps the key out of the view", async () => {
  const { host } = await activated();
  host.ui.actions.tab({ tabId: "settings" });
  host.ui.actions["set-baseUrl"]({ value: "localhost:1234/v1/" });
  host.ui.actions["set-apiKey"]({ value: " sk-test " });
  host.ui.actions.connect();
  await flush();
  assert.equal(host.storage.settings.baseUrl, "http://localhost:1234/v1");
  assert.equal(host.storage.settings.apiKey, "sk-test");
  const lastModels = host.calls.filter((c) => c.name === "network.fetch").pop();
  assert.equal(lastModels.args[0], "http://localhost:1234/v1/models");
  assert.equal(lastModels.args[1].headers.Authorization, "Bearer sk-test");
  assert.ok(!JSON.stringify(host.ui.headers.assistant).includes("sk-test"));
  assert.ok(!host.calls.some((c) => c.name === "log" && /sk-test/.test(c.args[1])));
});

test("a context-menu errand opens the view and starts its own conversation", async () => {
  const { host } = await activated({ modelReplies: [{ content: "Here's what I found.", tool_calls: [] }] });
  host.menus["fill-album"]({ kind: "album", albumId: 9, albumTitle: "OK Computer", artistName: "Radiohead" });
  await flush();
  assert.deepEqual(host.ui.navigated, ["assistant"]);
  const sent = host.modelRequests[0];
  assert.match(sent.messages[1].content, /OK Computer/);
  // fill = library + info + catalog + download + plugins: play_tracks is not in it.
  assert.ok(!sent.tools.some((t) => t.function.name === "play_tracks"));
});

test("deactivate releases a pending approval as declined", async () => {
  const { plugin, host } = await activated({ modelReplies: [{ content: "", tool_calls: [toolCall("play_tracks", {})] }, { content: "x" }] });
  host.ui.actions.send({ query: "play" });
  await flush();
  plugin.deactivate();
  await flush();
  assert.deepEqual(host.hostToolCalls, []);
  // The turn ended without another model call or an error log.
  assert.equal(host.modelRequests.length, 1);
  assert.ok(!host.calls.some((c) => c.name === "log"));
});
