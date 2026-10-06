import { openUrl } from '@tauri-apps/plugin-opener';
import { isSafeExternalUrl } from './url';

/**
 * Opens a link in the system browser. Only GitHub web URLs are allowed; the
 * Tauri capability enforces the same rule on the Rust side, and checking here
 * too keeps untrusted API data from producing any other kind of link.
 */
export async function openExternal(url: string): Promise<void> {
  if (!isSafeExternalUrl(url)) {
    console.warn('Refusing to open non-GitHub URL');
    return;
  }
  await openUrl(url);
}
