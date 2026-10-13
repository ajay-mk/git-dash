import { repoId, type PinnedRepo } from '../../config/schema';
import { AppError, githubGraphql } from '../../lib/transport';
import { groupByToken, mergeInbox } from '../tokens';
import type { InboxSnapshot, Provider, RateLimit, RepoResult } from '../types';
import { describeRepoError, isRateLimited, mapDetails, mapInbox, mapRateLimit, mapRepoSuggestions, mapRepository, type RepoSuggestion } from './map';
import {
  buildReposQuery,
  DETAILS_LIST_FETCHED,
  DETAILS_QUERY,
  INBOX_QUERY,
  INBOX_SEARCHES,
  OWNER_REPOS_QUERY,
  REPO_SUGGESTIONS_FETCHED,
  repoAlias,
  VIEWER_REPOS_QUERY,
} from './queries';
import { fineGrainedTokenUrl, PERMISSION_LABELS } from './tokenTemplate';
import { isSafeExternalUrl } from '../../lib/url';

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
  ownerTokens: true,
  newTokenUrl: fineGrainedTokenUrl,
  tokenPermissions: PERMISSION_LABELS,

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
            // An error anywhere under the alias (e.g. on CI or PRs) means part of
            // the card would be silently empty, so report it instead.
            const err = res.errors?.find((e) => e.path?.[0] === alias);
            if (raw && !err) {
              results.set(repoId(repo), { ok: true, data: mapRepository(raw, repo) });
            } else {
              results.set(repoId(repo), { ok: false, error: describeRepoError(err, repo.owner) });
            }
          });

          if (!res.data && res.errors?.length) {
            if (res.errors.some(isRateLimited)) {
              throw new AppError('rate_limited', 'GitHub API rate limit reached. The dashboard will update once it resets.');
            }
            throw new AppError('http', 'GitHub rejected the request.');
          }
        }
      } catch (err) {
        // The default token failing is a dashboard-wide problem (e.g. it was
        // revoked). A per-owner token failing only affects that owner's cards.
        if (group.owner === null) throw err;
        const message = err instanceof Error ? err.message : 'Request failed';
        const kind = err instanceof AppError && err.kind === 'rate_limited' ? 'rate_limited' : 'unknown';
        for (const repo of group.repos) {
          if (!results.get(repoId(repo))?.ok) {
            results.set(repoId(repo), { ok: false, error: { kind, message: `Token for ${group.owner}: ${message}` } });
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
      if (!res.data) {
        if (res.errors?.some(isRateLimited)) {
          throw new AppError('rate_limited', 'GitHub API rate limit reached. Your inbox will update once it resets.');
        }
        throw new AppError('http', 'Could not load your inbox from GitHub.');
      }
      return mapInbox(res.data, res.errors);
    };

    // The default token drives the inbox; per-owner tokens add items only
    // they can see. Those extra fetches are best-effort.
    const [primary, ...others] = await Promise.allSettled([
      fetchWith(null),
      ...tokenOwners.map((owner) => fetchWith(owner)),
    ]);
    if (primary!.status === 'rejected') throw primary!.reason;
    const extra = others.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    const inbox = mergeInbox(primary!.value, extra, config.limit);
    return extra.length < others.length ? { ...inbox, incomplete: true } : inbox;
  },

  async listRepos(tokenOwners) {
    const n = REPO_SUGGESTIONS_FETCHED;
    // Partial data (e.g. an organization behind SSO) still yields the rest,
    // but errors with no repositories at all (e.g. a rate limit) count as a
    // failure.
    const suggestions = (connection: unknown, errors: unknown[] | undefined) => {
      if (connection == null && errors?.length) throw new AppError('http', 'Could not list repositories.');
      return mapRepoSuggestions(connection);
    };
    const lists = await Promise.allSettled([
      githubGraphql<{ viewer?: { repositories?: unknown } }>(VIEWER_REPOS_QUERY, { n }).then((res) =>
        suggestions(res.data?.viewer?.repositories, res.errors),
      ),
      ...tokenOwners.map((owner) =>
        githubGraphql<{ repositoryOwner?: { repositories?: unknown } }>(OWNER_REPOS_QUERY, { owner, n }, owner).then(
          (res) => suggestions(res.data?.repositoryOwner?.repositories, res.errors),
        ),
      ),
    ]);
    // Every token failing is likely transient (network, rate limit); let the
    // caller retry rather than cache an empty list.
    const failed = lists.find((l) => l.status === 'rejected');
    if (failed && lists.every((l) => l.status === 'rejected')) throw failed.reason;
    const seen = new Map<string, RepoSuggestion>();
    for (const list of lists) {
      if (list.status !== 'fulfilled') continue;
      for (const repo of list.value) {
        const key = repo.name.toLowerCase();
        if (!seen.has(key)) seen.set(key, repo);
      }
    }
    // Each token's list is already newest first; interleave them so a recent
    // push seen only by a per-owner token is not buried. Stable for ties, and
    // never-pushed repositories go last.
    const repos = [...seen.values()]
      .sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''))
      .map((r) => r.name);
    return { repos, complete: !failed };
  },

  async fetchDetails(url, tokenOwners) {
    if (!isSafeExternalUrl(url)) throw new AppError('http', 'Not a GitHub link.');
    const fetchWith = async (token: string | null) => {
      const res = await githubGraphql<{ resource?: unknown }>(DETAILS_QUERY, { url, n: DETAILS_LIST_FETCHED }, token);
      const details = mapDetails(res.data?.resource);
      if (!details) {
        if (res.errors?.some(isRateLimited)) {
          throw new AppError('rate_limited', 'GitHub API rate limit reached. Try again once it resets.');
        }
        throw new AppError('http', 'Could not load details from GitHub.');
      }
      // Errors on nested fields (e.g. checks) leave them empty; say so on the card.
      return { ...details, incomplete: res.errors?.some((e) => e.path?.[0] === 'resource') ?? false };
    };
    // The inbox may have found this item with either token, so prefer the
    // owner's token and fall back to the default one.
    const owner = new URL(url).pathname.split('/')[1]?.toLowerCase() ?? '';
    if (!tokenOwners.includes(owner)) return fetchWith(null);
    try {
      const details = await fetchWith(owner);
      return details.incomplete ? await fetchWith(null).catch(() => details) : details;
    } catch {
      return fetchWith(null);
    }
  },
};
