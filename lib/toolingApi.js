/**
 * Tooling API REST client — used for Custom Labels, which are real
 * queryable/updatable sObjects (ExternalString / ExternalStringLocalization).
 * There is no equivalent Tooling sObject for validation rule message
 * translations — see metadataApi.js for that path.
 */
const ToolingApi = (() => {
  const API_VERSION = 'v61.0';

  function baseUrl(apiHost) {
    return `https://${apiHost}/services/data/${API_VERSION}/tooling`;
  }

  async function request(session, method, path, body) {
    const res = await fetch(baseUrl(session.apiHost) + path, {
      method,
      headers: {
        Authorization: `Bearer ${session.sessionId}`,
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Tooling API ${method} ${path} failed [${res.status}]: ${text}`);
    }
    if (res.status === 204) {
      return null;
    }
    return res.json();
  }

  async function query(session, soql) {
    const data = await request(session, 'GET', `/query/?q=${encodeURIComponent(soql)}`);
    return (data && data.records) || [];
  }

  async function updateRecord(session, sobjectType, id, fields) {
    return request(session, 'PATCH', `/sobjects/${sobjectType}/${id}`, fields);
  }

  async function createRecord(session, sobjectType, fields) {
    return request(session, 'POST', `/sobjects/${sobjectType}`, fields);
  }

  // ---- Custom Labels -----------------------------------------------

  async function getCustomLabels(session, availableLanguages = []) {
    // Defensively convert string/Set/array to ensure forEach safety
    let targetLangs = [];
    if (Array.isArray(availableLanguages)) {
      targetLangs = availableLanguages;
    } else if (typeof availableLanguages === 'string' && availableLanguages.trim() !== '') {
      targetLangs = [availableLanguages];
    } else if (availableLanguages instanceof Set) {
      targetLangs = Array.from(availableLanguages);
    }

    const soql = 'SELECT Id, Name, MasterLabel, Category, Value FROM ExternalString WHERE (NamespacePrefix = null) ORDER BY Name';
const externalStrings = await query(session, soql);


    if (externalStrings.length === 0) return [];

    const localizations = await query(
      session,
      'SELECT Id, ExternalStringId, Language, Value FROM ExternalStringLocalization'
    );

    const localizationMap = new Map();
    for (const loc of localizations) {
      if (!localizationMap.has(loc.ExternalStringId)) {
        localizationMap.set(loc.ExternalStringId, new Map());
      }
      localizationMap.get(loc.ExternalStringId).set(loc.Language, {
        id: loc.Id,
        value: loc.Value || ''
      });
    }

    return externalStrings.map((rec) => {
      const langMap = localizationMap.get(rec.Id) || new Map();
      const translations = {};

      targetLangs.forEach((lang) => {
        const loc = langMap.get(lang);
        translations[lang] = {
          localizationId: loc ? loc.id : null,
          value: loc ? loc.value : ''
        };
      });

      return {
        externalStringId: rec.Id,
        name: rec.Name,
        category: rec.Category || '',
        masterValue: rec.Value || '',
        translations
      };
    }).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }

async function saveCustomLabels(session, languageOrUpdates, updatesArray) {
  let language = '';
  let updates = [];

  // Handle both 2-argument and 3-argument call patterns seamlessly
  if (Array.isArray(languageOrUpdates)) {
    updates = languageOrUpdates;
  } else {
    language = languageOrUpdates;
    updates = updatesArray || [];
  }

  for (const item of updates) {
    if (!item.externalStringId || item.value === undefined) continue;

    const targetLang = item.language || language;

    if (item.localizationId) {
      // Update existing ExternalStringLocalization record
      await updateRecord(session, 'ExternalStringLocalization', item.localizationId, {
        Value: item.value || item.translatedValue || ''
      });
    } else {
      const val = (item.value !== undefined ? item.value : item.translatedValue) || '';
      if (val.trim() !== '') {
        // Create new ExternalStringLocalization record
        await createRecord(session, 'ExternalStringLocalization', {
          ExternalStringId: item.externalStringId,
          Language: targetLang,
          Value: val
        });
      }
    }
  }
}

  // ---- Validation Rule master text ----------------------------------

  async function getValidationRuleMasters(session) {
    const rules = await query(
      session,
      'SELECT Id, ValidationName, Active, ErrorMessage, EntityDefinitionId FROM ValidationRule'
    );
    if (rules.length === 0) return [];

    const durableIds = Array.from(new Set(rules.map((r) => r.EntityDefinitionId).filter(Boolean)));
    const objectNameByDurableId = new Map();

    const CHUNK_SIZE = 50;
    for (let i = 0; i < durableIds.length; i += CHUNK_SIZE) {
      const chunk = durableIds.slice(i, i + CHUNK_SIZE);
      const quoted = chunk.map((id) => `'${id.replace(/'/g, "\\'")}'`).join(',');
      const entities = await query(
        session,
        `SELECT DurableId, QualifiedApiName FROM EntityDefinition WHERE DurableId IN (${quoted})`
      );
      for (const e of entities) {
        objectNameByDurableId.set(e.DurableId, e.QualifiedApiName);
      }
    }

    const result = rules
      .map((r) => {
        const objectName = objectNameByDurableId.get(r.EntityDefinitionId);
        if (!objectName) return null;
        return {
          fullName: `${objectName}.${r.ValidationName}`,
          objectName,
          ruleName: r.ValidationName,
          active: r.Active,
          masterErrorMessage: r.ErrorMessage || ''
        };
      })
      .filter(Boolean);

    result.sort((a, b) => a.fullName.localeCompare(b.fullName));
    return result;
  }

  return { query, getCustomLabels, saveCustomLabels, getValidationRuleMasters };
})();
