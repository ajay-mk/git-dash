import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { describe, expect, it, vi } from 'vitest';
import App from './App';
import { defaultConfig } from './config/schema';
import { AppError, githubGraphql, gitlabGraphql, tokens, type TokenSummary } from './lib/transport';
import { pinned } from './test/fixtures';

const DASHBOARD = { name: 'Pin your first repository' };

function stored(hasDefault: boolean) {
  return { hasDefault, defaultLogin: hasDefault ? 'octocat' : null, owners: [], host: null };
}

/** Stores `github` for GitHub and `gitlab` (nothing by default) for GitLab. */
function storedTokens(github: TokenSummary, gitlab: TokenSummary = stored(false)) {
  vi.mocked(tokens.list).mockImplementation((provider) => Promise.resolve(provider === 'gitlab' ? gitlab : github));
}

function saveConfig(config = defaultConfig()) {
  localStorage.setItem('isitgreen.config.v1', JSON.stringify(config));
}

describe('App', () => {
  it('shows token setup when no token is stored', async () => {
    storedTokens(stored(false));
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Connect GitHub' })).toBeTruthy();
    expect(tokens.list).toHaveBeenCalledWith('github');
    expect(githubGraphql).not.toHaveBeenCalled();
  });

  it('offers an update on the setup screen too', async () => {
    storedTokens(stored(false));
    vi.mocked(check).mockResolvedValue({ version: '9.9.9', close: () => Promise.resolve() } as unknown as Update);
    render(<App />);
    expect(await screen.findByText('IsItGreen 9.9.9 is available.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Connect GitHub' })).toBeTruthy();
  });

  it('shows the keychain error on the setup screen', async () => {
    vi.mocked(tokens.list).mockRejectedValue(new AppError('keyring', 'The keychain is locked.'));
    render(<App />);
    expect(await screen.findByText('The keychain is locked.')).toBeTruthy();
  });

  it('shows the dashboard when a token is stored', async () => {
    storedTokens(stored(true));
    saveConfig({ ...defaultConfig(), inbox: { ...defaultConfig().inbox, enabled: false } });
    render(<App />);

    expect(await screen.findByRole('heading', DASHBOARD)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Connect GitHub' })).toBeNull();
  });

  it('returns to token setup when GitHub rejects the token', async () => {
    storedTokens(stored(true));
    vi.mocked(githubGraphql).mockRejectedValue(new AppError('unauthorized', 'Bad credentials'));
    saveConfig({ ...defaultConfig(), repos: [pinned()] });
    render(<App />);

    expect(await screen.findByText('Your token was rejected or is missing. Please add a new one.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Connect GitHub' })).toBeTruthy();

    // Saving a new token goes straight back to the dashboard.
    vi.mocked(tokens.set).mockResolvedValue('octocat');
    vi.mocked(githubGraphql).mockReturnValue(new Promise(() => {}));
    await userEvent.type(screen.getByLabelText('Access token'), 'github_pat_NEW');
    await userEvent.click(screen.getByRole('button', { name: 'Save token' }));
    expect(await screen.findByRole('heading', { name: 'IsItGreen' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Connect GitHub' })).toBeNull();
  });

  it('stays on the dashboard for errors other than authentication', async () => {
    storedTokens(stored(true));
    vi.mocked(githubGraphql).mockRejectedValue(new AppError('network', 'Could not reach GitHub.'));
    saveConfig({ ...defaultConfig(), repos: [pinned()] });
    render(<App />);

    // Shown in the banner and in the sidebar.
    expect((await screen.findAllByText('Could not reach GitHub.')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: 'Connect GitHub' })).toBeNull();
  });

  it('removing the token clears it and shows token setup', async () => {
    storedTokens(stored(true));
    saveConfig({ ...defaultConfig(), inbox: { ...defaultConfig().inbox, enabled: false } });
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove GitHub token' }));

    expect(await screen.findByRole('heading', { name: 'Connect GitHub' })).toBeTruthy();
    expect(tokens.clear).toHaveBeenCalledExactlyOnceWith('github');
  });

  it('removing the last token also removes owner tokens, which Settings could no longer reach', async () => {
    storedTokens({ ...stored(true), owners: [{ owner: 'acme', login: 'acme-bot' }] });
    saveConfig({ ...defaultConfig(), inbox: { ...defaultConfig().inbox, enabled: false } });
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove GitHub token' }));

    expect(await screen.findByRole('heading', { name: 'Connect GitHub' })).toBeTruthy();
    expect(vi.mocked(tokens.clear).mock.calls).toEqual([['github', 'acme'], ['github']]);
  });

  it('shows the dashboard only once the new token is registered', async () => {
    storedTokens(stored(false));
    render(<App />);
    await screen.findByRole('heading', { name: 'Connect GitHub' });

    let finish: (summary: TokenSummary) => void = () => {};
    vi.mocked(tokens.list).mockImplementation((provider) =>
      provider === 'gitlab' ? Promise.resolve(stored(false)) : new Promise((resolve) => (finish = resolve)),
    );
    vi.mocked(tokens.set).mockResolvedValue('octocat');
    await userEvent.type(screen.getByLabelText('Access token'), 'github_pat_SECRET123');
    await userEvent.click(screen.getByRole('button', { name: 'Save token' }));
    await waitFor(() => expect(tokens.list).toHaveBeenCalledTimes(4));
    expect(screen.getByRole('heading', { name: 'Connect GitHub' })).toBeTruthy();

    finish(stored(true));
    expect(await screen.findByRole('heading', DASHBOARD)).toBeTruthy();
  });

  it('stays on the dashboard when the keychain refuses to remove the token', async () => {
    storedTokens(stored(true));
    vi.mocked(tokens.clear).mockRejectedValue(new AppError('keyring', 'The keychain is locked.'));
    saveConfig({ ...defaultConfig(), inbox: { ...defaultConfig().inbox, enabled: false } });
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove GitHub token' }));

    expect(await screen.findByText('Could not remove the token: The keychain is locked.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Connect GitHub' })).toBeNull();
  });

  describe('with GitLab', () => {
    const gitlab = { hasDefault: true, defaultLogin: 'jane.doe', owners: [], host: 'gitlab.example.com' };
    const project = pinned('acme/platform', 'api', { provider: 'gitlab' });
    const projectData = {
      data: {
        viewer: { username: 'jane.doe' },
        p0: {
          fullPath: 'acme/platform/api',
          webUrl: 'https://gitlab.example.com/acme/platform/api',
          repository: { rootRef: 'main' },
        },
      },
    };

    it('shows a GitLab-only dashboard and links to the instance', async () => {
      storedTokens(stored(false), gitlab);
      vi.mocked(gitlabGraphql).mockResolvedValue(projectData);
      saveConfig({ ...defaultConfig(), repos: [project], inbox: { ...defaultConfig().inbox, enabled: false } });
      render(<App />);

      const title = await screen.findByRole('link', { name: /acme\/platform\/\s*api/ });
      expect(title.getAttribute('href')).toBe('https://gitlab.example.com/acme/platform/api');
      expect(githubGraphql).not.toHaveBeenCalled();
      expect(screen.queryByRole('heading', { name: /^Connect/ })).toBeNull();
    });

    it('says when the GitLab token could not be read instead of showing it as disconnected', async () => {
      vi.mocked(tokens.list).mockImplementation((provider) =>
        provider === 'gitlab'
          ? Promise.reject(new AppError('keyring', 'The keychain entry is damaged.'))
          : Promise.resolve(stored(true)),
      );
      saveConfig({ ...defaultConfig(), inbox: { ...defaultConfig().inbox, enabled: false } });
      render(<App />);

      expect(await screen.findByText('Could not read your GitLab token: The keychain entry is damaged.')).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
      expect(screen.getByText('Could not read the token: The keychain entry is damaged.')).toBeTruthy();
    });

    it('keeps GitHub working when the GitLab token is rejected', async () => {
      storedTokens(stored(true), gitlab);
      vi.mocked(gitlabGraphql).mockRejectedValue(new AppError('unauthorized', 'Bad credentials'));
      vi.mocked(githubGraphql).mockReturnValue(new Promise(() => {}));
      saveConfig({ ...defaultConfig(), repos: [project], inbox: { ...defaultConfig().inbox, enabled: false } });
      render(<App />);

      expect(await screen.findByText('Your GitLab token was rejected or has expired. Replace it in Settings.')).toBeTruthy();
      expect(screen.queryByRole('heading', { name: /^Connect/ })).toBeNull();
    });

    it('asks to connect GitLab for its projects while only GitHub is connected', async () => {
      storedTokens(stored(true));
      vi.mocked(githubGraphql).mockReturnValue(new Promise(() => {}));
      saveConfig({ ...defaultConfig(), repos: [project], inbox: { ...defaultConfig().inbox, enabled: false } });
      render(<App />);

      expect(await screen.findByText('Connect GitLab in Settings to load this repository.')).toBeTruthy();
      expect(gitlabGraphql).not.toHaveBeenCalled();
    });

    it('connects GitLab from settings and can cancel back to the dashboard', async () => {
      storedTokens(stored(true));
      saveConfig({ ...defaultConfig(), inbox: { ...defaultConfig().inbox, enabled: false } });
      render(<App />);

      await userEvent.click(await screen.findByRole('button', { name: 'Settings' }));
      await userEvent.click(screen.getByRole('button', { name: 'Connect GitLab' }));
      expect(screen.getByRole('heading', { name: 'Connect GitLab' })).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(await screen.findByRole('heading', DASHBOARD)).toBeTruthy();
    });

    it('removing GitLab keeps the GitHub dashboard', async () => {
      storedTokens(stored(true), gitlab);
      saveConfig({ ...defaultConfig(), inbox: { ...defaultConfig().inbox, enabled: false } });
      render(<App />);

      await userEvent.click(await screen.findByRole('button', { name: 'Settings' }));
      await userEvent.click(screen.getByRole('button', { name: 'Remove GitLab token' }));
      await waitFor(() => expect(tokens.clear).toHaveBeenCalledExactlyOnceWith('gitlab'));
      expect(screen.getByRole('heading', DASHBOARD)).toBeTruthy();
    });
  });

  it('persists settings changes', async () => {
    storedTokens(stored(true));
    saveConfig({ ...defaultConfig(), inbox: { ...defaultConfig().inbox, enabled: false } });
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: 'Open settings' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Theme' }), 'Dark');

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    expect(JSON.parse(localStorage.getItem('isitgreen.config.v1')!)).toMatchObject({ theme: 'dark' });
  });

  describe('reordering repo cards', () => {
    const repos = [pinned('octo', 'one'), pinned('octo', 'two'), pinned('octo', 'three')];

    function titles() {
      return screen.getAllByRole('article').map((a) => a.getAttribute('aria-label')?.split(':')[0]);
    }

    function savedOrder() {
      const saved = JSON.parse(localStorage.getItem('isitgreen.config.v1') ?? '{}') as { repos: { name: string }[] };
      return saved.repos.map((r) => r.name);
    }

    async function renderRepos() {
      storedTokens(stored(true));
      vi.mocked(githubGraphql).mockReturnValue(new Promise(() => {}));
      saveConfig({ ...defaultConfig(), repos, inbox: { ...defaultConfig().inbox, enabled: false } });
      render(<App />);
      await screen.findByRole('button', { name: 'Reorder octo/one' });
      // Let the initial (debounced) fetch go out before counting requests.
      await waitFor(() => expect(githubGraphql).toHaveBeenCalled());
      vi.mocked(githubGraphql).mockClear();
    }

    it('moves a card with the arrow keys and saves the order', async () => {
      await renderRepos();
      const handle = screen.getByRole('button', { name: 'Reorder octo/one' });
      handle.focus();
      await userEvent.keyboard('{ArrowDown}');

      expect(titles()).toEqual(['octo/two', 'octo/one', 'octo/three']);
      expect(savedOrder()).toEqual(['two', 'one', 'three']);
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reorder octo/one' }));
      expect(screen.getByText('Moved octo/one to position 2 of 3.')).toBeTruthy();

      await userEvent.keyboard('{End}');
      expect(savedOrder()).toEqual(['two', 'three', 'one']);
      await userEvent.keyboard('{Home}');
      expect(savedOrder()).toEqual(['one', 'two', 'three']);
      await userEvent.keyboard('{ArrowUp}');
      expect(savedOrder()).toEqual(['one', 'two', 'three']);
    });

    it('moves a card by dragging its handle and only saves on drop', async () => {
      await renderRepos();
      const card = (name: string) => screen.getByRole('article', { name: new RegExp(`^octo/${name}:`) });
      const over = vi.spyOn(document, 'elementFromPoint');

      fireEvent.pointerDown(screen.getByRole('button', { name: 'Reorder octo/three' }), { button: 0, pointerId: 1 });
      over.mockReturnValue(card('one'));
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 5, clientY: 5 });

      expect(titles()).toEqual(['octo/three', 'octo/one', 'octo/two']);
      expect(card('three').classList.contains('dragging')).toBe(true);
      expect(savedOrder()).toEqual(['one', 'two', 'three']);

      fireEvent.pointerUp(window, { pointerId: 1 });
      expect(savedOrder()).toEqual(['three', 'one', 'two']);
      expect(card('three').classList.contains('dragging')).toBe(false);

      // Reordering is not a data change, so nothing is refetched.
      await new Promise((r) => setTimeout(r, 500));
      expect(githubGraphql).not.toHaveBeenCalled();
      over.mockRestore();
    });

    it('ignores other pointers and ends a drag released outside the window', async () => {
      await renderRepos();
      const over = vi.spyOn(document, 'elementFromPoint');
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Reorder octo/one' }), { button: 0, pointerId: 1 });
      over.mockReturnValue(screen.getByRole('article', { name: /^octo\/two:/ }));
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 5, clientY: 5 });
      fireEvent.pointerCancel(window, { pointerId: 7 });
      expect(titles()).toEqual(['octo/two', 'octo/one', 'octo/three']);

      // Back in the window with no button held: the drop already happened.
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 0, clientX: 5, clientY: 5 });
      expect(savedOrder()).toEqual(['two', 'one', 'three']);
      expect(screen.getByRole('article', { name: /^octo\/one:/ }).classList.contains('dragging')).toBe(false);
      over.mockRestore();
    });

    it('cancels a drag with Escape', async () => {
      await renderRepos();
      const over = vi.spyOn(document, 'elementFromPoint');
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Reorder octo/one' }), { button: 0, pointerId: 1 });
      over.mockReturnValue(screen.getByRole('article', { name: /^octo\/three:/ }));
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 5, clientY: 5 });
      expect(titles()).toEqual(['octo/two', 'octo/three', 'octo/one']);

      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.pointerUp(window, { pointerId: 1 });
      expect(titles()).toEqual(['octo/one', 'octo/two', 'octo/three']);
      expect(savedOrder()).toEqual(['one', 'two', 'three']);
      over.mockRestore();
    });
  });

  describe('resizing repo cards', () => {
    const repos = [pinned('octo', 'one'), pinned('octo', 'two')];

    function saved() {
      return JSON.parse(localStorage.getItem('isitgreen.config.v1') ?? '{}') as {
        repos: { name: string; widgets: { type: string; limit?: number }[] }[];
        layout: { cardSpans: Record<string, number>; cardRows: Record<string, number>; collapsedWidgets: string[] };
      };
    }
    const limits = (name: string) =>
      saved().repos.find((r) => r.name === name)!.widgets.flatMap((w) => (w.limit === undefined ? [] : [w.limit]));

    async function renderRepos() {
      storedTokens(stored(true));
      vi.mocked(githubGraphql).mockReturnValue(new Promise(() => {}));
      saveConfig({ ...defaultConfig(), repos, inbox: { ...defaultConfig().inbox, enabled: false } });
      render(<App />);
      await screen.findByRole('button', { name: 'Resize octo/one' });
    }

    it('changes the width and entry count with the arrow keys', async () => {
      await renderRepos();
      screen.getByRole('button', { name: 'Resize octo/one' }).focus();

      await userEvent.keyboard('{ArrowRight}');
      expect(saved().layout.cardSpans).toEqual({ 'github:octo/one': 2 });
      expect(screen.getByRole('article', { name: /^octo\/one:/ }).style.gridColumn).toBe('span 2');
      expect(screen.getByText('octo/one is 2 columns wide, 5 entries.')).toBeTruthy();

      await userEvent.keyboard('{ArrowDown}{ArrowDown}');
      expect(limits('one')).toEqual([7, 7]);
      expect(limits('two')).toEqual([5, 5]);

      await userEvent.keyboard('{ArrowLeft}{ArrowUp}');
      expect(saved().layout.cardSpans).toEqual({});
      expect(limits('one')).toEqual([6, 6]);
    });

    it('leaves lists that have not loaded as they are, and collapsed lists at their limit', async () => {
      storedTokens(stored(true));
      vi.mocked(githubGraphql).mockReturnValue(new Promise(() => {}));
      const layout = { ...defaultConfig().layout, collapsedWidgets: ['github:octo/one#issues'] };
      const one = pinned('octo', 'one', {
        widgets: [{ type: 'pullRequests', limit: 1, hideDrafts: false }, { type: 'issues', limit: 5, label: null }],
      });
      saveConfig({ ...defaultConfig(), repos: [one, repos[1]!], layout, inbox: { ...defaultConfig().inbox, enabled: false } });
      render(<App />);
      (await screen.findByRole('button', { name: 'Resize octo/one' })).focus();

      // Nothing has loaded, so there is nothing on the card to fold.
      await userEvent.keyboard('{ArrowUp}');
      expect(limits('one')).toEqual([1, 5]);
      expect(saved().layout.collapsedWidgets).toEqual(['github:octo/one#issues']);

      await userEvent.keyboard('{ArrowDown}');
      expect(limits('one')).toEqual([2, 5]);
      expect(saved().layout.collapsedWidgets).toEqual(['github:octo/one#issues']);
      expect(screen.getByText('octo/one is 1 column wide, 2 entries.')).toBeTruthy();
    });

    it('resizes by dragging the grip and only saves on release', async () => {
      await renderRepos();
      const card = screen.getByRole('article', { name: /^octo\/one:/ });
      vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ width: 0, height: 200 } as DOMRect);
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Resize octo/one' }), { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
      // Two open lists with 28px rows: 112px down adds two entries to each.
      fireEvent.pointerMove(window, { pointerId: 2, buttons: 1, clientX: 2, clientY: 112 });

      expect(card.classList.contains('resizing')).toBe(true);
      expect(card.style.gridColumn).toBe('span 2');
      expect(screen.getByText('2 columns · 7 entries')).toBeTruthy();
      // 8px grid rows less the 16px kept under the card: 200px + 112px snaps to 41 rows.
      expect(card.style.height).toBe('calc(41 * var(--row-unit) - var(--row-gap))');
      expect(limits('one')).toEqual([5, 5]);

      fireEvent.pointerUp(window, { pointerId: 2 });
      expect(saved().layout.cardSpans).toEqual({ 'github:octo/one': 2 });
      expect(saved().layout.cardRows).toEqual({ 'github:octo/one': 41 });
      expect(limits('one')).toEqual([7, 7]);
      expect(card.classList.contains('resizing')).toBe(false);
    });

    function gridOf(width: number) {
      // happy-dom does not lay out, so give the grid a width and a track size.
      const style = window.getComputedStyle;
      const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
        if (!(el as HTMLElement).classList.contains('grid')) return style(el);
        return { columnGap: '0px', getPropertyValue: (name: string) => (name === '--card-min' ? '100px' : '') } as CSSStyleDeclaration;
      });
      const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')!;
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        get(this: HTMLElement) {
          return this.classList.contains('grid') ? width : 0;
        },
      });
      return () => {
        spy.mockRestore();
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', { ...clientWidth, configurable: true });
      };
    }

    async function renderSpan(span: number) {
      storedTokens(stored(true));
      vi.mocked(githubGraphql).mockReturnValue(new Promise(() => {}));
      const layout = { ...defaultConfig().layout, cardSpans: { 'github:octo/one': span } };
      saveConfig({ ...defaultConfig(), repos, layout, inbox: { ...defaultConfig().inbox, enabled: false } });
      render(<App />);
      const grip = await screen.findByRole('button', { name: 'Resize octo/one' });
      return { grip, card: screen.getByRole('article', { name: /^octo\/one:/ }) };
    }

    it('measures columns from every grid track when the grid has more than three', async () => {
      const restore = gridOf(400);
      try {
        const { grip, card } = await renderSpan(3);
        vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 200 } as DOMRect);

        // A purely vertical drag keeps the card three columns wide.
        fireEvent.pointerDown(grip, { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
        fireEvent.pointerMove(window, { pointerId: 2, buttons: 1, clientX: 0, clientY: 60 });
        expect(card.style.gridColumn).toBe('span 3');
        fireEvent.pointerUp(window, { pointerId: 2 });
        expect(saved().layout.cardSpans).toEqual({ 'github:octo/one': 3 });
      } finally {
        restore();
      }
    });

    it('narrows a wide card to the columns that fit, keeping its saved width', async () => {
      const restore = gridOf(200);
      try {
        const { card } = await renderSpan(3);
        await waitFor(() => expect(card.style.gridColumn).toBe('span 2'));
        expect(saved().layout.cardSpans).toEqual({ 'github:octo/one': 3 });
      } finally {
        restore();
      }
    });

    it('sets the height of a card with nothing in it, and lets it fit its content again', async () => {
      await renderRepos();
      const card = screen.getByRole('article', { name: /^octo\/one:/ });
      vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ width: 0, height: 120 } as DOMRect);
      const grip = screen.getByRole('button', { name: 'Resize octo/one' });

      // Nothing loads in this test, so the lists are empty: the height still changes.
      fireEvent.pointerDown(grip, { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(window, { pointerId: 2, buttons: 1, clientX: 0, clientY: 200 });
      fireEvent.pointerUp(window, { pointerId: 2 });
      expect(saved().layout.cardRows).toEqual({ 'github:octo/one': 42 });
      expect(card.classList.contains('sized')).toBe(true);

      fireEvent.doubleClick(grip);
      expect(saved().layout.cardRows).toEqual({});
      expect(card.style.height).toBe('');

      grip.focus();
      await userEvent.keyboard('{ArrowDown}');
      expect(Object.keys(saved().layout.cardRows)).toEqual(['github:octo/one']);
      await userEvent.keyboard('{Delete}');
      expect(saved().layout.cardRows).toEqual({});
      expect(screen.getByText('octo/one fits its content.')).toBeTruthy();
    });

    it('cancels a resize with Escape', async () => {
      await renderRepos();
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Resize octo/one' }), { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(window, { pointerId: 2, buttons: 1, clientX: 2, clientY: 112 });
      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.pointerUp(window, { pointerId: 2 });
      expect(saved().layout.cardSpans).toEqual({});
      expect(limits('one')).toEqual([5, 5]);
    });
  });
});
