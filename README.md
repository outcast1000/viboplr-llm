# AI Assistant for Viboplr

An AI assistant inside [Viboplr](https://github.com/outcast1000/viboplr), running on
**your own model** — a local one (Ollama, LM Studio, llama.cpp server), Claude,
OpenAI, Grok, or any other OpenAI-compatible service.

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

Open **AI Assistant → Settings** and pick a **Provider**:

| Provider | What you need |
|---|---|
| Ollama / LM Studio | The app running on this computer (see below). Free, private. |
| Claude (Anthropic) | An API key from platform.claude.com → Settings → API keys (pay as you go). A Claude.ai Pro/Max subscription doesn't work here. |
| OpenAI | An API key from platform.openai.com. |
| Grok (xAI) | An API key from console.x.ai. |
| Other | Any OpenAI-compatible endpoint with tool calling, and its key if it needs one. |

Paste the key, press **Save and connect**, and pick a model. If the service
doesn't list its models, type the model id. Each provider keeps its own key, so
switching back and forth doesn't lose one. Hosted services bill you per use; every
turn sends the tool descriptions, so a long agentic answer costs more than a chat
reply.

Claude, OpenAI and Grok are reached through their OpenAI-compatible endpoints.
For Claude that endpoint ignores "answer in JSON" (the Meaning tab copes) and has
no prompt caching.

### A local model

1. Run a model that supports tool calling, e.g. with Ollama:
   ```
   brew install ollama && brew services start ollama
   ollama pull qwen3:14b
   ```
   If answers ignore the tools, raise Ollama's context window
   (`OLLAMA_CONTEXT_LENGTH=32768`) — the tool descriptions take room.
2. In Viboplr, turn on **Settings → General → AI control**.
3. Install this plugin, approve its permissions, open **AI Assistant** →
   **Settings**, pick **Ollama** (or **LM Studio**) and press **Save and connect**.
   Change the endpoint only if your server isn't at the default address.

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
