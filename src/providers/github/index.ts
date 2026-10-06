import { repoId, type PinnedRepo } from '../../config/schema';
import { AppError, githubGraphql } from '../../lib/transport';
import { groupByToken, mergeInbox } from '../tokens';
import type { InboxSnapshot, Provider, RateLimit, RepoResult } from '../types';
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

  async fetchRepos(repos: PinnedRepo[], tokenOwners: readonly string[]) {
    const results = new Map<string, RepoResult>();
    let rateLimit: RateLimit | null = null;

    for (const group of groupByToken(repos, tokenOwners)) {
      try {
        for (const batch of chunk(group.repos, REPOS_PER_REQUEST)) {
          const { query, variables } = buildReposQuery(batch);
          const res = await githubGraphql<Record<string, unknown>>(query, variables, group.owner);
          const data = res.data ?? {};
          // Each token has its own budget; surface the one closest to running out.
          const limit = mapRateLimit(data.rateLimit);
          if (limit && (!rateLimit || limit.remaining < rateLimit.remaining)) rateLimit = limit;

          batch.forEach((repo, i) => {
            const alias = repoAlias(i);
            const raw = data[alias];
            if (raw) {
              results.set(repoId(repo), { ok: true, data: mapRepository(raw, repo) });
            } else {
              const err = res.errors?.find((e) => e.path?.[0] === alias);
              results.set(repoId(repo), { ok: false, error: describeRepoError(err) });
            }
          });

          if (!res.data && res.errors?.length) {
            throw new AppError('http', 'GitHub rejected the request.');
          }
        }
      } catch (err) {
        // The default token failing is a dashboard-wide problem (e.g. it was
        // revoked). A per-owner token failing only affects that owner's cards.
        if (group.owner === null) throw err;
        const message = err instanceof Error ? err.message : 'Request failed';
        for (const repo of group.repos) {
          if (!results.get(repoId(repo))?.ok) {
            results.set(repoId(repo), { ok: false, error: `Token for ${group.owner}: ${message}` });
          }
        }
      }
    }
    return { repos: results, rateLimit };
  },

  async fetchInbox(config, tokenOwners) {
    const variables = {
      n: config.limit,
      ...INBOX_SEARCHES,
      withReview: config.reviewRequests,
      withMine: config.myPullRequests,
      withAssigned: config.assigned,
    };
    const fetchWith = async (owner: string | null): Promise<InboxSnapshot> => {
      const res = await githubGraphql(INBOX_QUERY, variables, owner);
      if (!res.data) throw new AppError('http', 'Could not load your inbox from GitHub.');
      return mapInbox(res.data);
    };

    // The default token drives the inbox; per-owner tokens add items only
    // they can see. Those extra fetches are best-effort.
    const [primary, ...others] = await Promise.allSettled([
      fetchWith(null),
      ...tokenOwners.map((owner) => fetchWith(owner)),
    ]);
    if (primary!.status === 'rejected') throw primary!.reason;
    const extra = others.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    return mergeInbox(primary!.value, extra, config.limit);
  },
};
