/**
 * Raw SOAP client for the parts of the Metadata API this tool needs:
 * listMetadata, retrieve, checkRetrieveStatus, deploy, checkDeployStatus.
 * All against the "Translations" metadata type, since validation rule
 * error-message translations only exist inside that bundle (there is no
 * Tooling API sObject for them).
 *
 * Requires JSZip (vendored locally in lib/jszip.min.js — see README).
 */
const MetadataApi = (() => {
  const API_VERSION = '61.0';
  const MAX_POLLS = 30;

  function endpoint(session) {
    return `https://${session.apiHost}/services/Soap/m/${API_VERSION}/${session.orgId}`;
  }

  function envelope(session, bodyXml) {
    return (
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ' +
      'xmlns:met="http://soap.sforce.com/2006/04/metadata">' +
      '<soapenv:Header>' +
      '<met:SessionHeader><met:sessionId>' + escapeXml(session.sessionId) + '</met:sessionId></met:SessionHeader>' +
      '</soapenv:Header>' +
      '<soapenv:Body>' + bodyXml + '</soapenv:Body>' +
      '</soapenv:Envelope>'
    );
  }

  function escapeXml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  async function soapCall(session, operationBodyXml) {
    const res = await fetch(endpoint(session), {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=UTF-8',
        SOAPAction: '""'
      },
      body: envelope(session, operationBodyXml)
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Metadata API call failed [${res.status}]: ${extractFaultString(text) || text}`);
    }
    const fault = extractFaultString(text);
    if (fault) {
      throw new Error(`Metadata API fault: ${fault}`);
    }
    return new DOMParser().parseFromString(text, 'text/xml');
  }

  function extractFaultString(xmlText) {
    const match = xmlText.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i);
    return match ? match[1] : null;
  }

  function textOf(parent, tagName) {
    const el = getElementsByLocalName(parent, tagName)[0];
    return el ? el.textContent : null;
  }

  function getElementsByLocalName(parent, tagName) {
    // Namespace-agnostic: SOAP responses prefix elements (e.g. "met:...")
    // depending on server serialization, so match on local name.
    const all = parent.getElementsByTagName('*');
    const out = [];
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const local = el.localName || el.nodeName.split(':').pop();
      if (local === tagName) out.push(el);
    }
    return out;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---- listMetadata: which languages are enabled -------------------

  async function getEnabledLanguages(session) {
    const body =
      '<met:listMetadata>' +
      '<met:queries><met:type>Translations</met:type></met:queries>' +
      '<met:asOfVersion>' + API_VERSION + '</met:asOfVersion>' +
      '</met:listMetadata>';
    const doc = await soapCall(session, body);
    const results = getElementsByLocalName(doc, 'result');
    const languages = results
      .map((r) => textOf(r, 'fullName'))
      .filter(Boolean);
    return Array.from(new Set(languages)).sort();
  }

  // ---- retrieve: pull the Translations file for one language -------

  async function retrieveTranslationXml(session, languageCode) {
    const retrieveBody =
      '<met:retrieve>' +
      '<met:retrieveRequest>' +
      '<met:apiVersion>' + API_VERSION + '</met:apiVersion>' +
      '<met:singlePackage>true</met:singlePackage>' +
      '<met:unpackaged>' +
      '<met:types><met:members>' + escapeXml(languageCode) + '</met:members><met:name>Translations</met:name></met:types>' +
      '<met:version>' + API_VERSION + '</met:version>' +
      '</met:unpackaged>' +
      '</met:retrieveRequest>' +
      '</met:retrieve>';

    const startDoc = await soapCall(session, retrieveBody);
    const asyncId = textOf(startDoc, 'id');
    if (!asyncId) {
      throw new Error('Metadata API retrieve() did not return an async process id.');
    }

    let waitMs = 1000;
    for (let i = 0; i < MAX_POLLS; i++) {
      await sleep(waitMs);
      const pollBody =
        '<met:checkRetrieveStatus>' +
        '<met:asyncProcessId>' + escapeXml(asyncId) + '</met:asyncProcessId>' +
        '<met:includeZip>true</met:includeZip>' +
        '</met:checkRetrieveStatus>';
      const pollDoc = await soapCall(session, pollBody);
      const done = textOf(pollDoc, 'done') === 'true';
      if (done) {
        const status = textOf(pollDoc, 'status');
        if (status !== 'Succeeded') {
          const msgs = getElementsByLocalName(pollDoc, 'problem').map((m) => m.textContent).join('; ');
          throw new Error(`Retrieve did not succeed (status: ${status}). ${msgs}`);
        }
        const zipBase64 = textOf(pollDoc, 'zipFile');
        return extractTranslationXmlFromZip(zipBase64, languageCode);
      }
      waitMs = Math.min(waitMs * 2, 5000);
    }
    throw new Error(`Retrieve timed out. Async process id: ${asyncId}`);
  }

  async function extractTranslationXmlFromZip(zipBase64, languageCode) {
    if (!zipBase64) return null; // language activated but nothing translated yet
    const zip = await JSZip.loadAsync(zipBase64, { base64: true });
    const entryPath = `unpackaged/translations/${languageCode}.translation`;
    const entry = zip.file(entryPath);
    if (!entry) return null;
    return entry.async('string');
  }

  // ---- deploy: push an updated Translations file back ---------------

  async function deployTranslationXml(session, languageCode, translationXml) {
    const packageXml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Package xmlns="http://soap.sforce.com/2006/04/metadata">' +
      '<types><members>' + languageCode + '</members><name>Translations</name></types>' +
      '<version>' + API_VERSION + '</version>' +
      '</Package>';

    const zip = new JSZip();
    zip.file('unpackaged/package.xml', packageXml);
    zip.file(`unpackaged/translations/${languageCode}.translation`, translationXml);
    const zipBase64 = await zip.generateAsync({ type: 'base64' });

    const deployBody =
      '<met:deploy>' +
      '<met:ZipFile>' + zipBase64 + '</met:ZipFile>' +
      '<met:DeployOptions>' +
      '<met:singlePackage>true</met:singlePackage>' +
      '<met:rollbackOnError>true</met:rollbackOnError>' +
      '</met:DeployOptions>' +
      '</met:deploy>';

    const startDoc = await soapCall(session, deployBody);
    const asyncId = textOf(startDoc, 'id');
    if (!asyncId) {
      throw new Error('Metadata API deploy() did not return an async process id.');
    }

    let waitMs = 1000;
    for (let i = 0; i < MAX_POLLS; i++) {
      await sleep(waitMs);
      const pollBody =
        '<met:checkDeployStatus>' +
        '<met:asyncProcessId>' + escapeXml(asyncId) + '</met:asyncProcessId>' +
        '<met:includeDetails>true</met:includeDetails>' +
        '</met:checkDeployStatus>';
      const pollDoc = await soapCall(session, pollBody);
      const done = textOf(pollDoc, 'done') === 'true';
      if (done) {
        const status = textOf(pollDoc, 'status');
        if (status !== 'Succeeded') {
          const errMsgs = getElementsByLocalName(pollDoc, 'problem').map((m) => m.textContent).join('; ');
          throw new Error(`Deploy did not succeed (status: ${status}). ${errMsgs || `Async id: ${asyncId}`}`);
        }
        return;
      }
      waitMs = Math.min(waitMs * 2, 5000);
    }
    throw new Error(`Deploy timed out (may still complete server-side). Async process id: ${asyncId}`);
  }

  // ---- Merge helpers: parse/patch <validationRules> nodes -----------

  function parseValidationRuleTranslations(translationXmlString) {
    if (!translationXmlString) return new Map();
    const doc = new DOMParser().parseFromString(translationXmlString, 'text/xml');
    const nodes = getElementsByLocalName(doc, 'validationRules');
    const map = new Map();
    for (const node of nodes) {
      const fullName = textOf(node, 'fullName');
      const errorMessage = textOf(node, 'errorMessage') || '';
      if (fullName) map.set(fullName, errorMessage);
    }
    return map;
  }

  /**
   * Merges { fullName -> translatedErrorMessage } updates into the
   * existing translation XML text, preserving every other node
   * (customLabels, reports, etc.) untouched, and returns the new XML.
   */
  function mergeValidationRuleTranslations(existingXmlString, updatesMap) {
    const xmlText = existingXmlString ||
      '<?xml version="1.0" encoding="UTF-8"?><Translations xmlns="http://soap.sforce.com/2006/04/metadata"></Translations>';
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    const root = doc.documentElement;
    const ns = root.namespaceURI;

    const existingNodes = getElementsByLocalName(doc, 'validationRules');
    const handled = new Set();

    for (const node of existingNodes) {
      const fullName = textOf(node, 'fullName');
      if (updatesMap.has(fullName)) {
        const errEl = getElementsByLocalName(node, 'errorMessage')[0];
        if (errEl) {
          errEl.textContent = updatesMap.get(fullName);
        } else {
          const newErr = doc.createElementNS(ns, 'errorMessage');
          newErr.textContent = updatesMap.get(fullName);
          node.insertBefore(newErr, node.firstChild);
        }
        handled.add(fullName);
      }
    }

    for (const [fullName, errorMessage] of updatesMap.entries()) {
      if (handled.has(fullName)) continue;
      const vr = doc.createElementNS(ns, 'validationRules');
      const errEl = doc.createElementNS(ns, 'errorMessage');
      errEl.textContent = errorMessage;
      const fnEl = doc.createElementNS(ns, 'fullName');
      fnEl.textContent = fullName;
      vr.appendChild(errEl);
      vr.appendChild(fnEl);
      root.appendChild(vr);
    }

    return new XMLSerializer().serializeToString(doc);
  }

  // ---- High-level helpers used directly by sidepanel.js -------------

  /**
   * Retrieves the Translations file for a language and returns a
   * { fullName -> translatedErrorMessage } Map for validation rules.
   */
  async function readValidationRuleTranslations(session, languageCode) {
    const xml = await retrieveTranslationXml(session, languageCode);
    return parseValidationRuleTranslations(xml);
  }

  /**
   * Re-retrieves the current Translations file (to shrink the race
   * window with other admins editing it), merges in the given
   * { fullName -> translatedErrorMessage } updates, and deploys the
   * result back — preserving every other node untouched.
   */
  async function saveValidationRules(session, languageCode, updatesMap) {
    const existingXml = await retrieveTranslationXml(session, languageCode);
    const mergedXml = mergeValidationRuleTranslations(existingXml, updatesMap);
    await deployTranslationXml(session, languageCode, mergedXml);
  }

  return {
    getEnabledLanguages,
    retrieveTranslationXml,
    deployTranslationXml,
    parseValidationRuleTranslations,
    mergeValidationRuleTranslations,
    readValidationRuleTranslations,
    saveValidationRules
  };
})();
