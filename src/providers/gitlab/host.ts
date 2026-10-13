/**
 * GitLab instances, written the way the Rust side stores them: a lowercase
 * DNS name plus a port when it is not 443 (the shape of `URL.host`).
 */

export const GITLAB_COM = 'gitlab.com';

/**
 * Normalizes what a user types as their GitLab instance: `gitlab.com`,
 * `gitlab.example.com:8443`, or the same with `https://` and a trailing
 * slash. Returns null for anything else (paths, credentials, IP addresses,
 * plain http). The Rust side applies the same rules before using a host.
 */
export function normalizeGitLabHost(input: string): string | null {
  let value = input.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  if (scheme) {
    if (scheme[1]!.toLowerCase() !== 'https') return null;
    value = value.slice(scheme[0].length);
  }
  value = value.replace(/\/$/, '');
  if (value === '' || /[/@?#\\\s]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(`https://${value}/`);
  } catch {
    return null;
  }
  const name = url.hostname;
  const isIp = name.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(name);
  if (isIp || !name.includes('.') || name.length > 253) return null;
  return url.host;
}
