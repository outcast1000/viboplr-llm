# CLAUDE.md

Viboplr plugin `llm` ("AI Assistant"). Plugin = `index.js` (a function body
returning `{ activate, deactivate, _testHooks… }`) + `manifest.json`. Worker
runtime (`"runtime": "worker"`): no `fetch`, only `api.*`.

## Rules

- **Never hand-write tools for the app.** The agent's tools come from
  `api.assistant.host.listTools()` — the app's shared catalog (`mcp/tools.mjs` in
  the viboplr repo). New capability belongs in that catalog, not here. The only
  local tool is `web_fetch`.
- **Pick tools by category, never by name** (`FEATURES`). A tool the app adds
  later must join features through its category without a release here.
- **Every non-read-only call waits for Approve** (`isReadOnlyCall` mirrors the
  app's rule: `readOnly` or `readOnlyWhen`). Missing `readOnly` = write.
- **Grounding:** anything shown or played from a model answer is re-read through
  a tool first (`groundTrackIds`).
- The API key never goes into logs, the view or the header.

## Commands

```
npm test        # node --test (test/*.test.js), no dependencies
npm run check   # node --check index.js
```

`test/harness/sandbox.js` loads `index.js` the way the worker does and shadows
the globals the worker deletes; `test/harness/host.js` is a fake plugin API with a
scripted model endpoint.
