/**
 * What the self-updater is doing, as the sidebar's Updates section and the update notifications show it, and how an
 * update failure is explained to a person.
 *
 * host/updater.ts keeps one UpdateStatus and replaces it on every step (checking, installing, a result, a failure);
 * the sidebar renders it as plain data. A failure arrives as an Error message from core/updater.ts or from Node
 * (ENOTFOUND, certificate errors, HTTP status lines). explainUpdateError turns it into a short title, what it most
 * likely means, and the fixes that apply: open the exact setting that is missing or wrong, retry, update VS Code. The
 * raw message is kept as `raw` for the log and for a details line, so nothing is hidden. Pure: no vscode, no I/O.
 */

/** One button that resolves a problem or moves an update forward. `setting` only for openSetting. */
export interface UpdateAction {
  action: 'retry' | 'install' | 'reload' | 'openSetting' | 'updateVscode' | 'showLog';
  label: string;
  setting?: string;
}

export interface UpdateProblem {
  title: string;
  /** What it most likely means and what to do, in one or two sentences. */
  detail: string;
  /** The original error message. */
  raw: string;
  fixes: UpdateAction[];
}

export type UpdateState =
  | 'idle' | 'checking' | 'upToDate' | 'unpublished' | 'available' | 'installing' | 'installed'
  | 'incompatible' | 'disabled' | 'busy' | 'error';

export interface UpdateStatus {
  /** The version running in this window. */
  current: string;
  state: UpdateState;
  /** The newest version on the server (available, installing, installed, incompatible, upToDate). */
  latest?: string;
  notes?: string;
  mandatory?: boolean;
  minVscode?: string;
  /** When the last check finished, ms since the epoch. */
  checkedAt?: number;
  /** infraonAssistant.autoUpdate. */
  autoUpdate: boolean;
  problem?: UpdateProblem;
}

/** The settings a fix may open: only this extension's, so a message from the webview cannot open anything else. */
export const UPDATE_SETTINGS = ['infraonAssistant.baseUrl', 'infraonAssistant.updateUrl', 'infraonAssistant.allowSelfSignedTls', 'infraonAssistant.autoUpdate', 'infraonAssistant.policyUrl'] as const;

/** Message of the error the updater throws when it has no address to check. */
export const NO_UPDATE_URL = 'no update URL';
/** Message of the error the updater throws when the gateway base URL is set but unusable. */
export const BAD_BASE_URL = 'the gateway base URL is not a valid http(s) URL';

const RETRY: UpdateAction = { action: 'retry', label: 'Try again' };
const setting = (key: (typeof UPDATE_SETTINGS)[number], label: string): UpdateAction => ({ action: 'openSetting', label, setting: key });
const UPDATE_URL = setting('infraonAssistant.updateUrl', 'Open update URL setting');

/** Turns an update failure into a title, a likely cause and the fixes that apply. */
export function explainUpdateError(raw: string): UpdateProblem {
  const msg = String(raw ?? '').trim() || 'unknown error';
  const p = (title: string, detail: string, fixes: UpdateAction[]): UpdateProblem => ({ title, detail, raw: msg, fixes });

  if (msg.startsWith(NO_UPDATE_URL)) {
    return p('Update server is not configured',
      'Neither the LLM gateway URL (infraonAssistant.baseUrl) nor an update URL (infraonAssistant.updateUrl) is set in your user settings, so there is nowhere to look for updates. Set the gateway URL; updates are then taken from the same server.',
      [setting('infraonAssistant.baseUrl', 'Set gateway URL'), setting('infraonAssistant.updateUrl', 'Set update URL')]);
  }
  if (msg.startsWith(BAD_BASE_URL) || /\bInvalid URL\b|ERR_INVALID_URL|Only absolute URLs/i.test(msg)) {
    return p('Update address is not valid',
      'The gateway URL or update URL in your user settings is not a full http:// or https:// address. Correct it, for example https://llm.example.com/v1.',
      [setting('infraonAssistant.baseUrl', 'Fix gateway URL'), UPDATE_URL]);
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
    return p('Update server not found',
      'The server name in the gateway or update URL could not be found. Check the address for typos, and check that you are on the company network or VPN.',
      [RETRY, setting('infraonAssistant.baseUrl', 'Check gateway URL'), UPDATE_URL]);
  }
  if (/certificate|self[- ]signed|UNABLE_TO_VERIFY|CERT_|DEPTH_ZERO|unable to get local issuer/i.test(msg)) {
    return p('Server certificate is not trusted',
      'The update server uses a certificate VS Code does not trust (common for internal servers). Updates are signed, so the certificate is not what makes them safe: you can allow self-signed certificates, or ask IT to install the company root certificate.',
      [setting('infraonAssistant.allowSelfSignedTls', 'Open certificate setting'), RETRY]);
  }
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENETDOWN|socket hang up|EPIPE/i.test(msg)) {
    return p('Cannot reach the update server',
      'The connection to the update server was refused or dropped. The server may be down, or you may be off the company network or VPN.',
      [RETRY, UPDATE_URL]);
  }
  if (/timed out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(msg)) {
    return p('Update server did not answer in time',
      'The server took too long to answer. Check your network or VPN connection and try again.',
      [RETRY]);
  }
  const http = /HTTP (\d{3})/.exec(msg);
  if (http) {
    const code = Number(http[1]);
    if (code === 401 || code === 403) {
      return p(`Update server refused access (HTTP ${code})`,
        'The server does not allow downloading updates from here. A proxy may require a login, or the update folder is not shared. Ask the administrator of the gateway server.',
        [RETRY, UPDATE_URL]);
    }
    if (code >= 500) {
      return p(`Update server error (HTTP ${code})`, 'The update server had an internal problem. Try again later.', [RETRY]);
    }
    return p(`Unexpected answer from the update server (HTTP ${code})`,
      'The update URL may point to the wrong place. It should end in /infraon-assistant/updates/latest.json, or be empty to use the gateway server.',
      [UPDATE_URL, RETRY]);
  }
  if (/signature is invalid|not signed/i.test(msg)) {
    return p('Release signature is not valid',
      'The release on the server is not signed with the company key, so it was ignored to keep you safe. Nothing was installed. Tell the person who publishes releases.',
      [RETRY]);
  }
  if (/does not match the signed hash/i.test(msg)) {
    return p('Download was damaged',
      'The downloaded package did not match the signed release, so it was discarded and nothing was installed. This is usually a network problem: try again.',
      [RETRY]);
  }
  if (/^manifest |not valid JSON|same server as the manifest|must not contain credentials/i.test(msg)) {
    return p('Release file on the server is not readable',
      'The update URL answered, but not with a valid release file. It may point to the wrong page (a proxy login page, for example), or the release was published incompletely.',
      [UPDATE_URL, RETRY]);
  }
  if (/larger than \d+ bytes/i.test(msg)) {
    return p('Update is larger than allowed', 'The file on the server is larger than any real release, so it was not downloaded. Tell the person who publishes releases.', [RETRY]);
  }
  if (/did not finish installing/i.test(msg)) {
    return p('Installing the update took too long', 'VS Code did not finish installing the package within 5 minutes. Try again, or restart VS Code first.', [RETRY]);
  }
  if (/EACCES|EPERM|ENOSPC|EROFS|EBUSY/i.test(msg)) {
    return p('Could not save the update',
      /ENOSPC/i.test(msg) ? 'The disk is full. Free some space and try again.' : 'VS Code could not write the update to its storage folder (no permission, or the file is in use). Close other VS Code windows and try again.',
      [RETRY]);
  }
  return p('Update check failed', 'An unexpected problem stopped the update. The details are below and in the update log.', [RETRY]);
}

/** The problem shown when this window's VS Code is too old for the newest release. */
export function incompatibleProblem(version: string, minVscode: string | undefined, vscodeVersion: string): UpdateProblem {
  return {
    title: `Version ${version} needs a newer VS Code`,
    detail: `It needs VS Code ${minVscode ?? 'newer'} or later; you have ${vscodeVersion}. Update VS Code, then check again.`,
    raw: `${version} needs VS Code ${minVscode}; this is ${vscodeVersion}`,
    fixes: [{ action: 'updateVscode', label: 'Update VS Code' }, RETRY],
  };
}
