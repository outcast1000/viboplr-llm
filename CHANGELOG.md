# Changelog

## 0.2.0

- The chat looks like a chat: your messages as bubbles on the right, answers as formatted text (headings, lists, tables, code, links) with a Copy button, and the composer pinned to the bottom (Enter sends, Shift+Enter adds a line).
- Tool calls fold into the answer they belong to — one "Used 3 tools" row per turn, click to see each call and any error. The approval card sits inline in the thread.
- Stop is the send button while an answer runs, and it stops at once — before, it waited for the model to finish its current reply (minutes on a slow local model), and the next message could revive the stopped turn. A reply that arrives after Stop is dropped and runs nothing. Stop also cancels the request itself, so the model server stops generating. "+" starts a new chat; the model name under the composer opens Settings.
- Needs Viboplr 1.0.90 or newer (the host's new chat view).

## 0.1.0

- First release. An AI assistant inside Viboplr, running on your own model — Ollama, LM Studio, llama.cpp or any OpenAI-compatible service.
- Chat view: ask for music in plain words; quick starts for moods, forgotten favourites, tag tidying and messy titles.
- Uses Viboplr's own AI tools (the same catalog its MCP server offers), behind Settings → General → AI control. Anything that changes something waits for your Approve.
- Right-click: Ask AI about a track / album / artist, Find missing tracks (album), Find better copies, Clean up titles.
- Cmd+K: "Search on AI Assistant" returns tracks from your library — only ones that really exist.
- Track detail: a Meaning tab that explains the lyrics (and translates key lines).
- `complete` assistant tool, so other plugins can use the model you configured.
- Needs Viboplr 1.0.85 or newer.
