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
