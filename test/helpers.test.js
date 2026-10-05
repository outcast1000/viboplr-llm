const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

test("normalizeBaseUrl defaults, adds a scheme and drops trailing slashes", () => {
  assert.equal(plugin._normalizeBaseUrl(""), "http://127.0.0.1:11434/v1");
  assert.equal(plugin._normalizeBaseUrl("localhost:1234/v1/"), "http://localhost:1234/v1");
  assert.equal(plugin._normalizeBaseUrl("https://api.example.com/v1//"), "https://api.example.com/v1");
});

test("hostOf names the server for messages", () => {
  assert.equal(plugin._hostOf("http://127.0.0.1:11434/v1"), "127.0.0.1:11434");
  assert.equal(plugin._hostOf("https://openrouter.ai/api/v1"), "openrouter.ai");
});

test("parseChatResponse reads content and tool calls, tolerating stringified args", () => {
  const out = plugin._parseChatResponse({
    choices: [{ message: { content: null, tool_calls: [{ id: "1", function: { name: "browse", arguments: '{"kind":"track","id":3}' } }, { function: { name: "get_status" } }] } }],
  });
  assert.equal(out.content, "");
  assert.deepEqual(out.toolCalls, [
    { id: "1", name: "browse", args: { kind: "track", id: 3 } },
    { id: "call_1", name: "get_status", args: {} },
  ]);
});

test("parseChatResponse flags arguments that aren't JSON instead of guessing", () => {
  const out = plugin._parseChatResponse({ choices: [{ message: { tool_calls: [{ id: "x", function: { name: "t", arguments: "{bad" } }] } }] });
  assert.deepEqual(out.toolCalls[0].args, { __unparsed: "{bad" });
});

test("parseChatResponse surfaces an API error body", () => {
  assert.throws(() => plugin._parseChatResponse({ error: { message: "model not found" } }), /model not found/);
  assert.throws(() => plugin._parseChatResponse({}), /no answer/);
});

test("extractJson finds the object inside prose or a fence", () => {
  assert.deepEqual(plugin._extractJson('Sure!\n```json\n{"trackIds":[1,2]}\n```'), { trackIds: [1, 2] });
  assert.deepEqual(plugin._extractJson('Here: {"a": {"b": 1}} done'), { a: { b: 1 } });
  assert.equal(plugin._extractJson("no json here"), null);
  assert.equal(plugin._extractJson("{broken"), null);
});

test("htmlToText keeps readable text and drops scripts and styles", () => {
  const html = "<html><head><title>T</title><style>p{}</style></head><body><script>evil()</script><h1>Björk</h1><p>Icelandic&nbsp;singer &amp; composer.</p></body></html>";
  const text = plugin._htmlToText(html);
  assert.equal(text, "Björk\nIcelandic singer & composer.");
});

test("describeCall shows the call compactly", () => {
  assert.equal(plugin._describeCall("get_status", {}), "get_status()");
  assert.equal(plugin._describeCall("play_tracks", { trackIds: [1, 2] }), "play_tracks(trackIds: [1,2])");
});

test("truncate marks what it cut", () => {
  assert.equal(plugin._truncate("abc", 5), "abc");
  assert.match(plugin._truncate("abcdef", 3), /^abc\n…\[truncated 3 characters\]$/);
});

test("every context-menu entry seeds a prompt with the ids it was given", () => {
  const multi = plugin._promptForMenu("upgrade", { kind: "multi-track", trackIds: [4, 5] });
  assert.equal(multi.feature, "upgrade");
  assert.match(multi.text, /ids 4, 5/);
  const fill = plugin._promptForMenu("fill-album", { kind: "album", albumId: 9, albumTitle: "OK Computer", artistName: "Radiohead" });
  assert.equal(fill.feature, "fill");
  assert.match(fill.text, /"OK Computer" by Radiohead \(library album id 9\)/);
  for (const id of ["ask-track", "ask-album", "ask-artist", "cleanup"]) {
    assert.ok(plugin._promptForMenu(id, { title: "x" }), id);
  }
  assert.equal(plugin._promptForMenu("nope", {}), null);
});

test("providerForUrl recognises presets, including settings saved before them", () => {
  assert.equal(plugin._providerForUrl("https://api.anthropic.com/v1").id, "anthropic");
  assert.equal(plugin._providerForUrl("https://api.x.ai/v1").id, "xai");
  assert.equal(plugin._providerForUrl("http://localhost:11434/v1").id, "ollama");
  assert.equal(plugin._providerForUrl("http://127.0.0.1:1234/v1").id, "lmstudio");
  assert.equal(plugin._providerForUrl("https://openrouter.ai/api/v1").id, "openrouter", "settings saved under Other move to the preset");
  assert.equal(plugin._providerForUrl("https://example.com/v1").id, "custom");
});

test("modelIds filters and orders per provider", () => {
  const openai = plugin._PROVIDERS.find((p) => p.id === "openai");
  const anthropic = plugin._PROVIDERS.find((p) => p.id === "anthropic");
  assert.deepEqual(plugin._modelIds({ data: [{ id: "tts-1" }, { id: "gpt-5" }, { id: "chatgpt-4o-latest" }] }, openai), ["chatgpt-4o-latest", "gpt-5"]);
  assert.deepEqual(plugin._modelIds({ data: [{ id: "claude-z" }, { id: "claude-a" }] }, anthropic), ["claude-z", "claude-a"]);
  assert.deepEqual(plugin._modelIds({ models: [{ name: "b" }, { name: "a" }] }, null), ["a", "b"]);
});

test("takeImages moves pictures to the chat and leaves the model a note", () => {
  const out = plugin._takeImages({ content: [{ type: "image", data: "AAAA", mimeType: "image/jpeg" }] }, "get_entity_image", "Björk");
  assert.deepEqual(out.images, [{ src: "data:image/jpeg;base64,AAAA", alt: "Björk" }]);
  assert.ok(!JSON.stringify(out.result).includes("AAAA"), "no base64 reaches the model");
  assert.match(JSON.stringify(out.result), /shown to the user/);

  // The host's raw-body shape, and an https url from a direct plugin resolve.
  assert.equal(plugin._takeImages({ base64: "BBBB", mimeType: "image/png" }, "x").images[0].src, "data:image/png;base64,BBBB");
  assert.equal(plugin._takeImages({ url: "https://img.example/a.jpg" }, "get_entity_image").images[0].src, "https://img.example/a.jpg");

  // Nothing to take: the same object back; non-images and plain http are ignored.
  const plain = { tracks: [{ id: 1 }] };
  assert.equal(plugin._takeImages(plain, "search_library").result, plain);
  assert.deepEqual(plugin._takeImages({ base64: "CCCC", mimeType: "text/html" }, "x").images, []);
  assert.deepEqual(plugin._takeImages({ url: "http://img.example/a.jpg" }, "get_entity_image").images, []);
});
