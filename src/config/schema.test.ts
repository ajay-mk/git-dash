import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  defaultConfig,
  defaultWidgets,
  parseConfig,
  parseGitLabInput,
  parseGitLabPath,
  parseRepoInput,
  providerOfInput,
  pruneLayout,
  shiftListLimits,
} from './schema';

describe('parseRepoInput', () => {
  it('accepts owner/name and GitHub URLs', () => {
    expect(parseRepoInput('facebook/react')).toEqual({ owner: 'facebook', name: 'react' });
    expect(parseRepoInput(' https://github.com/vitejs/vite/ ')).toEqual({ owner: 'vitejs', name: 'vite' });
    expect(parseRepoInput('github.com/a-b/c.d_e.git')).toEqual({ owner: 'a-b', name: 'c.d_e' });
    expect(parseRepoInput('https://github.com/acme/api.git/')).toEqual({ owner: 'acme', name: 'api' });
  });

  it('rejects anything else', () => {
    for (const bad of ['', 'react', 'a/b/c', '-bad/x', 'a/..', 'a/.', 'own er/x', 'a/b?x=1', 'https://evil.com/a/b', 'a/<script>']) {
      expect(parseRepoInput(bad), bad).toBeNull();
    }
  });
});

describe('GitLab paths', () => {
  it('splits nested groups from the project', () => {
    expect(parseGitLabPath('acme/api')).toEqual({ owner: 'acme', name: 'api' });
    expect(parseGitLabPath('acme/platform/core/api.v2')).toEqual({ owner: 'acme/platform/core', name: 'api.v2' });
    expect(parseGitLabPath('acme/api.git')).toEqual({ owner: 'acme', name: 'api' });
  });

  it('rejects invalid paths', () => {
    for (const bad of ['', 'api', 'acme//api', '-acme/api', 'acme/.api', 'acme/api.', 'acme/x.atom', 'a b/c', 'a/../b', 'a/<b>', `${'g/'.repeat(21)}p`]) {
      expect(parseGitLabPath(bad), bad).toBeNull();
    }
  });

  it('reads links on the instance, including pages inside a project', () => {
    const host = 'gitlab.example.com';
    expect(parseGitLabInput(' https://gitlab.example.com/acme/sub/api/ ', host)).toEqual({ owner: 'acme/sub', name: 'api' });
    expect(parseGitLabInput('gitlab.example.com/acme/api/-/merge_requests/3', host)).toEqual({ owner: 'acme', name: 'api' });
    expect(parseGitLabInput('https://gitlab.example.com/acme/api?tab=x', host)).toEqual({ owner: 'acme', name: 'api' });
    expect(parseGitLabInput('acme/api', host)).toEqual({ owner: 'acme', name: 'api' });
    expect(parseGitLabInput('https://gitlab.com/acme/api', host)).toBeNull();
  });

  it('tells which service a pasted link is for', () => {
    expect(providerOfInput('https://github.com/a/b', 'gitlab.com')).toBe('github');
    expect(providerOfInput('https://gitlab.com/a/b', 'gitlab.com')).toBe('gitlab');
    expect(providerOfInput('https://gitlab.com/a/b', null)).toBeNull();
    expect(providerOfInput('a/b', 'gitlab.com')).toBeNull();
  });
});

describe('parseConfig', () => {
  const valid = {
    ...defaultConfig(),
    repos: [{ provider: 'github', owner: 'a', name: 'b', widgets: defaultWidgets() }],
  };

  it('round-trips a valid config', () => {
    expect(parseConfig(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
    const gitlab = { ...valid, repos: [{ provider: 'gitlab', owner: 'acme/platform', name: 'api', widgets: defaultWidgets() }] };
    expect(parseConfig(JSON.parse(JSON.stringify(gitlab)))).toEqual(gitlab);
  });

  it('rejects GitLab projects whose owner and name do not split as stored', () => {
    for (const [owner, name] of [['acme', 'platform/api'], ['acme/', 'api'], ['acme', '../api']]) {
      expect(() => parseConfig({ ...valid, repos: [{ provider: 'gitlab', owner, name }] }), `${owner} ${name}`).toThrow(ConfigError);
    }
  });

  it('rejects malformed input', () => {
    expect(() => parseConfig(null)).toThrow(ConfigError);
    expect(() => parseConfig({ ...valid, version: 2 })).toThrow(ConfigError);
    expect(() => parseConfig({ ...valid, repos: [{ provider: 'gitea', owner: 'a', name: 'b' }] })).toThrow(ConfigError);
    expect(() => parseConfig({ ...valid, repos: [{ provider: 'github', owner: 'a', name: '../../x' }] })).toThrow(ConfigError);
    expect(() => parseConfig({ ...valid, repos: Array(51).fill(valid.repos[0]) })).toThrow(ConfigError);
  });

  it('keeps only known sections, groupings and pinned widgets', () => {
    const parsed = parseConfig({
      ...valid,
      layout: {
        collapsedInbox: ['assigned', 'bogus', 'assigned', 7],
        groupMyPullRequests: 'repo',
        collapsedWidgets: ['github:a/b#issues', 'github:gone/repo#issues', 'github:a/b#nope', 1],
        cardSpans: { 'github:a/b': 2, 'github:gone/repo': 2 },
        cardRows: { 'github:a/b': 30, 'github:gone/repo': 30 },
      },
    });
    expect(parsed.layout).toEqual({
      collapsedInbox: ['assigned'],
      groupMyPullRequests: 'repo',
      collapsedWidgets: ['github:a/b#issues'],
      cardSpans: { 'github:a/b': 2 },
      cardRows: { 'github:a/b': 30 },
    });
    for (const rows of [5, 201, 30.5, '30']) {
      const layout = { ...defaultConfig().layout, cardRows: { 'github:a/b': rows } };
      expect(parseConfig({ ...valid, layout }).layout.cardRows).toEqual({});
    }
    for (const span of [1, 4, 2.5, '2', null]) {
      const layout = { ...defaultConfig().layout, cardSpans: { 'github:a/b': span } };
      expect(parseConfig({ ...valid, layout }).layout.cardSpans).toEqual({});
    }
    expect(parseConfig({ ...valid, layout: { cardSpans: [2] } }).layout.cardSpans).toEqual({});
    expect(parseConfig({ ...valid, layout: { groupMyPullRequests: 'size' } }).layout).toEqual(
      defaultConfig().layout,
    );
  });

  it('sanitises and clamps fields', () => {
    const parsed = parseConfig({
      ...valid,
      refreshMinutes: 0.001,
      theme: 'hacker',
      inbox: { enabled: 'yes', limit: 9999 },
      repos: [
        {
          provider: 'github',
          owner: 'a',
          name: 'b',
          widgets: [
            { type: 'issues', limit: -5, label: 'bug\u0000\n' },
            { type: 'issues', limit: 3 },
            { type: 'unknown' },
            { type: 'pullRequests', limit: 'many', hideDrafts: 1 },
          ],
        },
        { provider: 'github', owner: 'A', name: 'B' },
      ],
    });
    expect(parsed.refreshMinutes).toBe(5);
    expect(parsed.theme).toBe('system');
    expect(parsed.inbox.enabled).toBe(true);
    expect(parsed.inbox.limit).toBe(20);
    expect(parsed.layout).toEqual(defaultConfig().layout);
    expect(parsed.repos).toHaveLength(1); // case-insensitive duplicate dropped
    expect(parsed.repos[0]!.widgets).toEqual([
      { type: 'issues', limit: 1, label: 'bug' },
      { type: 'pullRequests', limit: 5, hideDrafts: false },
    ]);
  });
});

describe('pruneLayout', () => {
  it('forgets collapsed widgets that are no longer pinned', () => {
    const repo = { provider: 'github' as const, owner: 'a', name: 'b', widgets: defaultWidgets() };
    const config = {
      ...defaultConfig(),
      repos: [repo],
      layout: { ...defaultConfig().layout, collapsedWidgets: ['github:a/b#issues', 'github:a/b#pullRequests'] },
    };
    expect(pruneLayout(config)).toBe(config);

    const fewer = { ...config, repos: [{ ...repo, widgets: defaultWidgets().filter((w) => w.type !== 'issues') }] };
    expect(pruneLayout(fewer).layout.collapsedWidgets).toEqual(['github:a/b#pullRequests']);
    expect(pruneLayout({ ...config, repos: [] }).layout.collapsedWidgets).toEqual([]);
  });

  it('forgets the size of unpinned cards', () => {
    const repo = { provider: 'github' as const, owner: 'a', name: 'b', widgets: defaultWidgets() };
    const layout = { ...defaultConfig().layout, cardSpans: { 'github:a/b': 3 }, cardRows: { 'github:a/b': 40 } };
    const config = { ...defaultConfig(), repos: [repo], layout };
    expect(pruneLayout(config)).toBe(config);
    expect(pruneLayout({ ...config, repos: [] }).layout.cardSpans).toEqual({});
    expect(pruneLayout({ ...config, repos: [] }).layout.cardRows).toEqual({});
  });
});

describe('shiftListLimits', () => {
  it('moves every list by the same amount within the allowed range', () => {
    const widgets = [
      { type: 'ci' as const },
      { type: 'pullRequests' as const, limit: 5, hideDrafts: false },
      { type: 'issues' as const, limit: 2, label: null },
    ];
    expect(shiftListLimits(widgets, 3)).toEqual([
      { type: 'ci' },
      { type: 'pullRequests', limit: 8, hideDrafts: false },
      { type: 'issues', limit: 5, label: null },
    ]);
    expect(shiftListLimits(widgets, -4).map((w) => ('limit' in w ? w.limit : null))).toEqual([null, 1, 1]);
    expect(shiftListLimits(widgets, 40).map((w) => ('limit' in w ? w.limit : null))).toEqual([null, 20, 20]);
    expect(shiftListLimits(widgets, 1, ['issues'])[2]).toBe(widgets[2]);
    const atMin = shiftListLimits(widgets, -10);
    expect(shiftListLimits(atMin, -1).every((w, i) => w === atMin[i])).toBe(true);
  });
});
