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

test("an image a tool returns shows in the chat, and the model gets a note instead of the data", async () => {
  const { host } = await activated({
    hostTools: HOST_TOOLS.concat([
      { name: "get_entity_image", description: "Image", inputSchema: { type: "object", properties: {} }, readOnly: true, categories: ["info"] },
    ]),
    modelReplies: [
      { content: "", tool_calls: [toolCall("get_entity_image", { kind: "artist", name: "Björk" }, "a")] },
      { content: "Here's Björk.", tool_calls: [] },
    ],
    invoke: async () => ({ content: [{ type: "image", data: "QUJD", mimeType: "image/jpeg" }] }),
  });
  host.ui.actions.send({ query: "show me the current artist" });
  await flush();

  const chat = host.ui.views.assistant.children.find((n) => n.type === "chat");
  const turn = chat.messages[1];
  assert.deepEqual(turn.images, [{ src: "data:image/jpeg;base64,QUJD", alt: "Björk" }]);
  assert.equal(turn.text, "Here's Björk.");
  const toolMsg = host.modelRequests[1].messages.find((m) => m.role === "tool");
  assert.ok(!toolMsg.content.includes("QUJD"), "no base64 sent to the model");
  assert.match(toolMsg.content, /shown to the user/);
});

test("Stop ends the turn at once, even while the model call is still running", async () => {
  let open;
  const gate = new Promise((r) => { open = r; });
  const { host } = await activated({
    modelReplies: [
      { gate, reply: { content: "", tool_calls: [toolCall("play_tracks", { trackIds: [3] }, "a")] } },
      { content: "Second answer.", tool_calls: [] },
    ],
    invoke: async () => ({ ok: true }),
  });
  const chatOf = () => host.ui.views.assistant.children.find((n) => n.type === "chat");

  host.ui.actions.send({ query: "play something" });
  await flush();
  assert.ok(chatOf().status, "working");

  const modelCall = host.calls.find((c) => c.name === "network.fetch" && /\/chat\/completions$/.test(c.args[0]));
  assert.ok(modelCall.args[1].signal, "the model request carries a signal");
  assert.equal(modelCall.args[1].signal.aborted, false);

  host.ui.actions.stop();
  await flush();
  assert.equal(modelCall.args[1].signal.aborted, true, "Stop aborts the request, so the host drops the connection");
  assert.equal(chatOf().status, null, "idle immediately — not after the model answers");
  assert.equal(chatOf().messages.at(-1).text, "Stopped.");

  // The hung call finally lands: its tool call must not run, its answer must not show.
  open();
  await flush();
  assert.deepEqual(host.hostToolCalls, [], "the stopped turn ran nothing");
  assert.equal(chatOf().approval, null);

  // And the next message is a normal turn.
  host.ui.actions.send({ query: "again" });
  await flush();
  assert.equal(chatOf().messages.at(-1).text, "Second answer.");
  assert.equal(chatOf().status, null);
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

  // One user message, one assistant turn — the tool calls ride inside the turn
  // as folded steps, not as rows of their own.
  const chat = host.ui.views.assistant.children.find((n) => n.type === "chat");
  assert.deepEqual(chat.messages.map((m) => m.role), ["user", "assistant"]);
  assert.deepEqual(chat.messages[1].steps.map((s) => s.status), ["ok", "ok"]);
  assert.equal(chat.messages[1].text, "Playing it now.");
  assert.equal(chat.status, null, "idle once the answer landed");

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
  host.ui.actions["set-provider"]({ value: "custom" });
  host.ui.actions["set-baseUrl"]({ value: "llm.example.com/v1/" });
  host.ui.actions["set-apiKey"]({ value: " sk-test " });
  host.ui.actions.connect();
  await flush();
  assert.equal(host.storage.settings.baseUrl, "http://llm.example.com/v1");
  assert.deepEqual(host.storage.settings.keys, { custom: "sk-test" });
  const lastModels = host.calls.filter((c) => c.name === "network.fetch").pop();
  assert.equal(lastModels.args[0], "http://llm.example.com/v1/models");
  assert.equal(lastModels.args[1].headers.Authorization, "Bearer sk-test");
  assert.ok(!JSON.stringify(host.ui.headers.assistant).includes("sk-test"));
  assert.ok(!host.calls.some((c) => c.name === "log" && /sk-test/.test(c.args[1])));
});

const settingsView = (host) => host.ui.views.assistant.children;
const lastFetch = (host, re) => host.calls.filter((c) => c.name === "network.fetch" && re.test(c.args[0])).pop();

test("Claude: pick the provider, add a key, the models load and the chat sends a length cap", async () => {
  const { host } = await activated({
    models: ["claude-sonnet-5-5", "claude-haiku-4-5"],
    modelReplies: [{ content: "Hi.", tool_calls: [] }],
  });
  host.ui.actions.tab({ tabId: "settings" });
  host.ui.actions["set-provider"]({ value: "anthropic" });
  await flush();
  assert.equal(host.storage.settings.baseUrl, "https://api.anthropic.com/v1");
  assert.equal(host.storage.settings.model, "", "an Ollama model id means nothing to Anthropic");
  assert.deepEqual(host.ui.headers.assistant.status, { variant: "warning", label: "Needs a key" });
  assert.ok(!settingsView(host).some((n) => n.label === "Endpoint"), "hosted presets don't show an endpoint");

  host.ui.actions["set-apiKey"]({ value: "sk-ant-x" });
  host.ui.actions.connect();
  await flush();
  const list = lastFetch(host, /\/models/);
  assert.equal(list.args[0], "https://api.anthropic.com/v1/models?limit=100");
  assert.equal(list.args[1].headers["x-api-key"], "sk-ant-x", "Anthropic's model list wants x-api-key");
  assert.equal(list.args[1].headers["anthropic-version"], "2023-06-01");
  assert.equal(host.storage.settings.model, "claude-sonnet-5-5", "newest-first order kept");

  host.ui.actions.send({ query: "hello" });
  await flush();
  assert.equal(host.modelRequests[0].max_tokens, 8192, "Anthropic requires a reply cap");
  assert.equal(host.modelRequests[0].model, "claude-sonnet-5-5");
});

test("Claude: a workspace id rides on every request, for keys not scoped to a workspace", async () => {
  const { host } = await activated({
    models: ["claude-sonnet-5-5"],
    modelReplies: [{ content: "Hi.", tool_calls: [] }],
  });
  host.ui.actions.tab({ tabId: "settings" });
  host.ui.actions["set-provider"]({ value: "anthropic" });
  await flush();
  assert.ok(settingsView(host).some((n) => n.label === "Workspace ID"), "Claude offers a workspace field");

  host.ui.actions["set-apiKey"]({ value: "sk-ant-x" });
  host.ui.actions["set-workspaceId"]({ value: " wrkspc_01abc " });
  host.ui.actions.connect();
  await flush();
  assert.equal(host.storage.settings.workspaces.anthropic, "wrkspc_01abc");
  assert.equal(lastFetch(host, /\/models/).args[1].headers["anthropic-workspace-id"], "wrkspc_01abc");

  host.ui.actions.send({ query: "hello" });
  await flush();
  assert.equal(lastFetch(host, /\/chat\/completions/).args[1].headers["anthropic-workspace-id"], "wrkspc_01abc");

  host.ui.actions["set-provider"]({ value: "openai" });
  await flush();
  assert.ok(!settingsView(host).some((n) => n.label === "Workspace ID"), "only Claude has one");
  host.ui.actions["set-apiKey"]({ value: "sk-openai" });
  host.ui.actions.connect();
  await flush();
  assert.equal(lastFetch(host, /\/models/).args[1].headers["anthropic-workspace-id"], undefined, "never sent to another service");
});

test("each provider keeps its own key; OpenAI gets max_completion_tokens and only chat models", async () => {
  const { host } = await activated({
    models: ["gpt-5", "text-embedding-3-large", "whisper-1", "o4-mini", "dall-e-3"],
    modelReplies: [{ content: "Hi.", tool_calls: [] }],
  });
  host.ui.actions.tab({ tabId: "settings" });
  host.ui.actions["set-provider"]({ value: "openai" });
  host.ui.actions["set-apiKey"]({ value: "sk-openai" });
  host.ui.actions.connect();
  await flush();
  const model = settingsView(host).find((n) => n.type === "select" && n.label === "Model");
  assert.deepEqual(model.options.map((o) => o.value), ["gpt-5", "o4-mini"]);

  host.ui.actions.send({ query: "hello" });
  await flush();
  assert.equal(host.modelRequests[0].max_completion_tokens, 8192);
  assert.equal(host.modelRequests[0].max_tokens, undefined);

  host.ui.actions["set-provider"]({ value: "anthropic" });
  await flush();
  const keyRow = settingsView(host).find((n) => n.label === "API key");
  assert.equal(keyRow.control.value, "", "the OpenAI key isn't offered to Anthropic");
  host.ui.actions["set-provider"]({ value: "openai" });
  await flush();
  assert.equal(settingsView(host).find((n) => n.label === "API key").control.value, "sk-openai");
});

test("OpenRouter: only tool-capable models, no auto-picked model, attribution headers and a reply cap", async () => {
  const { host } = await activated({
    models: ["openai/gpt-5", "anthropic/claude-sonnet-4.5", "anthropic/claude-sonnet-4.5:batch"],
    modelReplies: [{ content: "Hi.", tool_calls: [] }],
  });
  host.ui.actions.tab({ tabId: "settings" });
  host.ui.actions["set-provider"]({ value: "openrouter" });
  await flush();
  assert.equal(host.storage.settings.baseUrl, "https://openrouter.ai/api/v1");
  assert.deepEqual(host.ui.headers.assistant.status, { variant: "warning", label: "Needs a key" });

  host.ui.actions["set-apiKey"]({ value: "sk-or-x" });
  host.ui.actions.connect();
  await flush();
  const list = lastFetch(host, /\/models/);
  assert.equal(list.args[0], "https://openrouter.ai/api/v1/models?supported_parameters=tools");
  assert.equal(list.args[1].headers.Authorization, "Bearer sk-or-x");
  assert.equal(host.storage.settings.model, "", "an aggregator's first model is arbitrary; the user picks");
  assert.deepEqual(host.ui.headers.assistant.status, { variant: "warning", label: "No model" });
  const model = settingsView(host).find((n) => n.type === "select" && n.label === "Model");
  assert.deepEqual(model.options.map((o) => o.value), ["", "anthropic/claude-sonnet-4.5", "openai/gpt-5"]);
  const fast = settingsView(host).find((n) => n.type === "select" && n.label === "Fast model");
  assert.equal(fast.options.filter((o) => o.value === "").length, 1, "one empty choice, not two");

  host.ui.actions["set-model"]({ value: "anthropic/claude-sonnet-4.5" });
  host.ui.actions.send({ query: "hello" });
  await flush();
  const chat = lastFetch(host, /\/chat\/completions/);
  assert.equal(chat.args[1].headers["X-OpenRouter-Title"], "Viboplr");
  assert.equal(chat.args[1].headers["HTTP-Referer"], "https://viboplr.com");
  assert.equal(host.modelRequests[0].max_tokens, 8192);
  assert.equal(host.modelRequests[0].model, "anthropic/claude-sonnet-4.5");

  host.ui.actions["set-provider"]({ value: "xai" });
  host.ui.actions["set-apiKey"]({ value: "xai-key" });
  host.ui.actions.connect();
  await flush();
  assert.equal(lastFetch(host, /\/models/).args[1].headers["X-OpenRouter-Title"], undefined, "never sent to another service");
});

test("OpenRouter: a long model list can be filtered by name and to free models, with prices in the labels", async () => {
  const paid = Array.from({ length: 25 }, (_, i) => ({ id: "vendor/model-" + i, name: "Vendor: Model " + i, pricing: { prompt: "0.000001", completion: "0.000002" } }));
  const { host } = await activated({
    models: paid.concat([{ id: "meta-llama/llama-3.3-70b-instruct:free", name: "Meta: Llama 3.3 70B (free)", pricing: { prompt: "0", completion: "0" } }]),
  });
  host.ui.actions.tab({ tabId: "settings" });
  host.ui.actions["set-provider"]({ value: "openrouter" });
  host.ui.actions["set-apiKey"]({ value: "sk-or-x" });
  host.ui.actions.connect();
  await flush();
  const modelSelect = () => settingsView(host).find((n) => n.type === "select" && n.label === "Model");
  const find = () => settingsView(host).find((n) => n.label === "Find a model");
  assert.equal(find().control.type, "search-input");
  assert.match(find().description, /^26 models/);
  assert.equal(modelSelect().options.find((o) => o.value === "vendor/model-3").label, "vendor/model-3 · $1 / $2 per 1M tokens");

  host.ui.actions["set-modelFilter"]({ query: "llama 70b" });
  assert.deepEqual(modelSelect().options.map((o) => o.value), ["", "meta-llama/llama-3.3-70b-instruct:free"]);
  assert.equal(modelSelect().options[1].label, "meta-llama/llama-3.3-70b-instruct:free · free");
  assert.equal(find().description, "Showing 1 of 26 models.");

  host.ui.actions["set-modelFilter"]({ query: "" });
  host.ui.actions["set-model"]({ value: "vendor/model-7" });
  host.ui.actions["set-freeOnly"]({ value: true });
  assert.equal(settingsView(host).find((n) => n.type === "toggle" && n.label === "Free models only").checked, true);
  assert.deepEqual(modelSelect().options.map((o) => o.value), ["meta-llama/llama-3.3-70b-instruct:free", "vendor/model-7"], "the chosen model never vanishes");
  assert.equal(find().description, "Showing 1 of 26 models.", "the kept choice isn't counted as a match");
});

test("a short list without prices gets no filter and no free switch", async () => {
  const { host } = await activated({ models: ["qwen3:14b", "llama3.1:8b"] });
  host.ui.actions.tab({ tabId: "settings" });
  await flush();
  assert.ok(!settingsView(host).some((n) => n.label === "Find a model" || n.label === "Free models only"));
});

test("OpenRouter without a saved key: the public list loads, but a chat says it needs a key instead of sending one without", async () => {
  const { host } = await activated({ models: ["nvidia/nemotron-3.5-lightning:free"], modelReplies: [{ content: "Hi.", tool_calls: [] }] });
  host.ui.actions.tab({ tabId: "settings" });
  host.ui.actions["set-provider"]({ value: "openrouter" });
  await flush();
  host.ui.actions.tab({ tabId: "chat" });
  host.ui.actions.tab({ tabId: "settings" }); // reopening Settings loads the (public) list
  await flush();
  host.ui.actions["set-model"]({ value: "nvidia/nemotron-3.5-lightning:free" });
  assert.deepEqual(host.ui.headers.assistant.status, { variant: "warning", label: "Needs a key" }, "not Ready without a key");

  host.ui.actions.send({ query: "hi" });
  await flush();
  assert.equal(host.modelRequests.length, 0, "no unauthenticated request");
  host.ui.actions.tab({ tabId: "chat" });
  assert.ok(viewTexts(host.ui.views.assistant).some((t) => /OpenRouter needs an API key/.test(t)));
});

test("a key typed but not saved is kept when a model is picked", async () => {
  const { host } = await activated({ models: ["nvidia/nemotron-3.5-lightning:free"], modelReplies: [{ content: "Hi.", tool_calls: [] }] });
  host.ui.actions.tab({ tabId: "settings" });
  host.ui.actions["set-provider"]({ value: "openrouter" });
  await flush();
  host.ui.actions["set-apiKey"]({ value: " sk-or-typed " });
  host.ui.actions["set-model"]({ value: "nvidia/nemotron-3.5-lightning:free" });
  await flush();
  assert.equal(host.storage.settings.keys.openrouter, "sk-or-typed");
  assert.deepEqual(host.ui.headers.assistant.status, { variant: "success", label: "Ready" });
  host.ui.actions.send({ query: "hi" });
  await flush();
  assert.equal(lastFetch(host, /\/chat\/completions/).args[1].headers.Authorization, "Bearer sk-or-typed");
});

test("a refused key says to check it", async () => {
  const { host } = await activated({ modelReplies: [{ status: 401, body: { error: { message: "Missing Authentication header", code: 401 } } }] });
  host.ui.actions.send({ query: "hello" });
  await flush();
  assert.ok(viewTexts(host.ui.views.assistant).some((t) => /didn't accept the API key.*Check the key/.test(t)));
});

test("Approve all runs the rest of the chat's changes without asking, until revoked or a new chat", async () => {
  const invoked = [];
  const { host } = await activated({
    modelReplies: [
      { content: "", tool_calls: [toolCall("play_tracks", { trackIds: [1] }, "a")] },
      { content: "", tool_calls: [toolCall("play_tracks", { trackIds: [2] }, "b")] },
      { content: "Done.", tool_calls: [] },
      { content: "", tool_calls: [toolCall("play_tracks", { trackIds: [3] }, "c")] },
    ],
    invoke: async (name, args) => { invoked.push(args.trackIds[0]); return { ok: true }; },
  });
  const chatOf = () => host.ui.views.assistant.children.find((n) => n.type === "chat");
  const headerActions = () => host.ui.headers.assistant.actions.map((a) => a.action);

  host.ui.actions.send({ query: "play two things" });
  await flush();
  assert.equal(chatOf().approval.approveAllAction, "approve-all");
  host.ui.actions["approve-all"]();
  await flush();
  assert.deepEqual(invoked, [1, 2], "the second change ran without a card");
  assert.equal(chatOf().approval, null);
  assert.match(chatOf().notice.message, /without asking/);
  assert.deepEqual(headerActions(), ["new-chat", "ask-again"]);

  host.ui.actions["ask-again"]();
  assert.equal(chatOf().notice, null);
  assert.deepEqual(headerActions(), ["new-chat"]);
  host.ui.actions.send({ query: "one more" });
  await flush();
  assert.ok(chatOf().approval, "asks again once revoked");
  assert.deepEqual(invoked, [1, 2]);
});

test("New chat ends Approve all, and works while an approval is waiting", async () => {
  const invoked = [];
  const { host } = await activated({
    modelReplies: [
      { content: "", tool_calls: [toolCall("play_tracks", { trackIds: [1] }, "a")] },
      { content: "Done.", tool_calls: [] },
      { content: "", tool_calls: [toolCall("play_tracks", { trackIds: [2] }, "b")] },
    ],
    invoke: async (name, args) => { invoked.push(args.trackIds[0]); return { ok: true }; },
  });
  const chatOf = () => host.ui.views.assistant.children.find((n) => n.type === "chat");
  host.ui.actions.send({ query: "play" });
  await flush();
  host.ui.actions["approve-all"]();
  await flush();
  host.ui.actions["new-chat"]();
  assert.deepEqual(chatOf().messages, []);
  assert.equal(chatOf().notice, null, "Approve all belonged to the old chat");

  host.ui.actions.send({ query: "play again" });
  await flush();
  assert.ok(chatOf().approval, "the new chat asks");
  host.ui.actions["new-chat"](); // mid-turn, with the card up
  await flush();
  assert.equal(chatOf().approval, null);
  assert.equal(chatOf().status, null, "not busy any more");
  assert.deepEqual(chatOf().messages, []);
  assert.deepEqual(invoked, [1], "the pending change never ran");
});

test("an out-of-credits answer says so", async () => {
  const { host } = await activated({ modelReplies: [{ status: 402, body: { error: { message: "Insufficient credits" } } }] });
  host.ui.actions.send({ query: "hello" });
  await flush();
  assert.ok(viewTexts(host.ui.views.assistant).some((t) => /out of credits.*Insufficient credits/.test(t)), "credit error shown");
});

test("when the model list fails, the model can be typed", async () => {
  const { host } = await activated({ modelsStatus: 401, modelReplies: [{ content: "Hi.", tool_calls: [] }] });
  host.ui.actions.tab({ tabId: "settings" });
  host.ui.actions["set-provider"]({ value: "xai" });
  host.ui.actions["set-apiKey"]({ value: "xai-key" });
  host.ui.actions.connect();
  await flush();
  const row = settingsView(host).find((n) => n.label === "Model");
  assert.equal(row.type, "settings-row");
  assert.equal(row.control.type, "text-input", "typed, since there is no list");

  host.ui.actions["set-model"]({ value: " grok-test " });
  host.ui.actions.send({ query: "hello" });
  await flush();
  assert.equal(host.modelRequests[0].model, "grok-test");
  assert.equal(host.modelRequests[0].max_tokens, undefined, "no cap for a provider that doesn't need one");
});

test("a 0.1.x single API key moves to the provider its endpoint belongs to", async () => {
  const { host } = await activated({ storage: { settings: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-old", model: "gpt-5" } } });
  const list = lastFetch(host, /\/models/);
  assert.equal(list.args[1].headers.Authorization, "Bearer sk-old");
  host.ui.actions.tab({ tabId: "settings" });
  assert.equal(settingsView(host).find((n) => n.label === "Provider").value, "openai");
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
