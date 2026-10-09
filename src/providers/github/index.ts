import { repoId, type PinnedRepo } from '../../config/schema';
import { AppError, githubGraphql } from '../../lib/transport';
import type { Provider, RepoResult } from '../types';
import { describeRepoError, mapInbox, mapRateLimit, mapRepository } from './map';
import { buildReposQuery, INBOX_QUERY, INBOX_SEARCHES, repoAlias } from './queries';

/** GitHub limits query complexity; batch repositories to stay well under it. */
const REPOS_PER_REQUEST = 10;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const github: Provider = {
  id: 'github',
  label: 'GitHub',
  tokenHelpUrl: 'https://github.com/settings/personal-access-tokens/new',

  async fetchRepos(repos: PinnedRepo[]) {
    const results = new Map<string, RepoResult>();
    let rateLimit = null;

    for (const batch of chunk(repos, REPOS_PER_REQUEST)) {
      const { query, variables } = buildReposQuery(batch);
      const res = await githubGraphql<Record<string, unknown>>(query, variables);
      const data = res.data ?? {};
      rateLimit = mapRateLimit(data.rateLimit) ?? rateLimit;

      batch.forEach((repo, i) => {
        const alias = repoAlias(i);
        const raw = data[alias];
        // An error anywhere under the alias (e.g. on CI or PRs) means part of
        // the card would be silently empty, so report it instead.
        const err = res.errors?.find((e) => e.path?.[0] === alias);
        if (raw && !err) {
          results.set(repoId(repo), { ok: true, data: mapRepository(raw, repo) });
        } else {
          results.set(repoId(repo), { ok: false, error: describeRepoError(err) });
        }
      });

      if (!res.data && res.errors?.length) {
        throw new AppError('http', 'GitHub rejected the request.');
      }
    }
    return { repos: results, rateLimit };
  },

  async fetchInbox(config) {
    const res = await githubGraphql(INBOX_QUERY, {
      n: config.limit,
      ...INBOX_SEARCHES,
      withReview: config.reviewRequests,
      withMine: config.myPullRequests,
      withAssigned: config.assigned,
    });
    if (!res.data) throw new AppError('http', 'Could not load your inbox from GitHub.');
    return mapInbox(res.data);
  },
};
