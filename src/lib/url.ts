import type { ProviderId } from '../providers/types';

/** The connected GitLab instance (`URL.host` form), or `null` when none is connected. */
let gitlabHost: string | null = null;

/** Sets the GitLab instance whose pages may be linked to and opened. */
export function setGitLabHost(host: string | null): void {
  gitlabHost = host ? host.toLowerCase() : null;
}

export function connectedGitLabHost(): string | null {
  return gitlabHost;
}

/**
 * Which provider serves a web page: GitHub for plain https://github.com/...
 * URLs and GitLab for pages on the connected instance. `null` for anything
 * else, including URLs with credentials, plain http or another port.
 */
export function providerOfUrl(url: string): ProviderId | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return null;
    if (parsed.host === 'github.com') return 'github';
    if (gitlabHost !== null && parsed.host === gitlabHost) return 'gitlab';
    return null;
  } catch {
    return null;
  }
}

/**
 * True only for GitHub web URLs, gitlab.com (where GitLab tokens are created
 * before anything is connected) and pages on the connected GitLab instance.
 */
export function isSafeExternalUrl(url: string): boolean {
  if (providerOfUrl(url) !== null) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.host === 'gitlab.com' && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}

/** GitLab writes merge requests as `!12`; everything else is `#12`. */
export function refSigil(url: string, isPullRequest: boolean): string {
  return isPullRequest && providerOfUrl(url) === 'gitlab' ? '!' : '#';
}
