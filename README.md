# AI Assistant for Viboplr

An AI assistant inside [Viboplr](https://github.com/outcast1000/viboplr), running on
**your own model** — a local one (Ollama, LM Studio, llama.cpp server) or any
OpenAI-compatible service.

- **Chat** — "play something mellow for a rainy Sunday, nothing I played this week",
  "which songs did I like but forget?", "tidy up my genre tags".
- **Right-click** — *Ask AI about this…* (track / album / artist), *Find missing
  tracks* (album), *Find better copies*, *Clean up titles*.
- **Cmd+K** — *Search on AI Assistant* answers with tracks from your library.
- **Track detail → Meaning** — what the lyrics are about, with key lines translated.
- **For other plugins** — the `complete` assistant tool runs a prompt through your model.

## How it works

The assistant doesn't bring its own tools. It uses **Viboplr's own AI tools** —
the same catalog the app's MCP server gives Claude or any outside assistant —
through `api.assistant.host`, running in-process behind the app's control API.
So:

- It needs **Settings → General → AI control** turned on.
- Anything that changes something (playing, tags, files, downloads) **waits for
  your Approve** in the chat, and still needs the matching switch on that
  Settings page.
- When Viboplr adds a tool, the assistant gets it without an update here. Each
  feature picks tools by category (library, playback, tags, catalog…), so a small
  local model only sees the handful it needs.

The only tool of its own is `web_fetch`, for reading about an artist or album on
the web (it cites the page).

## Setup

1. Run a model that supports tool calling, e.g. with Ollama:
   ```
   brew install ollama && brew services start ollama
   ollama pull qwen3:14b
   ```
   If answers ignore the tools, raise Ollama's context window
   (`OLLAMA_CONTEXT_LENGTH=32768`) — the tool descriptions take room.
2. In Viboplr, turn on **Settings → General → AI control**.
3. Install this plugin, approve its permissions, open **AI Assistant** →
   **Settings**, and press **Save and connect**. The default endpoint is Ollama's
   (`http://127.0.0.1:11434/v1`); LM Studio is `http://127.0.0.1:1234/v1`. A hosted
   service takes its base URL and an API key.

## Permissions

| Permission | Why |
|---|---|
| `assistant:host` | Use Viboplr's AI tools |
| `network:*` | Your model endpoint can be anywhere you point it, and `web_fetch` reads public pages |
| `library:read` | Read a track's cached lyrics for the Meaning tab |
| `plugins:call` | Fetch lyrics through your lyrics providers when none are cached |

## Development

```
npm test          # node --test, no dependencies
npm run check     # syntax check
scripts/package.sh
```

Live-test against a dev build of Viboplr with Settings → Debug → dev plugin path
pointing at this folder. Releases: bump `manifest.json`, add a `CHANGELOG.md`
section, tag `vX.Y.Z` and push the tag — CI packages and publishes.
