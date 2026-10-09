import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { defaultConfig, MAX_REPOS, type DashboardConfig } from '../config/schema';
import { pinned } from '../test/fixtures';
import { SettingsPanel } from './SettingsPanel';

/** Renders the panel with real state so updates flow back into it. */
function setup(initial: Partial<DashboardConfig> = {}) {
  let current: DashboardConfig = { ...defaultConfig(), ...initial };
  const onChangeToken = vi.fn();
  const onSignOut = vi.fn();
  const onClose = vi.fn();

  function Harness() {
    const [config, setConfig] = useState(current);
    current = config;
    return (
      <SettingsPanel
        open
        onClose={onClose}
        config={config}
        update={(fn) => setConfig((c) => (current = fn(c)))}
        viewer="octocat"
        ownerTokens={[]}
        onOwnerTokensChanged={vi.fn()}
        onChangeToken={onChangeToken}
        onSignOut={onSignOut}
      />
    );
  }

  render(<Harness />);
  return { config: () => current, onChangeToken, onSignOut, onClose };
}

const names = (c: DashboardConfig) => c.repos.map((r) => `${r.owner}/${r.name}`);

async function pin(text: string) {
  const input = screen.getByRole('textbox', { name: 'Repository to pin' });
  await userEvent.clear(input);
  await userEvent.type(input, text);
  await userEvent.click(screen.getByRole('button', { name: 'Pin' }));
}

function expandRepo(name: string) {
  return userEvent.click(screen.getByRole('button', { name: `▸ ${name}` }));
}

describe('SettingsPanel', () => {
  it('opens as a modal dialog', () => {
    setup();
    expect((screen.getByRole('dialog', { name: 'Settings' }) as HTMLDialogElement).open).toBe(true);
  });

  describe('pinning', () => {
    it('pins owner/name and GitHub URLs with default widgets', async () => {
      const { config } = setup();
      await pin('octo/repo');
      await pin('https://github.com/rust-lang/rust.git');

      expect(names(config())).toEqual(['octo/repo', 'rust-lang/rust']);
      expect(config().repos[0]!.widgets.map((w) => w.type)).toEqual(['ci', 'pullRequests', 'issues']);
      expect(screen.queryByRole('alert')).toBeNull();
      expect((screen.getByRole('textbox', { name: 'Repository to pin' }) as HTMLInputElement).value).toBe('');
    });

    it.each(['octo', 'octo/repo/extra', '-bad/repo', 'octo/..', 'https://evil.example/octo/repo', '<b>x</b>/y'])(
      'rejects %j',
      async (text) => {
        const { config } = setup();
        await pin(text);
        expect(screen.getByRole('alert').textContent).toMatch(/owner\/name or a github\.com URL/);
        expect(config().repos).toEqual([]);
      },
    );

    it('rejects duplicates regardless of case', async () => {
      const { config } = setup({ repos: [pinned('octo', 'repo')] });
      await pin('Octo/Repo');
      expect(screen.getByRole('alert').textContent).toBe('Already pinned.');
      expect(config().repos).toHaveLength(1);
    });

    it('enforces the repository limit', async () => {
      const repos = Array.from({ length: MAX_REPOS }, (_, i) => pinned('octo', `r${i}`));
      const { config } = setup({ repos });
      await pin('octo/one-more');
      expect(screen.getByRole('alert').textContent).toBe(`You can pin up to ${MAX_REPOS} repositories.`);
      expect(config().repos).toHaveLength(MAX_REPOS);
    });
  });

  it('reorders and unpins repositories', async () => {
    const { config } = setup({ repos: [pinned('a', 'one'), pinned('b', 'two'), pinned('c', 'three')] });
    const moveUp = screen.getAllByRole('button', { name: 'Move up' });
    const moveDown = screen.getAllByRole('button', { name: 'Move down' });
    expect(moveUp[0]!.hasAttribute('disabled')).toBe(true);
    expect(moveDown[2]!.hasAttribute('disabled')).toBe(true);

    await userEvent.click(moveDown[0]!);
    expect(names(config())).toEqual(['b/two', 'a/one', 'c/three']);
    await userEvent.click(screen.getAllByRole('button', { name: 'Move up' })[2]!);
    expect(names(config())).toEqual(['b/two', 'c/three', 'a/one']);

    await userEvent.click(screen.getByRole('button', { name: 'Unpin c/three' }));
    expect(names(config())).toEqual(['b/two', 'a/one']);
  });

  describe('widgets', () => {
    it('toggles widgets and keeps the canonical order', async () => {
      const { config } = setup({ repos: [pinned()] });
      await expandRepo('octo/repo');
      const editor = screen.getByRole('listitem');

      await userEvent.click(within(editor).getByRole('checkbox', { name: 'CI status' }));
      expect(config().repos[0]!.widgets.map((w) => w.type)).toEqual(['pullRequests', 'issues']);
      await userEvent.click(within(editor).getByRole('checkbox', { name: 'CI status' }));
      expect(config().repos[0]!.widgets.map((w) => w.type)).toEqual(['ci', 'pullRequests', 'issues']);
    });

    it('edits pull request options', async () => {
      const { config } = setup({ repos: [pinned()] });
      await expandRepo('octo/repo');

      await userEvent.click(screen.getByRole('checkbox', { name: 'Hide drafts' }));
      const [prLimit] = screen.getAllByRole('spinbutton', { name: 'Show' });
      await userEvent.clear(prLimit!);
      await userEvent.type(prLimit!, '8');

      expect(config().repos[0]!.widgets[1]).toEqual({ type: 'pullRequests', limit: 8, hideDrafts: true });
    });

    it('clamps item limits to the allowed range', async () => {
      const { config } = setup({ repos: [pinned()] });
      await expandRepo('octo/repo');
      const [prLimit] = screen.getAllByRole('spinbutton', { name: 'Show' });
      await userEvent.clear(prLimit!);
      await userEvent.type(prLimit!, '99');
      expect(config().repos[0]!.widgets[1]).toMatchObject({ limit: 20 });
      await userEvent.tab();
      expect((prLimit as HTMLInputElement).value).toBe('20');
    });

    it('edits the issue label filter, including labels with spaces', async () => {
      const { config } = setup({ repos: [pinned()] });
      await expandRepo('octo/repo');
      const label = screen.getByRole('textbox', { name: 'Label' });

      await userEvent.type(label, 'good first issue');
      expect(config().repos[0]!.widgets[2]).toEqual({ type: 'issues', limit: 5, label: 'good first issue' });

      await userEvent.clear(label);
      expect(config().repos[0]!.widgets[2]).toEqual({ type: 'issues', limit: 5, label: null });
    });
  });

  it('toggles the sidebar and its sections', async () => {
    const { config } = setup();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Review requests' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Assigned to you' }));
    expect(config().inbox).toMatchObject({ reviewRequests: false, myPullRequests: true, assigned: false });

    await userEvent.click(screen.getByRole('checkbox', { name: 'Show sidebar' }));
    expect(config().inbox.enabled).toBe(false);
    // The section options sit in a disabled fieldset while the sidebar is off.
    expect(screen.getByRole('checkbox', { name: 'Your pull requests' }).closest('fieldset')?.disabled).toBe(true);
  });

  it('changes refresh interval and theme', async () => {
    const { config } = setup();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Refresh' }), 'Every 15 min');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Theme' }), 'Dark');
    expect(config()).toMatchObject({ refreshMinutes: 15, theme: 'dark' });
  });

  it('wires the token buttons', async () => {
    const { onChangeToken, onSignOut } = setup();
    expect(screen.getByText('octocat')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Replace token' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove token' }));
    expect(onChangeToken).toHaveBeenCalledOnce();
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  describe('backup', () => {
    const textarea = () => screen.getByRole('textbox', { name: 'Configuration JSON' }) as HTMLTextAreaElement;

    async function importText(text: string) {
      await userEvent.clear(textarea());
      // Paste rather than type: user-event treats braces as key descriptors.
      textarea().focus();
      await userEvent.paste(text);
      await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    }

    it('round-trips export and import', async () => {
      const repos = [pinned('octo', 'repo', { widgets: [{ type: 'issues', limit: 3, label: 'bug' }] }), pinned('a', 'b')];
      const { config } = setup({ repos, theme: 'dark', refreshMinutes: 30 });
      const before = config();

      await userEvent.click(screen.getByRole('button', { name: 'Export' }));
      const exported = textarea().value;
      expect(JSON.parse(exported)).toEqual(before);

      await userEvent.click(screen.getByRole('button', { name: 'Unpin a/b' }));
      expect(config().repos).toHaveLength(1);

      await importText(exported);
      expect(config()).toEqual(before);
      expect(screen.getByText('Imported 2 repositories.')).toBeTruthy();
      expect(textarea().value).toBe('');
    });

    it('rejects a malicious import and keeps the current config', async () => {
      const { config } = setup({ repos: [pinned()] });
      const before = config();
      const evil = JSON.stringify({
        version: 1,
        repos: [{ provider: 'github', owner: '<img src=x onerror=alert(1)>', name: 'x', widgets: [] }],
      });

      await importText(evil);
      expect(config()).toEqual(before);
      expect(screen.getByText(/Invalid repository name/)).toBeTruthy();
      expect(document.querySelector('img')).toBeNull();
    });

    it.each([
      ['not JSON', '{nope'],
      ['a wrong version', JSON.stringify({ version: 2, repos: [] })],
      ['an unknown provider', JSON.stringify({ version: 1, repos: [{ provider: 'gitlab', owner: 'a', name: 'b' }] })],
      ['too many repositories', JSON.stringify({ version: 1, repos: Array(MAX_REPOS + 1).fill({}) })],
    ])('rejects %s', async (_, text) => {
      const { config } = setup({ repos: [pinned()] });
      const before = config();
      await importText(text);
      expect(config()).toEqual(before);
      expect(document.querySelector('.error-text')).toBeTruthy();
    });

    it('drops unknown keys and prototype pollution from an import', async () => {
      const { config } = setup();
      await importText(
        '{"version":1,"repos":[{"provider":"github","owner":"a","name":"b","widgets":[{"type":"ci","x":1}],"__proto__":{"polluted":true}}],"__proto__":{"polluted":true},"extra":1}',
      );
      expect(config().repos).toEqual([{ provider: 'github', owner: 'a', name: 'b', widgets: [{ type: 'ci' }] }]);
      expect(config()).not.toHaveProperty('extra');
      expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    });
  });
});
