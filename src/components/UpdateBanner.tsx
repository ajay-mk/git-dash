import type { Updates } from '../hooks/useUpdates';

/** Offers a downloaded-on-demand update above the cards, and shows its progress. */
export function UpdateBanner({ updates }: { updates: Updates }) {
  const { state } = updates;
  switch (state.kind) {
    case 'available':
      if (updates.dismissed) return null;
      return (
        <div className="banner banner-info update-banner" role="status">
          <span>GitDash {state.version} is available.</span>
          <span className="banner-actions">
            <button type="button" className="btn btn-primary" onClick={updates.install}>
              Restart to update
            </button>
            <button type="button" className="btn" onClick={updates.dismiss}>
              Later
            </button>
          </span>
        </div>
      );
    case 'downloading':
      return (
        <div className="banner banner-info update-banner" role="status">
          <span>
            Downloading GitDash {state.version}
            {state.percent === null ? '…' : `… ${state.percent}%`}
          </span>
        </div>
      );
    case 'restarting':
      return (
        <div className="banner banner-info update-banner" role="status">
          <span>Restarting into GitDash {state.version}…</span>
        </div>
      );
    case 'error':
      // Failed checks are reported in Settings, where they were started.
      if (state.version === undefined) return null;
      return (
        <div className="banner error-text update-banner" role="alert">
          <span>{state.message}</span>
          <span className="banner-actions">
            <button type="button" className="btn" onClick={updates.install}>
              Try again
            </button>
          </span>
        </div>
      );
    default:
      return null;
  }
}
