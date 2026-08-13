# SF Translation Workbench (Chrome Extension)

Side-panel tool that shows **every enabled Translation Workbench
language on one screen**, for both Custom Labels and Validation Rule
error messages — no per-language switching, no Apex, no OAuth app to
configure.

## 1. What the screen looks like

Each tab is a matrix: one row per Custom Label (or per Validation Rule),
one column per enabled language. Cells that already have a translation
are pre-filled; cells with no translation yet are blank and directly
editable. Edit any cell inline, and only the cells you actually touched
get saved — untouched cells, and untouched languages, are left alone.

```
+---------------------------------------------------------------------+
| Label Name   | Category | Master Value | fr        | de       | ja |
|--------------|----------|--------------|-----------|----------|----|
| Greeting     | General  | Hello        | [Bonjour] | [      ] |... |
| Farewell     | General  | Goodbye      | [       ] | [Auf...] |... |
+---------------------------------------------------------------------+
```

The first few columns (name/category/master value) stay pinned while
you scroll horizontally through language columns.

## 2. Architecture

```
+-------------------------------------------------------------------+
| Side Panel - single screen, 2 tabs, every enabled language as a   |
| column in one matrix table                                        |
|  Tab 1: Custom Labels           Tab 2: Validation Rules            |
+---------------+-----------------------------------+---------------+
                |                                     |
        ToolingApi.js                          MetadataApi.js
     (Tooling API REST,                      (Metadata API SOAP:
      fetch + Bearer token)                   retrieve/deploy/listMetadata,
                |                              via JSZip for zip payloads)
                |                                     |
        ExternalString /                      Translations metadata
        ExternalStringLocalization             (<lang>.translation,
                                                 validationRules node)
```

Session comes from `chrome.cookies.get()` reading the active tab's `sid`
cookie (see `lib/sfSession.js`) — no OAuth app, no connected app setup,
no client id/secret to manage. This only works while you have the target
org open and logged in in the active browser tab. The org id used for
Metadata API SOAP calls is parsed straight out of the session id
(`sid.split('!')[0]`), so no separate login/lookup call is needed.

### Why two APIs

- **Custom Labels** are real Tooling API sObjects (`ExternalString` /
  `ExternalStringLocalization`) — plain REST, synchronous, no deploy.
  `ToolingApi.getCustomLabelsMatrix()` fetches all labels and all
  languages' localizations in two queries total (not one query per
  language) and assembles the matrix client-side.

- **Validation rule error-message translations** only exist inside the
  `Translations` metadata bundle — there's no Tooling sObject for them.
  `MetadataApi.getValidationRuleTranslationsForLanguages()` retrieves
  one `<lang>.translation` file per enabled language (sequential SOAP
  `retrieve()`/poll round-trips — this is the slower part of a page
  load with several languages enabled) and parses out the
  `<validationRules>` nodes for display.

Because this runs in plain JS (not Apex), the SOAP envelopes for
`listMetadata` / `retrieve` / `checkRetrieveStatus` / `deploy` /
`checkDeployStatus` are just built as template strings and parsed with
`DOMParser` — no WSDL2Apex code-generation step is needed here (that
was an Apex-specific requirement in the LWC/Apex version of this tool).

## 3. Save behavior (grouped by language)

- **Custom Labels**: dirty cells are tracked per `(label, language)`
  pair. On Save, `ToolingApi.saveCustomLabelMatrixUpdates()` groups them
  by language and issues one Tooling API create/update per changed cell
  — synchronous, no deploy queue involved.

- **Validation Rules**: dirty cells are tracked the same way, but since
  each language lives in one deployable file, Save groups changes by
  language and, **for each affected language only**: re-`retrieve()`s
  the current file (to shrink the race window with a concurrent edit
  from someone else), merges in just the changed `<validationRules>`
  entries (every other node in that file — customLabels, reports,
  whatever else is already translated — is left untouched), then
  `deploy()`s it. Languages are processed **sequentially**, not in
  parallel, to avoid metadata deploy lock contention on the same org;
  the status line shows which language/phase is in flight
  (`Retrieving fr (1/3)…`, `Deploying fr (1/3)…`).

## 4. Required third-party dependency: JSZip

Manifest V3's content security policy blocks remotely-loaded scripts, so
JSZip must be vendored locally rather than pulled from a CDN `<script>`
tag. Grab the official build and drop it in:

```
lib/jszip.min.js
```

JSZip doesn't publish GitHub Releases — get it one of these ways:
- `npm i jszip` (currently 3.10.1), then copy
  `node_modules/jszip/dist/jszip.min.js`
- `https://github.com/Stuk/jszip/blob/v3.10.1/dist/jszip.min.js` -> click
  **Raw** -> Save As (the rendered GitHub page itself is not the file)
- `https://unpkg.com/jszip@3.10.1/dist/jszip.min.js` -> Save As

Pin a specific version for reproducible builds. This project was built
against the 3.x API (`JSZip.loadAsync`, `zip.generateAsync`,
`zip.file()`), stable across the 3.x line.

JSZip's minified source isn't pasted into this deliverable — it's a
large, third-party-maintained file, and hand-transcribing minified code
from memory risks silently shipping a broken/corrupted build. Same
reasoning as depending on `MetadataService.cls`/`Zippex.cls` in the
Apex/LWC version of this tool: vendor the real, official artifact
rather than a reconstruction.

## 5. Install (unpacked, for internal/admin use)

1. Add `lib/jszip.min.js` as described above.
2. Go to `chrome://extensions`, enable **Developer mode** (top right).
3. Click **Load unpacked**, select the `sf-translation-ext` folder.
4. Pin the extension, open your Salesforce org in a tab, click the
   extension icon — the side panel opens, detects the org, lists its
   enabled languages, and loads both matrices.

## 6. Known limitations / things to verify before rolling out broadly

- **Page-load cost scales with language count**: Custom Labels load in
  two queries regardless of language count, but Validation Rules do one
  sequential Metadata API retrieve per language — an org with many
  enabled languages will take proportionally longer to populate that
  tab. The status line reports progress per language rather than
  leaving a blank spinner.
- **Custom domains**: `host_permissions` covers `*.salesforce.com`,
  `*.force.com`, `*.my.salesforce.com`, `*.lightning.force.com`,
  `*.visualforce.com`, `*.cloudforce.com` (sandboxes). An org on a fully
  vanity Enhanced Domain that doesn't resolve through one of those
  suffixes will need an extra host permission entry added to
  `manifest.json`.
- **`sid` cookie visibility**: if the org enforces a session security
  policy that scopes the session cookie more restrictively, or the user
  has cookie-blocking extensions that also intercept `chrome.cookies`,
  session detection can fail — the panel surfaces this as an explicit
  error rather than failing silently.
- **Concurrent edits**: Validation Rule saves re-retrieve each affected
  language's file immediately before merging/deploying, to shrink —
  not eliminate — the race window with another admin editing the same
  file. Metadata API deploy has no optimistic-locking primitive; last
  deploy wins, same as Setup UI behavior. If two admins are editing
  different languages at once, there's no conflict, since each language
  is an independent file.
- **Deploy latency**: Validation Rule saves are asynchronous
  (retrieve+deploy per affected language); the UI shows status text
  through each phase rather than a fixed spinner, and multiple changed
  languages are deployed one at a time, not in parallel.
- This extension calls the API **with the permissions of whoever is
  logged into the active tab** — it inherits their access, it does not
  elevate it. Treat distributing this extension the same as distributing
  any tool with Setup access: restrict to trusted admins.
