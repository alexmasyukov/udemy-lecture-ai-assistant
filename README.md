# Udemy Lecture AI Assistant

Chrome extension for working with Udemy lectures via a local LLM (LM Studio or any OpenAI-compatible endpoint). It extracts the transcript of the current lecture, summarizes it, and answers questions about it — or works as a plain chat when no transcript is loaded.

## Features

- Pulls the transcript via the official Udemy API (`/api-2.0/.../lectures/.../?fields[asset]=captions`) — does not depend on whether the on-page transcript panel is open.
- Defaults to manual English captions; falls back to any English track, then manual, then the first available.
- Automatically reloads the transcript on SPA navigation between lectures (via `chrome.webNavigation.onHistoryStateUpdated`).
- If the content script has not been injected into the tab yet, the side panel injects it on demand via `chrome.scripting.executeScript`.
- Timestamps are passed into the system prompt so the model can cite `[mm:ss]`.
- Streaming responses: tokens appear as they are generated (SSE, just like ChatGPT).
- Assistant replies are rendered as Markdown via vendored `marked.js` (GFM: tables, code, lists, etc.).
- **Summary** button — the model picks its own structure and length.
- Free chat works even without a loaded transcript.
- **Lecture context only** toggle (on by default) — strict mode, answers come only from the transcript. Turn it off to ask general questions that the model answers from its own knowledge.
- Configurable UI and chat font sizes.
- Optional transparent background for assistant replies.
- Local model via OpenAI-compatible API (defaults to LM Studio at `http://127.0.0.1:1234/v1`).
- DOM fallback that scrapes the on-page transcript panel if the API path fails.

## Installation

1. Clone this repository.
2. Open `chrome://extensions/` and enable **Developer mode** (top-right corner).
3. Click **Load unpacked** and select the extension folder.
4. Launch [LM Studio](https://lmstudio.ai) and start the local server (**Developer → Start Server**). By default it listens on `127.0.0.1:1234`.
5. Load any model (the extension ships with `gemma-4-e4b-it` as the default).

## Usage

1. Open a Udemy lecture: `https://www.udemy.com/course/.../learn/lecture/...`.
2. Click the extension icon in the Chrome toolbar — the side panel opens on the right.
3. Press **Reload transcript** — the extension pulls all cues via the API. Switching to another lecture reloads it automatically.
4. Press **Summary** for an automatic summary, or just type a question in the field at the bottom.
5. **Lecture context only** (top bar): when enabled, replies are strictly grounded in the transcript. When disabled, the model can freely bring in general knowledge.

Settings (⚙ in the top-right corner):

- **Base URL** — OpenAI-compatible API endpoint.
- **Model** — dropdown of models pulled from `/v1/models`. The ↻ button refreshes the list.
- **Temperature** — sampling temperature (defaults to `0.3`).
- **UI font size** — interface font size (defaults to `13px`).
- **Chat font size** — chat font size (defaults to `16px`).
- **Transparent assistant background** — removes the bubble around assistant messages.

## Project layout

```
.
├── manifest.json            # MV3 manifest
├── background.js            # service worker: settings + /v1/models proxy
├── content.js               # reads courseId/lectureId, hits captions API, parses VTT
├── sidepanel.html           # side panel UI
├── sidepanel.css            # dark theme, CSS variables for fonts
├── sidepanel.js             # UI logic, streaming chat, history, settings
└── vendor/
    └── marked.min.js        # markdown → HTML (MIT)
```

## How the transcript is fetched

1. The page `/course/{slug}/learn/lecture/{id}` exposes an element with a `data-module-args` attribute whose JSON payload contains `courseId`.
2. `lectureId` is read from the URL (`/lecture/{id}`) so it stays fresh across SPA transitions. `initialCurriculumItemId` from `data-module-args` is only used as a fallback.
3. The content script calls:
   ```
   GET /api-2.0/users/me/subscribed-courses/{courseId}/lectures/{lectureId}/?fields[asset]=captions
   ```
   (the user's cookies are sent automatically via `credentials: 'include'`).
4. The response contains a `captions` array with signed VTT URLs for every available language.
5. Manual English is selected → VTT is downloaded → parsed into `{start, end, text}[]`.
6. The timestamped text is injected into the LLM system prompt.

## How the chat works

Requests to the LLM (`/v1/chat/completions` with `stream: true`) are made **directly** from the side panel (host_permissions cover `127.0.0.1`), bypassing the service worker. The response is read via `ReadableStream.getReader()`, SSE lines (`data: {...}`) are parsed, and `choices[0].delta.content` is accumulated — the assistant bubble is re-rendered through `marked.parse()` on every chunk.

Each request contains:

- **system**: instructions plus the optional timestamped transcript.
- **history**: previous user/assistant pairs from the current session.
- **user**: the new message.

The chat history lives in memory inside the side panel and is **preserved** when switching between lectures — only the transcript in the system prompt changes. It is cleared when the panel is closed.

## Why it's fine to resend the transcript on every call

LLM APIs are completely stateless. What we call "chat history" is just the `messages` array that the client sends on every request. There is no server-side memory, neither in LM Studio nor in OpenAI.

LM Studio (llama.cpp under the hood) does **prompt prefix caching** on the KV cache: if the prefix of the messages is identical to the previous request — and the system prompt with the transcript does not change between questions about the same lecture — the model does not recompute those tokens. So the second and subsequent questions hit the prompt-eval stage almost instantly; only the generated tokens add latency.

The cache is invalidated when the transcript changes (e.g. switching lectures) or when you toggle strict mode, at which point llama.cpp recomputes from the point where the prefix diverges.

## Known limitations

- The side panel does not survive being closed — the chat history is lost.
- Long lectures (>80k tokens) may not fit into the model context — chunking is not implemented.
- The content script is injected automatically on SPA navigation, but already-open tabs need a reload the first time the extension is installed — this is standard Chrome behavior.

## License

MIT
