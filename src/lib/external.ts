import { openExternalUrl } from './transport';
import { isSafeExternalUrl } from './url';

/**
 * Opens a link in the system browser. Only GitHub pages and pages on the
 * connected GitLab instance are allowed; the Rust side enforces the same rule,
 * and checking here too keeps untrusted API data from producing any other
 * kind of link.
 */
export async function openExternal(url: string): Promise<void> {
  if (!isSafeExternalUrl(url)) {
    console.warn('Refusing to open an unknown URL');
    return;
  }
  await openExternalUrl(url);
}
