# Changelog


## v0.3.2
- Releases are now signed with the Viboplr plugin-signing key, so Viboplr allows the permissions this plugin asks for without prompting. Also includes: no tool calls from a reply cut off at the length limit; chat gets every host tool.

## 0.3.1

- Find a model: a long model list (OpenRouter's has hundreds) gets a filter box above it. Type any words, in any order ("llama 70b", "claude sonnet"), and the Model and Fast model lists narrow to the matches, with a "Showing N of M" count.
- Prices: on OpenRouter each model shows its price (input / output, USD per 1M tokens), or "free".
- A "Free models only" switch, when the service has free models. The model you've chosen stays in the list either way.
- Fixed: on OpenRouter you could pick a model and chat with no API key saved (its model list loads without one), and got "Missing authentication header". The status now says "Needs a key" until one is saved, the chat says the key is missing instead of sending the request, and a key typed but not yet saved with Save and connect is kept when you pick a model.
- A refused key (HTTP 401) now says to check the key in Settings.
- Approve all: the approval card gets an "Approve all in this chat" button (Viboplr 1.0.91 or newer). The rest of that chat's changes run without asking; a strip above the thread says so, with "Ask again", and the header gets an "Ask before changes" button. A new chat — or a context-menu errand, which starts one — always asks again. Settings → General → AI control still decides what the assistant may do at all.
- New chat is a button in the view header, and it works while an answer is running or an approval is waiting (it stops the answer and declines the pending change). The composer's "+" does the same on Viboplr 1.0.91+.

## 0.3.0

- OpenRouter is a provider: pick it in Settings, paste a key from openrouter.ai, and choose from the models that can call tools (the assistant needs them; the rest of OpenRouter's several hundred aren't listed, nor its slow half-price `:batch` routes). It doesn't pick a model for you — on OpenRouter the first one listed is arbitrary and may be paid. Settings saved under "Other" with OpenRouter's address move to the preset by themselves.
- Requests to OpenRouter name Viboplr, so your OpenRouter activity page shows where the usage came from.
- An "out of credits" answer (HTTP 402) from any service now says so plainly, instead of a bare HTTP error.
- The model list starts with "Choose a model…" while none is chosen, instead of looking like its first entry was picked.

## 0.2.1

- Claude: the API key hint says to give the key a workspace scope (e.g. Default workspace), not Organization.
- Claude: an optional Workspace ID in Settings. An Anthropic key made outside a workspace was refused ("must include the anthropic-workspace-id header") — paste the workspace's ID and it's sent with every request.

## 0.2.0

- The chat looks like a chat: your messages as bubbles on the right, answers as formatted text (headings, lists, tables, code, links) with a Copy button, and the composer pinned to the bottom (Enter sends, Shift+Enter adds a line).
- Tool calls fold into the answer they belong to — one "Used 3 tools" row per turn, click to see each call and any error. The approval card sits inline in the thread.
- Stop is the send button while an answer runs, and it stops at once — before, it waited for the model to finish its current reply (minutes on a slow local model), and the next message could revive the stopped turn. A reply that arrives after Stop is dropped and runs nothing. Stop also cancels the request itself, so the model server stops generating. "+" starts a new chat; the model name under the composer opens Settings.
- Pictures in the chat: ask for the current artist's photo or an album cover and it shows up in the answer. Image data no longer goes to the model as text (it used to be cut off mid-way and waste its context) — the model just hears that the picture was shown.
- Providers: Settings starts with a Provider choice — Ollama, LM Studio, Claude (Anthropic), OpenAI, Grok (xAI), or any other OpenAI-compatible service. Hosted presets fill in the address; each provider keeps its own API key (a 0.1.x key moves to the provider its endpoint belonged to).
- Claude works: its model list loads (it needs Anthropic's own key header), and replies are capped at 8192 tokens, which Anthropic requires. OpenAI gets `max_completion_tokens` (newer models refuse `max_tokens`) and a model list without embedding, speech and image models.
- When a service can't list its models, type the model id instead of being stuck.
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
