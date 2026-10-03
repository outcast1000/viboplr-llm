const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

const TOOLS = [
  { name: "search_library", description: "Search", inputSchema: { type: "object", properties: { query: { type: "string" } } }, readOnly: true, categories: ["library"] },
  { name: "play_tracks", description: "Play", inputSchema: { type: "object", properties: { trackIds: { type: "array" } } }, readOnly: false, categories: ["playback", "queue"] },
  { name: "collections", description: "Collections", inputSchema: { type: "object", properties: { action: { type: "string" } } }, readOnly: false, readOnlyWhen: { action: ["list"] }, categories: ["library"] },
];

/** A model that answers from a script, recording what it was sent. */
function scripted(replies) {
  const seen = [];
  return {
    seen,
    chat(messages, tools) {
      seen.push({ messages: messages.slice(), tools });
      const next = replies.shift();
      if (!next) throw new Error("script ran out");
      return Promise.resolve(next);
    },
  };
}

function call(name, args, id) {
  return { id: id || "c_" + name, name, args };
}

// --- runAgent ------------------------------------------------------------------

test("a plain answer ends the loop in one step", async () => {
  const model = scripted([{ content: "Hello!", toolCalls: [] }]);
  const out = await plugin._runAgent({ chat: model.chat, tools: TOOLS, invoke: () => assert.fail("no tool"), confirm: () => assert.fail("no confirm"), messages: [{ role: "user", content: "hi" }] });
  assert.equal(out.text, "Hello!");
  assert.equal(out.steps, 1);
  assert.equal(out.stopped, null);
});

test("read-only tools run without asking and their result goes back to the model", async () => {
  const model = scripted([
    { content: "", toolCalls: [call("search_library", { query: "Björk" })] },
    { content: "Found it.", toolCalls: [] },
  ]);
  const invoked = [];
  const out = await plugin._runAgent({
    chat: model.chat,
    tools: TOOLS,
    invoke: async (name, args) => { invoked.push([name, args]); return { tracks: [{ id: 7 }] }; },
    confirm: () => assert.fail("read-only must not ask"),
    messages: [{ role: "user", content: "find bjork" }],
  });
  assert.deepEqual(invoked, [["search_library", { query: "Björk" }]]);
  assert.equal(out.text, "Found it.");
  const second = model.seen[1].messages;
  const toolMsg = second.find((m) => m.role === "tool");
  assert.equal(toolMsg.tool_call_id, "c_search_library");
  assert.deepEqual(JSON.parse(toolMsg.content), { tracks: [{ id: 7 }] });
  // The assistant turn is echoed back in OpenAI shape.
  const asst = second.find((m) => m.role === "assistant");
  assert.equal(asst.tool_calls[0].function.name, "search_library");
  assert.deepEqual(JSON.parse(asst.tool_calls[0].function.arguments), { query: "Björk" });
});

test("a write waits for approval; approved runs, declined never reaches the app", async () => {
  for (const approve of [true, false]) {
    const model = scripted([
      { content: "", toolCalls: [call("play_tracks", { trackIds: [1, 2] })] },
      { content: "done", toolCalls: [] },
    ]);
    const invoked = [];
    const asked = [];
    await plugin._runAgent({
      chat: model.chat,
      tools: TOOLS,
      invoke: async (name) => { invoked.push(name); return { ok: true }; },
      confirm: async (c) => { asked.push(c.name); return approve; },
      messages: [{ role: "user", content: "play" }],
    });
    assert.deepEqual(asked, ["play_tracks"]);
    assert.deepEqual(invoked, approve ? ["play_tracks"] : []);
    if (!approve) {
      const toolMsg = model.seen[1].messages.find((m) => m.role === "tool");
      assert.match(toolMsg.content, /declined/);
    }
  }
});

test("readOnlyWhen makes a listing call free and the same tool's write gated", async () => {
  const model = scripted([
    { content: "", toolCalls: [call("collections", { action: "list" }, "a"), call("collections", { action: "rescan", collectionId: 1 }, "b")] },
    { content: "ok", toolCalls: [] },
  ]);
  const asked = [];
  await plugin._runAgent({
    chat: model.chat,
    tools: TOOLS,
    invoke: async () => ({}),
    confirm: async (c) => { asked.push(c.args.action); return true; },
    messages: [{ role: "user", content: "x" }],
  });
  assert.deepEqual(asked, ["rescan"]);
});

test("an unknown (hallucinated) tool is refused back to the model, not invoked", async () => {
  const model = scripted([
    { content: "", toolCalls: [call("delete_everything", {})] },
    { content: "sorry", toolCalls: [] },
  ]);
  await plugin._runAgent({ chat: model.chat, tools: TOOLS, invoke: () => assert.fail("must not invoke"), confirm: () => assert.fail("must not ask"), messages: [] });
  const toolMsg = model.seen[1].messages.find((m) => m.role === "tool");
  assert.match(toolMsg.content, /Unknown tool/);
});

test("a tool error is handed to the model as data, the loop goes on", async () => {
  const model = scripted([
    { content: "", toolCalls: [call("search_library", { query: "x" })] },
    { content: "The app said no.", toolCalls: [] },
  ]);
  const out = await plugin._runAgent({
    chat: model.chat,
    tools: TOOLS,
    invoke: async () => { throw new Error("HTTP 403: Turn on Downloads"); },
    confirm: async () => true,
    messages: [],
  });
  assert.equal(out.text, "The app said no.");
  assert.match(model.seen[1].messages.find((m) => m.role === "tool").content, /HTTP 403/);
});

test("the step cap stops a model that never finishes", async () => {
  const loop = { content: "", toolCalls: [call("search_library", { query: "again" })] };
  const model = scripted([loop, loop, loop, loop]);
  const out = await plugin._runAgent({ chat: model.chat, tools: TOOLS, invoke: async () => ({}), confirm: async () => true, maxSteps: 3, messages: [] });
  assert.equal(out.stopped, "steps");
  assert.equal(model.seen.length, 3);
});

test("cancelling stops between steps", async () => {
  let cancelled = false;
  const model = scripted([{ content: "", toolCalls: [call("search_library", {})] }, { content: "never", toolCalls: [] }]);
  const out = await plugin._runAgent({
    chat: model.chat,
    tools: TOOLS,
    invoke: async () => { cancelled = true; return {}; },
    confirm: async () => true,
    isCancelled: () => cancelled,
    messages: [],
  });
  assert.equal(out.stopped, "cancelled");
  assert.equal(model.seen.length, 1);
});

test("arguments that weren't JSON are bounced back, not invoked", async () => {
  const model = scripted([{ content: "", toolCalls: [call("search_library", { __unparsed: "{oops" })] }, { content: "ok", toolCalls: [] }]);
  await plugin._runAgent({ chat: model.chat, tools: TOOLS, invoke: () => assert.fail("must not invoke"), confirm: async () => true, messages: [] });
  assert.match(model.seen[1].messages.find((m) => m.role === "tool").content, /not valid JSON/);
});

test("huge tool results are truncated before they reach the model", async () => {
  const model = scripted([{ content: "", toolCalls: [call("search_library", {})] }, { content: "ok", toolCalls: [] }]);
  await plugin._runAgent({ chat: model.chat, tools: TOOLS, invoke: async () => "x".repeat(50000), confirm: async () => true, messages: [] });
  const content = model.seen[1].messages.find((m) => m.role === "tool").content;
  assert.ok(content.length < 9000);
  assert.match(content, /truncated/);
});

// --- tool selection ---------------------------------------------------------------

test("features pick tools by category; Ask gets read-only library tools only", () => {
  const ask = plugin._selectTools(TOOLS, plugin._FEATURES.ask).map((t) => t.name);
  assert.deepEqual(ask, ["search_library"]);
  const chat = plugin._selectTools(TOOLS.concat([plugin._WEB_FETCH_TOOL]), plugin._FEATURES.chat).map((t) => t.name);
  assert.deepEqual(chat, ["search_library", "play_tracks", "collections", "web_fetch"]);
  const cleanup = plugin._selectTools(TOOLS, plugin._FEATURES.cleanup).map((t) => t.name);
  assert.ok(!cleanup.includes("play_tracks"));
});

test("a tool the app adds later joins every feature that shares its category", () => {
  const newTool = { name: "find_similar", description: "", inputSchema: {}, readOnly: true, categories: ["library"] };
  for (const f of ["ask", "about", "fill", "upgrade", "cleanup", "tags", "chat"]) {
    const names = plugin._selectTools(TOOLS.concat([newTool]), plugin._FEATURES[f]).map((t) => t.name);
    assert.ok(names.includes("find_similar"), f);
  }
});

test("isReadOnlyCall mirrors the app's rule", () => {
  assert.equal(plugin._isReadOnlyCall(TOOLS[0], {}), true);
  assert.equal(plugin._isReadOnlyCall(TOOLS[1], {}), false);
  assert.equal(plugin._isReadOnlyCall(TOOLS[2], { action: "list" }), true);
  assert.equal(plugin._isReadOnlyCall(TOOLS[2], { action: "rescan" }), false);
  assert.equal(plugin._isReadOnlyCall(null, {}), false);
  // Missing readOnly is a write — fail safe.
  assert.equal(plugin._isReadOnlyCall({ name: "x" }, {}), false);
});

test("toOpenAITools always sends an object schema", () => {
  const spec = plugin._toOpenAITools([{ name: "t", description: "d", inputSchema: null }]);
  assert.deepEqual(spec, [{ type: "function", function: { name: "t", description: "d", parameters: { type: "object", properties: {} } } }]);
});

// --- grounding -----------------------------------------------------------------

test("groundTrackIds keeps only ids the library confirms, deduped and in order", async () => {
  const lib = { 3: { id: 3, title: "C" }, 1: { id: 1, title: "A" } };
  const rows = await plugin._groundTrackIds([3, "1", 3, 99, -4, "x", 1], async (id) => {
    if (!lib[id]) throw new Error("HTTP 404");
    return lib[id];
  });
  assert.deepEqual(rows.map((r) => r.id), [3, 1]);
});

test("rowToPluginTrack is metadata-only (the library resolver finds the file)", () => {
  const t = plugin._rowToPluginTrack({ id: 4, title: "Jóga", artist_name: "Björk", album_title: "Homogenic", duration_secs: 305, path: "a/b.flac" });
  assert.deepEqual(t, { title: "Jóga", artist_name: "Björk", album_title: "Homogenic", duration_secs: 305 });
});
