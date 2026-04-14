# Refactoring plan — post v2.2.0

> **Status: P0 items shipped in v2.3.0.** `sidepanel.js` is now 435 lines
> and providers are self-contained. Remaining P1/P2 items are tracked below.
>
> Context: after the v2.1.0 module split and the v2.2.0 OpenRouter integration,
> `sidepanel.js` was back up to **600 lines** and the provider layer had grown
> a lot of hand-written boilerplate. This document lists the highest-ROI
> next steps, grouped by priority. Each item explains **why**, **what
> specifically to change**, and when relevant **what NOT to do**.

## Summary of the damage

| Before v2.2.0 | After v2.2.0 |
|---|---|
| 2 providers | 3 providers |
| `sidepanel.js`: 493 lines | **600 lines** (+107) |
| `providers.js`: 135 lines | 187 lines (+52) |
| Save handlers | 4 → 5 |
| Provider branches in sidepanel | ~10 in 6 functions |
| ID_MAP entries | 40 → 49 |

**The provider-object abstraction was only half-finished.** The LLM side (`endpoint` / `buildBody` / `listModels` / `activeModel`) is clean. The UI side is still hand-written per provider — every new provider forces edits in 8+ locations in `sidepanel.js` and `ui.js`.

---

## P0 — big wins, low risk — ✅ **DONE in v2.3.0**

### P0.1 — Declarative provider registry (the main one) — ✅ done

**Problem.** Adding Anthropic/Google/xAI today means editing:
1. `src/defaults.js` → add `{provider}ApiKey`, `{provider}Model`
2. `src/providers.js` → add provider object
3. `sidepanel.html` → add radio + fieldset
4. `src/ui.js` → add 7–9 IDs to `ID_MAP`
5. `sidepanel.js::currentProviderName` → add check
6. `sidepanel.js::applyProviderUi` → add toggle
7. `sidepanel.js::updateProviderStatus` → add branch
8. `sidepanel.js::readFormIntoSettings` → add field
9. `sidepanel.js::activeModel` → add branch
10. `sidepanel.js::applySettings` → add fields
11. `sidepanel.js::refreshXxxModels` → copy-paste
12. `sidepanel.js::wireSettingsForms` → save handler
13. `sidepanel.js::wireSettingsForms` → test handler

**Solution.** Each provider declares its entire surface inside `providers.js`:

```js
export const openrouterProvider = {
  name: 'openrouter',
  label: 'OpenRouter (300+ models, thinking off)',

  // persisted settings keys owned by this provider
  fields: {
    apiKey: 'openrouterApiKey',
    model: 'openrouterModel',
  },

  // form element IDs
  ui: {
    radio: 'provider-openrouter',
    fieldset: 'openrouter-settings',
    apiKey: 'openrouterApiKey',
    apiKeyTest: 'test-openrouter',
    apiKeyResult: 'openrouter-result',
    modelSelect: 'model-openrouter',
    modelReload: 'reload-openrouter-models',
    filter: 'openrouter-filter',            // optional
    modelCount: 'openrouter-model-count',    // optional
    save: 'save-openrouter',
  },

  endpoint(settings) { /* ... */ },
  buildBody({ model, messages, temperature }) { /* ... */ },
  async listModels(settings) { /* returns [{id, label, contextLength?}] */ },
  activeModel(settings) { return settings[this.fields.model]; },

  // optional render hook for providers that need filter/combobox
  render(state, els) { /* defaults to populateSelect */ },
};
```

Then `sidepanel.js` becomes:

```js
for (const provider of Object.values(providers)) {
  wireProvider(provider);
}
```

where `wireProvider` handles Save / Test / Reload / Filter / radio change in ~40 lines, using the ids declared on the provider.

**Wins**
- Adding Anthropic = one object in `providers.js` + one `<fieldset>` in `sidepanel.html`. Zero edits to `sidepanel.js`.
- `currentProviderName`, `applyProviderUi`, `updateProviderStatus`, `activeModel`, `readFormIntoSettings` all become one-liners that iterate over `providers`.
- `ID_MAP` in `ui.js` loses ~25 provider-specific entries — ids live on the provider.

**Cost.** ~1 day of careful surgery. Risk: medium (touches everything), but mechanical.

### P0.2 — Single source of truth for settings — ⚠️ partial (kept effectiveSettings)

**Problem.** Right now there are THREE sources of truth for any setting:
- `state.settings` (persisted)
- DOM inputs (in-progress edits)
- `chrome.storage.local` (the real persisted copy)

`currentProviderName()` reads the DOM radio, not `state.settings.provider`. `readFormIntoSettings()` is a band-aid that patches over the gap. If you save OpenAI settings but haven't pressed Save Provider, the provider radio state and `state.settings.provider` can diverge.

**Solution.** `state.settings` is SSOT. DOM is a projection.
- Input events dispatch `updateField(key, value)` which updates `state.settings` immediately (without persisting).
- Save button persists the current `state.settings` via `patchSettings` — no `readFormIntoSettings` band-aid.
- Radio changes are just another field update.
- Delete `readFormIntoSettings`.

**Cost.** Half a day. Risk: low.

### P0.3 — Collapse 4 save-handlers, 3 test-handlers, 3 refresh-handlers — ✅ done

Once P0.1 is in place, these all collapse into `wireProvider(provider)`. Just flagging that this is where the boilerplate pain lives.

Also lift the 3 API-key Test handlers into one `testProviderEndpoint(provider, apiKey)`. Same for the 3 refresh functions into `refreshProviderModels(provider)`.

**Cost.** Free once P0.1 is done. Not free otherwise.

### P0.4 — Fix provider-specific state leakage — ✅ done

`state.openrouterModelsFull` lives in the global `state` object but only the OpenRouter provider knows or cares about it. Move it onto the provider instance or into a per-provider cache `state.providerCaches.openrouter.modelsFull`.

**Cost.** Half an hour.

---

## P1 — medium-impact quality improvements

### P1.1 — Session persistence (chat history + transcript survive panel close)

Close the side panel, reopen it → empty chat, no transcript. Every time.

**Solution.** Write `state.history`, `state.transcript`, `state.meta` to `chrome.storage.session` on every change (or debounced). Read on init. `chrome.storage.session` is process-lifetime — auto-cleared on browser restart, survives panel close.

**Win.** Closing the panel no longer destroys the conversation. Switching tabs already preserves state (per-tab panel), but closing entirely doesn't.

**Cost.** A few hours. Risk: low. Care needed around message size limits (session storage is 10MB, fine for text).

### P1.2 — Naming convention sweep

Element IDs are a mix of:
- `camelCase`: `baseUrl`, `openaiApiKey`, `openrouterApiKey`, `uiFontSize`, `summaryPrompt`
- `kebab-case`: `status-dot`, `provider-local`, `test-base-url`, `model-local`

Pick one. **Recommendation: kebab-case everywhere** — that's the HTML convention and matches every other ID in the file. Rename the 7 camelCase ones. Update `ID_MAP` in `ui.js`.

**Cost.** 20 minutes. Risk: trivial.

### P1.3 — `applySettings` is 20 lines of field-by-field wiring — ✅ done

Replace with a declarative table:

```js
const FIELD_BINDINGS = [
  ['baseUrl', 'baseUrl', 'value'],
  ['openaiApiKey', 'openaiApiKey', 'value'],
  ['openrouterApiKey', 'openrouterApiKey', 'value'],
  ['temperature', 'temperature', 'value'],
  ['uiFontSize', 'uiFontSize', 'value'],
  ['chatFontSize', 'chatFontSize', 'value'],
  ['transparentAssistant', 'transparentAssistant', 'checked'],
  ['summaryPrompt', 'summaryPrompt', 'value'],
  ['summaryExamplesPrompt', 'summaryExamplesPrompt', 'value'],
];
for (const [elKey, settingKey, domProp] of FIELD_BINDINGS) {
  els[elKey][domProp] = settings[settingKey] ?? DEFAULTS[settingKey];
}
```

Plus the special cases (provider radio, strictMode chip, applyFontSizes, applyAppearance).

**Win.** Adding a setting becomes one line.

**Cost.** 30 minutes.

### P1.4 — Observability: provider/model badge on assistant messages

You can't tell which model answered what. After switching from Kimi to Claude mid-session, old messages look the same.

**Solution.** When `addMsg('assistant', text)` is called, stamp the div with a small footer like `via anthropic/claude-sonnet-4.5 · 23s · 1.2k tokens`. Cost data can come from OpenRouter response headers (`x-cost` etc.).

**Cost.** A few hours. Risk: low.

### P1.5 — Running cost counter for OpenRouter

OpenRouter returns per-request cost in the response. Track `state.sessionCost` and show it in the top bar next to the status indicator. Reset on Clear chat.

**Cost.** 1 hour. Risk: low.

### P1.6 — Keyboard shortcuts

- `Ctrl/Cmd+K` → focus composer
- `Ctrl/Cmd+L` → clear chat (with confirm)
- `Ctrl/Cmd+,` → toggle settings panel
- `Escape` → close settings / menu / stop streaming

**Cost.** 30 minutes.

### P1.7 — `populateSelect` disabled placeholder — ✅ done

Currently `"no models available"` is a selectable option. Should be `<option disabled selected>` so the user can't accidentally set it as the model.

**Cost.** 5 minutes.

---

## P2 — polish / nice-to-have

### P2.1 — Custom combobox for OpenRouter model select

Right now the Filter is a separate `<input>` above a standard `<select>`. A combobox would:
- Show pricing / context length inline
- Support arrow-key navigation of filtered results
- Let the user pin favorites
- Show recent models at the top

**Cost.** 1–2 days. Risk: UI component, lots of edge cases. **Only do this if P1.1 observability is already in place** so you have reliable telemetry on whether it helps.

### P2.2 — Import / export settings

Button in Settings → UI → "Export…" that downloads a JSON of `state.settings`. "Import…" reads it back. Useful for moving between machines.

**Gotcha.** API keys are in there. Either warn the user, or offer "export without keys".

**Cost.** A few hours.

### P2.3 — Dark/light theme toggle

Only dark exists now. Not high-priority for a power-user tool but easy.

**Cost.** A few hours (mostly CSS variable work).

### P2.4 — Localization

System prompts and error messages are in Russian; UI labels are in English. Pick one and commit. Chrome extensions have `_locales/` support — could set up `en` + `ru` and let Chrome pick.

**Cost.** Half a day. **Not recommended** — adds friction for every future UI edit, and the audience is a single-person tool.

### P2.5 — Stream error mid-response

If the network drops at token 300 of a 2000-token reply, the partial reply stays and… nothing happens. No indicator that it was cut off.

**Solution.** Append `[stream interrupted — partial]` to the bubble on non-abort errors.

**Cost.** 15 minutes.

### P2.6 — Debounce `onHistoryStateUpdated`

`chrome.webNavigation.onHistoryStateUpdated` can fire multiple times on a single navigation. Debounce by 300ms so `loadTranscript` doesn't double-fire.

**Cost.** 10 minutes. Observable benefit: tiny.

### P2.7 — Unit tests for pure functions

Node 20+ runs ES modules natively. We could test:
- `buildSystemPrompt` — strict mode, no transcript, with timestamps, etc.
- `linkifyTimestamps` — ranges, commas, invalid tokens
- `tsToSeconds` — 1:30, 1:30:00, 90
- `providers.openrouter.buildBody` — reasoning disabled

No CI needed — dev runs `node --test` locally. **Controversial** because the user has been clear they don't want test infra, but pure-function tests are fast to write and catch dumb regressions. **Only do if user asks.**

**Cost.** An afternoon.

---

## Not recommended (explicitly)

- **TypeScript.** Still overkill for this codebase size.
- **A build step** (esbuild / vite). Loses the zero-friction "reload unpacked extension" dev loop. ES modules work natively.
- **A UI framework** (Preact / Lit / React). The UI is simple; a framework adds more boilerplate than it removes.
- **A state management library** (Redux / Zustand). A plain `state` object with explicit mutations is fine at this size. Revisit if the state gets reactive.

---

## Recommended order

1. **P0.2** (SSOT for settings) — enables P0.1 without layering hacks on hacks.
2. **P0.1** (declarative provider registry) — the big payoff. Cuts the provider-addition cost by 80%.
3. **P0.4** (state leakage) — free cleanup during P0.1.
4. **P0.3** — collapses automatically once P0.1 is done.
5. **P1.1** (session persistence) — biggest user-visible win.
6. **P1.2, P1.3, P1.7** — small cleanups, batch as one commit.
7. **P1.4, P1.5** (observability) — one commit, depends on what OpenRouter actually returns in response headers (verify before implementing).
8. **P1.6** (shortcuts) — tiny, ship whenever.

Stop at P1. P2 items are optional polish and each should be evaluated independently when there's a concrete need.

---

## Open questions

1. **Provider config through declarative HTML templates?** P0.1 could go further: instead of every provider hand-writing `<fieldset>` in `sidepanel.html`, define the form declaratively on the provider object and have `wireProvider` generate the DOM. **Tradeoff:** lose design flexibility (custom filter input, custom counter, etc.). **Recommendation:** don't — keep HTML hand-written, let `ui` references on the provider object point at existing IDs.

2. **Do we care about OpenRouter's `/auth/key` endpoint?** Could show remaining credit / rate limit in the Test button. Nice but not urgent.

3. **Should `chrome.storage.local` move to `chrome.storage.sync`?** Sync across devices. Tradeoff: 100KB quota is tight for long system prompts. **Recommendation:** stay on local, add explicit export/import (P2.2) if cross-device is needed.
