/**
 * Resolves the Salesforce session for whichever tab is currently active
 * (must be a *.salesforce.com / *.force.com tab the user is already
 * logged into). Uses chrome.cookies, which — unlike document.cookie —
 * can read HttpOnly cookies when the extension holds host_permissions
 * for that origin.
 */
const SfSession = (() => {
  const SID_COOKIE_NAME = 'sid';

  async function getActiveSalesforceTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) {
      throw new Error('No active tab found.');
    }
    let url;
    try {
      url = new URL(tab.url);
    } catch (e) {
      throw new Error('Active tab does not have a valid URL.');
    }
    const isSfHost = /\.(salesforce|force|cloudforce)\.com$/.test(url.hostname);
    if (!isSfHost) {
      throw new Error(
        'Active tab is not a Salesforce page. Open your org (Setup, Lightning, or Classic) in the active tab first.'
      );
    }
    return { tab, url };
  }

  /**
   * Lightning pages are served from *.lightning.force.com but the API /
   * session cookie is scoped to the underlying *.my.salesforce.com (or
   * legacy instance) domain. We normalize to the My Domain API host.
   */
  function toApiHost(hostname) {
    if (hostname.endsWith('.lightning.force.com')) {
      return hostname.replace('.lightning.force.com', '.my.salesforce.com');
    }
    if (hostname.endsWith('.visualforce.com')) {
      return hostname.replace('.vf.force.com', '.my.salesforce.com').replace('.visualforce.com', '.my.salesforce.com');
    }
    return hostname; // already *.my.salesforce.com, *.salesforce.com, or *.cloudforce.com (sandboxes)
  }

  async function getSession() {
    const { url } = await getActiveSalesforceTab();
    const apiHost = toApiHost(url.hostname);

    const cookie = await chrome.cookies.get({
      url: `https://${apiHost}`,
      name: SID_COOKIE_NAME
    });

    if (!cookie || !cookie.value) {
      throw new Error(
        `Could not read the session cookie for ${apiHost}. Make sure you are logged in, ` +
        `and that "Allow all sites to check if you're signed in" style cookie blocking is not enabled for this site.`
      );
    }

    const sessionId = cookie.value;
    const orgId = sessionId.split('!')[0]; // sid format: <15-char orgId>!<rest>
    if (!orgId || orgId.length !== 15) {
      throw new Error('Unexpected session id format; could not extract organization id.');
    }

    return { apiHost, sessionId, orgId };
  }

  return { getSession };
})();
