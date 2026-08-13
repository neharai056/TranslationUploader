/* global SfSession, ToolingApi, MetadataApi */

// Fallback if the org's enabled Translation Workbench languages can't be
// auto-detected (e.g. listMetadata restricted). Auto-detected languages
// always take priority — see initSession().
const DEFAULT_LANGUAGES = ['es', 'fr', 'de', 'ja'];

// Friendly display names for common language codes. Any code not listed
// here just falls back to showing the raw code, uppercased.
const LANGUAGE_NAMES = {
  es: 'Spanish', fr: 'French', de: 'German', ja: 'Japanese',
  en: 'English', en_US: 'English (US)', pt: 'Portuguese', pt_BR: 'Portuguese (Brazil)',
  it: 'Italian', nl: 'Dutch', zh_CN: 'Chinese (Simplified)', zh_TW: 'Chinese (Traditional)',
  ko: 'Korean', ru: 'Russian', sv: 'Swedish', da: 'Danish', fi: 'Finnish',
  no: 'Norwegian', pl: 'Polish', tr: 'Turkish', th: 'Thai', vi: 'Vietnamese',
  he: 'Hebrew', ar: 'Arabic', cs: 'Czech', hu: 'Hungarian', ro: 'Romanian',
  id: 'Indonesian', ms: 'Malay'
};

const state = {
  session: null,
  activeTab: 'labels', // 'labels' | 'validation'
  languages: [], // all languages shown as columns, populated in initSession()
  customLabels: [],
  validationRules: [],
  searchQuery: ''
};

document.addEventListener('DOMContentLoaded', () => {
  initUI();
  initSession();
});

function initUI() {
  document.getElementById('tabLabels').addEventListener('click', () => switchTab('labels'));
  document.getElementById('tabValidation').addEventListener('click', () => switchTab('validation'));
  document.getElementById('btnRefresh').addEventListener('click', () => loadData());
  document.getElementById('btnSave').addEventListener('click', () => saveData());

  // Search box event listener
  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value.toLowerCase().trim();
    applySearchFilter();
  });
}

async function initSession() {
  try {
    showStatus('Detecting active Salesforce session...');
    state.session = await SfSession.getSession();

    if (!state.session) {
      showStatus('No active Salesforce session found. Open Salesforce in a tab and refresh.', true);
      return;
    }

    showStatus(`Connected to ${state.session.apiHost || state.session.domain || 'Salesforce'}. Detecting enabled languages...`);

    try {
      const enabled = await MetadataApi.getEnabledLanguages(state.session);
      state.languages = (enabled && enabled.length > 0) ? enabled : DEFAULT_LANGUAGES;
    } catch (err) {
      console.warn('Could not auto-detect enabled languages, using defaults.', err);
      state.languages = DEFAULT_LANGUAGES;
    }

    showStatus(`Connected. Showing ${state.languages.length} language(s): ${state.languages.join(', ')}`);
    await loadData();
  } catch (err) {
    showStatus(`Session initialization failed: ${err.message}`, true);
  }
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));

  if (tab === 'labels') {
    document.getElementById('tabLabels').classList.add('active');
  } else {
    document.getElementById('tabValidation').classList.add('active');
  }

  // Clear search query on tab switch
  state.searchQuery = '';
  const searchInput = document.getElementById('search-input');
  if (searchInput) searchInput.value = '';

  loadData();
}

async function loadData() {
  if (!state.session) return;
  showStatus('Loading data...');

  try {
    if (state.activeTab === 'labels') {
      // ToolingApi.getCustomLabels already supports an array of languages,
      // returning row.translations[lang] = { localizationId, value } for each.
      state.customLabels = await ToolingApi.getCustomLabels(state.session, state.languages);
      renderCustomLabelsTable(state.customLabels);
    } else {
      const rules = await ToolingApi.getValidationRuleMasters(state.session);

      // Validation rule translations live in one Translations metadata file
      // per language, so we have to retrieve each language separately.
      const perLangMaps = {};
      for (const lang of state.languages) {
        showStatus(`Loading ${languageLabel(lang)} validation rule translations...`);
        perLangMaps[lang] = await MetadataApi.readValidationRuleTranslations(state.session, lang);
      }

      state.validationRules = rules.map((r) => {
        const translations = {};
        state.languages.forEach((lang) => {
          const map = perLangMaps[lang];
          translations[lang] = { value: (map && map.get(r.fullName)) || '' };
        });
        return { ...r, translations };
      });
      renderValidationRulesTable(state.validationRules);
    }
    showStatus('Data loaded successfully.');
  } catch (err) {
    showStatus(`Loading failed: ${err.message}`, true);
  }
}

function applySearchFilter() {
  if (state.activeTab === 'labels') {
    renderCustomLabelsTable(state.customLabels);
  } else {
    renderValidationRulesTable(state.validationRules);
  }
}

function renderCustomLabelsTable(data) {
  const container = document.getElementById('content');
  if (!container) return;

  const langs = state.languages;

  const filtered = data.filter((row) => {
    const q = state.searchQuery;
    if (!q) return true;
    return (row.name || '').toLowerCase().includes(q);
  });

  if (filtered.length === 0) {
    container.innerHTML = '<p class="empty-msg">No Custom Labels match your search.</p>';
    return;
  }

  let html = `
    <div class="table-scroll">
    <table class="translation-table">
      <thead>
        <tr>
          <th class="sticky-col col-name">Name</th>
          <th class="sticky-col col-master">Master Value</th>
          ${langs.map((lang) => `<th>${escapeHtml(languageLabel(lang))}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
  `;

  filtered.forEach((row) => {
    const cells = langs.map((lang) => {
      const t = (row.translations && row.translations[lang]) || {};
      const locId = t.localizationId || '';
      const val = t.value || '';
      return `
        <td>
          <input
            type="text"
            class="inline-translation-input"
            data-external-id="${row.externalStringId}"
            data-localization-id="${locId}"
            data-lang="${lang}"
            value="${escapeHtml(val)}"
            placeholder="Enter translation..."
          />
        </td>
      `;
    }).join('');

    html += `
      <tr data-external-id="${row.externalStringId}">
        <td class="label-name sticky-col col-name"><strong>${escapeHtml(row.name)}</strong></td>
        <td class="master-value sticky-col col-master">${escapeHtml(row.masterValue)}</td>
        ${cells}
      </tr>
    `;
  });

  html += `</tbody></table></div>`;
  container.innerHTML = html;
}

function renderValidationRulesTable(data) {
  const container = document.getElementById('content');
  if (!container) return;

  const langs = state.languages;

  const filtered = data.filter((row) => {
    const q = state.searchQuery;
    if (!q) return true;
    return (row.fullName || '').toLowerCase().includes(q);
  });

  if (filtered.length === 0) {
    container.innerHTML = '<p class="empty-msg">No Validation Rules match your search.</p>';
    return;
  }

  let html = `
    <div class="table-scroll">
    <table class="translation-table">
      <thead>
        <tr>
          <th class="sticky-col col-name">Rule Name</th>
          <th class="sticky-col col-master">Master Error Message</th>
          ${langs.map((lang) => `<th>${escapeHtml(languageLabel(lang))}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
  `;

  filtered.forEach((row) => {
    const cells = langs.map((lang) => {
      const t = (row.translations && row.translations[lang]) || {};
      const val = t.value || '';
      return `
        <td>
          <input
            type="text"
            class="inline-vr-input"
            data-full-name="${escapeHtml(row.fullName)}"
            data-lang="${lang}"
            value="${escapeHtml(val)}"
            placeholder="Enter translation..."
          />
        </td>
      `;
    }).join('');

    html += `
      <tr data-full-name="${escapeHtml(row.fullName)}">
        <td class="label-name sticky-col col-name"><strong>${escapeHtml(row.fullName)}</strong></td>
        <td class="master-value sticky-col col-master">${escapeHtml(row.masterErrorMessage)}</td>
        ${cells}
      </tr>
    `;
  });

  html += `</tbody></table></div>`;
  container.innerHTML = html;
}

async function saveData() {
  if (!state.session) return;
  showStatus('Saving changes...');

  try {
    if (state.activeTab === 'labels') {
      const inputs = document.querySelectorAll('.inline-translation-input');
      const rowsToSave = [];

      inputs.forEach((input) => {
        const val = input.value.trim();
        const initialVal = input.defaultValue.trim();

        // Detect edited or newly added translations, in any language column
        if (val !== initialVal) {
          rowsToSave.push({
            externalStringId: input.dataset.externalId,
            localizationId: input.dataset.localizationId || null,
            language: input.dataset.lang,
            value: val
          });
        }
      });

      if (rowsToSave.length > 0) {
        const langCount = new Set(rowsToSave.map((r) => r.language)).size;
        await ToolingApi.saveCustomLabels(state.session, rowsToSave);
        showStatus(`Saved ${rowsToSave.length} translation(s) across ${langCount} language(s)!`);
        await loadData();
      } else {
        showStatus('No changes detected.');
      }
    } else {
      const inputs = document.querySelectorAll('.inline-vr-input');

      // Group edited cells by language, since each language is a separate
      // Metadata API retrieve+deploy round trip.
      const byLang = new Map(); // lang -> Map(fullName -> value)

      inputs.forEach((input) => {
        const val = input.value.trim();
        const initialVal = input.defaultValue.trim();
        if (val !== initialVal) {
          const lang = input.dataset.lang;
          if (!byLang.has(lang)) byLang.set(lang, new Map());
          byLang.get(lang).set(input.dataset.fullName, val);
        }
      });

      if (byLang.size === 0) {
        showStatus('No changes detected.');
        return;
      }

      let savedCount = 0;
      for (const [lang, updatesMap] of byLang.entries()) {
        showStatus(`Saving ${languageLabel(lang)} validation rule translations...`);
        await MetadataApi.saveValidationRules(state.session, lang, updatesMap);
        savedCount += updatesMap.size;
      }

      showStatus(`Saved ${savedCount} translation(s) across ${byLang.size} language(s)!`);
      await loadData();
    }
  } catch (err) {
    console.error('Save error details:', err);
    showStatus(`Save failed: ${err.message}`, true);
  }
}

function languageLabel(code) {
  const name = LANGUAGE_NAMES[code];
  return name ? `${name} (${code})` : code;
}

function showStatus(msg, isError = false) {
  const el = document.getElementById('status');
  if (el) {
    el.textContent = msg;
    el.style.color = isError ? '#c23934' : '#16325c';
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
