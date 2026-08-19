SF Translation Workbench (Chrome Extension)

**Reviewed:** `TranslationUploader-main.zip`
**Scope:** `manifest.json`, `background.js`, `sidepanel.html/css/js`, `lib/sfSession.js`, `lib/toolingApi.js`, `lib/metadataApi.js`

## 1. What it does

A Manifest V3 side-panel extension for Salesforce admins. It shows every enabled
Translation Workbench language as a column, for two record types, on one screen:

- **Custom Labels** (`ExternalString` / `ExternalStringLocalization`, via Tooling API REST)
- **Validation Rule error messages** (via Metadata API SOAP `retrieve`/`deploy`, since there's
  no Tooling sObject for these)

Auth comes from reading the active tab's Salesforce `sid` session cookie — no OAuth
connected app required. All requests go to the user's own org (`*.my.salesforce.com`
derived from the active tab); nothing is sent to a third-party server.

## 2. Architecture

```
sidepanel.js  ──uses──►  SfSession (cookie → session)
              ──uses──►  ToolingApi (REST: Custom Labels)
              ──uses──►  MetadataApi (SOAP: Validation Rule translations, via JSZip)
background.js ──opens the side panel on toolbar-icon click
```

Clean separation of concerns: session resolution, REST client, and SOAP client are
each self-contained IIFEs exposed as globals, consumed by the UI layer. No framework,
no build step — plain script tags. Reasonable choice for an internal admin tool.

## 3. Strengths

- **No remote code / no CDN scripts.** CSP is `script-src 'self'; object-src 'self'`,
  and JSZip is meant to be vendored locally rather than pulled from unpkg/CDN — correct
  call for MV3, since remote-hosted code is disallowed anyway.
- **HTML injection is handled.** All Salesforce-sourced text rendered into the DOM
  (label names, master values, translated values) goes through `escapeHtml()` before
  being interpolated into template strings. This is the main XSS risk in an app that
  builds HTML via string concatenation, and it's covered on every text field I checked.
- **Scoped API surface.** `host_permissions` lists only Salesforce/Force.com domain
  families; `fetch` calls are built from `session.apiHost`, which is derived from the
  *active tab's own URL*, not user input — so there's no way to point the extension's
  authenticated requests at an arbitrary host.
- **Sensible SOAP/merge logic.** `mergeValidationRuleTranslations()` re-parses the
  existing `<Translations>` file and only touches the `<validationRules>` nodes being
  edited, leaving `customLabels`/`reports`/etc. in that file untouched — avoids
  clobbering unrelated translations on deploy.
- **Race-window mitigation, honestly documented.** Validation Rule saves re-`retrieve()`
  the file immediately before merging/deploying to shrink the window against a
  concurrent editor, and the README is upfront that this reduces rather than eliminates
  the race (Metadata API has no optimistic locking). Good that this limitation is
  surfaced rather than glossed over.
- **Dirty-cell tracking is correct.** Save compares `input.value` against
  `input.defaultValue` (the value at render time), so only touched cells are sent —
  matches the stated "only edited cells are saved" behavior.

## 4. Bugs

### 4.1 Missing dependency — breaks Validation Rules tab (blocking)
`sidepanel.html` loads `lib/jszip.min.js`, but that file is **not included** in the
zip. `metadataApi.js` calls `JSZip.loadAsync(...)` / `new JSZip()` unconditionally in
`retrieveTranslationXml` and `deployTranslationXml`. Without the file, any attempt to
open the Validation Rules tab throws `JSZip is not defined` and the tab never loads.

The README explains this is intentional — the author didn't want to hand-paste
minified third-party code into the repo — but it means **the extension is non-functional
out of the box** until someone manually adds `lib/jszip.min.js` (e.g. `npm i jszip`,
copy `dist/jszip.min.js`). This must be done before packaging for distribution, whether
that's Chrome Web Store or internal unpacked install.

### 4.2 `saveCustomLabels` — dead/confusing call-signature branching (minor)
```js
async function saveCustomLabels(session, languageOrUpdates, updatesArray) {
  let language = '';
  let updates = [];
  if (Array.isArray(languageOrUpdates)) {
    updates = languageOrUpdates;
  } else {
    language = languageOrUpdates;
    updates = updatesArray || [];
  }
  ...
```
Only the array-first call pattern (`saveCustomLabels(session, rowsToSave)`) is ever
used from `sidepanel.js`. The `(session, language, updates)` branch is unreachable
dead code that adds complexity without payoff — worth deleting unless there's a
planned second caller.

### 4.3 Validation Rule save has no confirmation of partial failure across languages (minor)
`saveData()`'s validation-rule branch loops languages sequentially and calls
`MetadataApi.saveValidationRules` per language. If language 2 of 3 fails, the `catch`
reports the error, but language 1's deploy already succeeded and language 3 is never
attempted — the status message doesn't distinguish "nothing saved" from "partially
saved." Not a security issue, but worth a status-line tweak (e.g. "Saved fr; failed on
de, stopped before ja") so admins aren't surprised on retry.

### 4.4 `EntityDefinitionId` chunking guards against `IN ()` but not against SOQL injection risk pattern (informational, not currently exploitable)
`getValidationRuleMasters` builds a `WHERE DurableId IN ('id1','id2')` clause via
string concatenation with a manual `'` → `\'` escape:
```js
const quoted = chunk.map((id) => `'${id.replace(/'/g, "\\'")}'`).join(',');
```
`durableIds` here only ever contains values Salesforce itself returned from a prior
query (`EntityDefinitionId` off `ValidationRule` records), not user input, so this
isn't reachable as an injection vector today. Flagging only because if this pattern is
copied elsewhere for a field that *does* accept free text, the escaping is incomplete
(SOQL bind-safe escaping needs more than single-quote handling). Prefer Tooling API's
`?q=` with values sourced strictly from prior query results, as is already the case
here, and avoid reusing this string-building style for anything user-editable.

### 4.5 Empty-value save/create asymmetry (minor, likely intentional but worth confirming)
In `saveCustomLabels`, editing an *existing* localization to empty string sends an
`UPDATE` with `Value: ''` (translation effectively cleared but record kept). Clearing
a cell that never had a translation (`localizationId` empty) is silently skipped — no
record created, which is correct (avoids creating empty localization rows) but means
"delete this translation" and "never had one" end up looking identical in the UI after
a refresh. Fine as designed, just worth a one-line README note so it's not mistaken for
a bug later.

## 5. Security review

- **Session handling:** reads the `sid` HttpOnly cookie via `chrome.cookies.get()`,
  scoped to the derived API host of the *active* Salesforce tab only. The session
  value is held in memory (`state.session`) for the life of the side panel, never
  written to `chrome.storage` or logged. Good — an extension holding a live Salesforce
  session token is inherently sensitive, and this doesn't persist it anywhere.
- **No data leaves Salesforce + the browser.** Every `fetch`/SOAP call targets
  `session.apiHost`, which is always a Salesforce-family domain matching
  `host_permissions`. There's no analytics, telemetry, or third-party endpoint anywhere
  in the code.
- **CSP is locked down** (`script-src 'self'; object-src 'self'`) and there's no
  `eval`, `new Function`, or remote script injection anywhere.
- **XSS surface is covered** — see §3, `escapeHtml()` is applied consistently to
  Salesforce-sourced strings rendered as text/attribute values. IDs interpolated
  unescaped (`data-external-id`, `data-localization-id`) are Salesforce record IDs
  (fixed 15/18-char alphanumeric format), not free text, so this isn't exploitable.
- **Permissions are broader than strictly necessary in one spot:** manifest requests
  both `tabs` and `activeTab`. The only tab API usage is
  `chrome.tabs.query({active: true, currentWindow: true})` inside a session-init flow
  triggered by the user opening the side panel — this is exactly the kind of access
  `activeTab` alone is designed to grant. `tabs` is a broader, persistent permission
  (visibility into all tabs' URLs, not just the active one at invocation time) that
  isn't used anywhere in the code. Worth testing with `tabs` removed; dropping it
  reduces the permission footprint and the odds of extra scrutiny in store review.

## 6. Fix-before-shipping checklist

| # | Item | Severity |
|---|------|----------|
| 1 | Add real `lib/jszip.min.js` (vendor per README instructions) — extension is broken without it | **Blocking** |
| 2 | Confirm `tabs` permission can be dropped (only `activeTab` usage observed) | Should-fix |
| 3 | Remove dead 3-arg branch in `ToolingApi.saveCustomLabels` | Nice-to-have |
| 4 | Improve status messaging for partial multi-language save failures | Nice-to-have |
| 5 | Note the "clear vs. never-translated" empty-cell behavior in README/UI copy | Nice-to-have |

## 7. Bottom line

The code is competent, single-purpose, and doesn't do anything a Chrome reviewer
would flag as malicious — no remote code, no data exfiltration, consistent output
escaping, tightly scoped host permissions. The one functional blocker is the missing
`jszip.min.js` file; everything else is polish. The `cookies` permission and session-
token handling are the right design for this problem (no OAuth app to provision), but
expect Chrome Web Store's manual review to ask for justification given how sensitive
that permission is — worth having a one-paragraph explanation ready (reads the active
Salesforce tab's own session cookie solely to authenticate Tooling/Metadata API calls
to that same org; never transmitted or stored elsewhere).
