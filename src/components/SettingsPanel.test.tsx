import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { defaultConfig, MAX_REPOS, type DashboardConfig } from '../config/schema';
import { githubGraphql, gitlabGraphql, type TokenSummary } from '../lib/transport';
import { setGitLabHost } from '../lib/url';
import type { ProviderId } from '../providers/types';
import { pinned } from '../test/fixtures';
import { SettingsPanel } from './SettingsPanel';

type Accounts = Record<ProviderId, TokenSummary | null>;

const NOT_CONNECTED: TokenSummary = { hasDefault: false, defaultLogin: null, owners: [], host: null };
const GITHUB_ONLY: Accounts = {
  github: { hasDefault: true, defaultLogin: 'octocat', owners: [], host: null },
  gitlab: NOT_CONNECTED,
};
const BOTH: Accounts = {
  ...GITHUB_ONLY,
  gitlab: { hasDefault: true, defaultLogin: 'jane.doe', owners: [], host: 'gitlab.example.com' },
};

/** Renders the panel with real state so updates flow back into it. */
function setup(initial: Partial<DashboardConfig> = {}, accounts: Accounts = GITHUB_ONLY) {
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
        accounts={accounts}
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
  const input = screen.getByRole('combobox', { name: 'Repository to pin' });
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
      expect((screen.getByRole('combobox', { name: 'Repository to pin' }) as HTMLInputElement).value).toBe('');
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

  describe('suggestions', () => {
    function viewerRepos(...names: string[]) {
      vi.mocked(githubGraphql).mockResolvedValue({
        data: { viewer: { repositories: { nodes: names.map((nameWithOwner) => ({ nameWithOwner })) } } },
      });
    }
    const field = () => screen.getByRole('combobox', { name: 'Repository to pin' });
    const options = () => {
      const list = screen.queryByRole('listbox', { name: 'Suggested repositories' });
      return list ? within(list).getAllByRole('option').map((o) => o.textContent) : [];
    };

    it('suggests repositories the token can see, minus pinned ones', async () => {
      viewerRepos('octo/repo', 'octo/api', 'acme/web');
      setup({ repos: [pinned('octo', 'repo')] });
      await userEvent.click(field());

      expect(await screen.findByRole('listbox', { name: 'Suggested repositories' })).toBeTruthy();
      expect(options()).toEqual(['octo/api', 'acme/web']);
      await userEvent.type(field(), 'we');
      expect(options()).toEqual(['acme/web']);
    });

    it('pins a suggestion on click', async () => {
      viewerRepos('octo/api', 'acme/web');
      const { config } = setup();
      await userEvent.click(field());
      await userEvent.click(await screen.findByRole('option', { name: 'acme/web' }));

      expect(names(config())).toEqual(['acme/web']);
      expect((field() as HTMLInputElement).value).toBe('');
    });

    it('picks with the keyboard and closes on Escape without closing settings', async () => {
      viewerRepos('octo/api', 'acme/web');
      const { config, onClose } = setup();
      await userEvent.click(field());
      await screen.findByRole('listbox', { name: 'Suggested repositories' });

      await userEvent.keyboard('{ArrowDown}{ArrowDown}');
      expect(field().getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'acme/web' }).id);
      await userEvent.keyboard('{Enter}');
      expect(names(config())).toEqual(['acme/web']);

      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('listbox', { name: 'Suggested repositories' })).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('reloads suggestions after the stored tokens change', async () => {
      viewerRepos('octo/api');
      const props = {
        open: true,
        onClose: vi.fn(),
        config: defaultConfig(),
        update: vi.fn(),
        accounts: GITHUB_ONLY,
        onOwnerTokensChanged: vi.fn(),
        onChangeToken: vi.fn(),
        onSignOut: vi.fn(),
      };
      const owners = [{ owner: 'acme', login: 'octocat' }];
      const { rerender } = render(<SettingsPanel {...props} ownerTokens={owners} />);
      await userEvent.click(field());
      expect(await screen.findByRole('option', { name: 'octo/api' })).toBeTruthy();
      const calls = vi.mocked(githubGraphql).mock.calls.length;

      // Refocusing with the same tokens uses the cached list.
      await userEvent.click(document.body);
      await userEvent.click(field());
      expect(vi.mocked(githubGraphql).mock.calls.length).toBe(calls);

      // Replacing acme's token reloads the token list with the same owners.
      viewerRepos('octo/web');
      rerender(<SettingsPanel {...props} ownerTokens={[{ owner: 'acme', login: 'octocat' }]} />);
      await userEvent.click(document.body);
      await userEvent.click(field());
      expect(await screen.findByRole('option', { name: 'octo/web' })).toBeTruthy();
      expect(screen.queryByRole('option', { name: 'octo/api' })).toBeNull();
    });

    it('retries on the next focus after a failed load', async () => {
      vi.mocked(githubGraphql).mockRejectedValue(new Error('offline'));
      setup();
      await userEvent.click(field());
      await userEvent.click(document.body);
      expect(screen.queryByRole('listbox', { name: 'Suggested repositories' })).toBeNull();

      viewerRepos('octo/api');
      await userEvent.click(field());
      expect(await screen.findByRole('option', { name: 'octo/api' })).toBeTruthy();
    });

    it('shows partial results and retries the failed token on the next focus', async () => {
      vi.mocked(githubGraphql).mockImplementation((_query, _variables, owner) =>
        owner
          ? Promise.reject(new Error('offline'))
          : Promise.resolve({ data: { viewer: { repositories: { nodes: [{ nameWithOwner: 'octo/api' }] } } } }),
      );
      render(
        <SettingsPanel
          open
          onClose={vi.fn()}
          config={defaultConfig()}
          update={vi.fn()}
          accounts={GITHUB_ONLY}
          ownerTokens={[{ owner: 'acme', login: 'octocat' }]}
          onOwnerTokensChanged={vi.fn()}
          onChangeToken={vi.fn()}
          onSignOut={vi.fn()}
        />,
      );
      await userEvent.click(field());
      expect(await screen.findByRole('option', { name: 'octo/api' })).toBeTruthy();

      vi.mocked(githubGraphql).mockImplementation((_query, _variables, owner) =>
        Promise.resolve(
          owner
            ? { data: { repositoryOwner: { repositories: { nodes: [{ nameWithOwner: 'acme/web' }] } } } }
            : { data: { viewer: { repositories: { nodes: [{ nameWithOwner: 'octo/api' }] } } } },
        ),
      );
      await userEvent.click(document.body);
      await userEvent.click(field());
      expect(await screen.findByRole('option', { name: 'acme/web' })).toBeTruthy();
    });

    it('still pins typed input when suggestions fail to load', async () => {
      const { config } = setup();
      await pin('octo/repo');
      expect(screen.queryByRole('listbox', { name: 'Suggested repositories' })).toBeNull();
      expect(names(config())).toEqual(['octo/repo']);
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

  it('sets how your pull requests are grouped', async () => {
    const { config } = setup();
    const select = screen.getByRole('combobox', { name: 'Group by' });
    await userEvent.selectOptions(select, 'By status');
    expect(config().layout.groupMyPullRequests).toBe('status');

    await userEvent.click(screen.getByRole('checkbox', { name: 'Your pull requests' }));
    expect((select as HTMLSelectElement).disabled).toBe(true);
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
    await userEvent.click(screen.getByRole('button', { name: 'Replace GitHub token' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove GitHub token' }));
    expect(onChangeToken).toHaveBeenCalledExactlyOnceWith('github');
    expect(onSignOut).toHaveBeenCalledExactlyOnceWith('github');

    // GitLab is offered but not connected.
    await userEvent.click(screen.getByRole('button', { name: 'Connect GitLab' }));
    expect(onChangeToken).toHaveBeenLastCalledWith('gitlab');
  });

  describe('with GitLab connected', () => {
    function setupBoth(initial: Partial<DashboardConfig> = {}) {
      setGitLabHost('gitlab.example.com');
      return setup(initial, BOTH);
    }

    it('shows the instance and account, and wires its buttons', async () => {
      const { onChangeToken, onSignOut } = setupBoth();
      expect(screen.getByText('gitlab.example.com')).toBeTruthy();
      expect(screen.getByText('jane.doe')).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: 'Replace GitLab token' }));
      await userEvent.click(screen.getByRole('button', { name: 'Remove GitLab token' }));
      expect(onChangeToken).toHaveBeenCalledExactlyOnceWith('gitlab');
      expect(onSignOut).toHaveBeenCalledExactlyOnceWith('gitlab');
    });

    it('pins nested GitLab projects by path or link', async () => {
      const { config } = setupBoth();
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Service' }), 'GitLab');
      await pin('group/sub/project');
      // A link picks its service, whatever is selected.
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Service' }), 'GitHub');
      await pin('https://gitlab.example.com/acme/api/-/merge_requests/3');
      await pin('octo/repo');
      expect(config().repos.map((r) => [r.provider, r.owner, r.name])).toEqual([
        ['gitlab', 'group/sub', 'project'],
        ['gitlab', 'acme', 'api'],
        ['github', 'octo', 'repo'],
      ]);
      expect(screen.getByRole('button', { name: /^▸ group\/sub\/project/ }).textContent).toContain('GitLab');
    });

    it('suggests projects from GitLab when it is selected', async () => {
      vi.mocked(gitlabGraphql).mockResolvedValue({
        data: { projects: { nodes: [{ fullPath: 'group/sub/web', archived: false }] } },
      });
      setupBoth();
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Service' }), 'GitLab');
      await userEvent.click(screen.getByRole('combobox', { name: 'Repository to pin' }));
      expect(await screen.findByRole('option', { name: 'group/sub/web' })).toBeTruthy();
      expect(githubGraphql).not.toHaveBeenCalled();
    });

    it('rejects a GitHub-style path that is not a GitLab project', async () => {
      setupBoth();
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Service' }), 'GitLab');
      await pin('group/-bad');
      expect(screen.getByRole('alert').textContent).toBe('Enter a project as group/project or a link to it.');
    });
  });

  it('does not pin GitLab links while GitLab is not connected', async () => {
    const { config } = setup();
    await pin('https://gitlab.com/group/project');
    expect(config().repos).toEqual([]);
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('links to a token form for the owner being added', async () => {
    setup();
    expect(screen.getByRole('link', { name: 'Create a token' }).getAttribute('href')).not.toContain('target_name');
    await userEvent.type(screen.getByRole('textbox', { name: 'Account or organization' }), 'acme');
    const link = screen.getByRole('link', { name: 'Create a token for acme' });
    expect(new URL(link.getAttribute('href')!).searchParams.get('target_name')).toBe('acme');
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
      ['an unknown provider', JSON.stringify({ version: 1, repos: [{ provider: 'gitea', owner: 'a', name: 'b' }] })],
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
