import type { ReactNode } from 'react';
import { openExternal } from '../lib/external';
import { isSafeExternalUrl } from '../lib/url';

/**
 * Link that opens in the system browser. The webview itself never navigates
 * away from the app. Falls back to plain text for anything that is not a
 * GitHub URL.
 */
export function ExternalLink({ href, className, title, children }: {
  href: string;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  if (!isSafeExternalUrl(href)) {
    return <span className={className} title={title}>{children}</span>;
  }
  return (
    <a
      href={href}
      className={className}
      title={title}
      rel="noreferrer noopener"
      onClick={(e) => {
        e.preventDefault();
        void openExternal(href);
      }}
    >
      {children}
    </a>
  );
}
