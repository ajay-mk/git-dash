//! The GitHub GraphQL documents IsItGreen can run.
//!
//! The frontend never sends query text for GitHub. It names one of the
//! operations below and passes variables; repository cards send a list of
//! repositories, and [`repos_query`] builds the batched document from the
//! constant pieces in this file. A compromised webview can therefore only run
//! these read-only queries, whatever the token could do.

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::error::{Error, Result};

/// Repositories per card request; matches `REPOS_PER_REQUEST` in
/// `src/providers/github/index.ts`.
pub const MAX_REPOS_PER_REQUEST: usize = 10;
/// Upper bound on any list the frontend asks for.
const MAX_LIST: u32 = 100;

macro_rules! ci_rollup {
    () => {
        "statusCheckRollup { state }"
    };
}

macro_rules! pr_fields {
    () => {
        concat!(
            "number title url isDraft updatedAt reviewDecision mergeable ",
            "author { login } ",
            "commits(last: 1) { nodes { commit { ",
            ci_rollup!(),
            " } } } ",
            "repository { nameWithOwner }"
        )
    };
}

macro_rules! issue_fields {
    () => {
        concat!(
            "number title url updatedAt ",
            "author { login } ",
            "labels(first: 4) { nodes { name color } } ",
            "repository { nameWithOwner }"
        )
    };
}

macro_rules! reviewer {
    () => {
        "__typename ... on User { login } ... on Team { id }"
    };
}

macro_rules! assigned_events {
    () => {
        concat!(
            "timelineItems(itemTypes: [ASSIGNED_EVENT], last: $events) { ",
            "nodes { ... on AssignedEvent { createdAt assignee { __typename ... on User { login } } } } }"
        )
    };
}

const INBOX: &str = concat!(
    "query IsItGreenInbox(",
    "$n: Int!, $events: Int!, ",
    "$reviewQ: String!, $mineQ: String!, $assignedQ: String!, ",
    "$withReview: Boolean!, $withMine: Boolean!, $withAssigned: Boolean!",
    ") { viewer { login } ",
    "reviewRequests: search(query: $reviewQ, type: ISSUE, first: $n) @include(if: $withReview) { ",
    "issueCount nodes { ... on PullRequest { ",
    pr_fields!(),
    " reviewRequests(first: 20) { nodes { requestedReviewer { ",
    reviewer!(),
    " } } } ",
    "timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: $events) { ",
    "nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { ",
    reviewer!(),
    " } } } } } } } ",
    "myPullRequests: search(query: $mineQ, type: ISSUE, first: $n) @include(if: $withMine) { ",
    "issueCount nodes { ... on PullRequest { ",
    pr_fields!(),
    " } } } ",
    "assigned: search(query: $assignedQ, type: ISSUE, first: $n) @include(if: $withAssigned) { ",
    "issueCount nodes { __typename ",
    "... on Issue { ",
    issue_fields!(),
    " ",
    assigned_events!(),
    " } ",
    "... on PullRequest { ",
    issue_fields!(),
    " ",
    assigned_events!(),
    " } } } }"
);

macro_rules! suggestion_order {
    () => {
        "orderBy: { field: PUSHED_AT, direction: DESC }"
    };
}

const VIEWER_REPOS: &str = concat!(
    "query IsItGreenViewerRepos($n: Int!) { viewer { repositories(",
    "first: $n, isArchived: false, ",
    "affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], ",
    "ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], ",
    suggestion_order!(),
    ") { nodes { nameWithOwner isArchived pushedAt } } } }"
);

const OWNER_REPOS: &str = concat!(
    "query IsItGreenOwnerRepos($owner: String!, $n: Int!) { repositoryOwner(login: $owner) { ",
    "repositories(first: $n, isArchived: false, ",
    suggestion_order!(),
    ") { nodes { nameWithOwner isArchived pushedAt } } } }"
);

macro_rules! details_common {
    () => {
        "createdAt bodyText comments { totalCount } labels(first: 10) { nodes { name color } }"
    };
}

const DETAILS: &str = concat!(
    "query IsItGreenDetails($url: URI!, $n: Int!) { resource(url: $url) { __typename ",
    "... on PullRequest { ",
    details_common!(),
    " baseRefName headRefName additions deletions changedFiles ",
    "commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: $n) { totalCount nodes { ",
    "__typename ",
    "... on CheckRun { name status conclusion detailsUrl } ",
    "... on StatusContext { context state targetUrl } ",
    "} } } } } } ",
    "latestReviews(first: $n) { nodes { state author { login } } } ",
    "reviewRequests(first: $n) { nodes { requestedReviewer { __typename ",
    "... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { slug } ",
    "} } } } ",
    "... on Issue { ",
    details_common!(),
    " assignees(first: 10) { nodes { login } } } } }"
);

/// The fixed operations, by the name the frontend uses.
fn fixed(operation: &str) -> Option<&'static str> {
    match operation {
        "IsItGreenInbox" => Some(INBOX),
        "IsItGreenViewerRepos" => Some(VIEWER_REPOS),
        "IsItGreenOwnerRepos" => Some(OWNER_REPOS),
        "IsItGreenDetails" => Some(DETAILS),
        _ => None,
    }
}

/// What one repository card needs.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepoSpec {
    owner: String,
    name: String,
    #[serde(default)]
    ci: bool,
    /// How many open pull requests to fetch, if the card shows them.
    #[serde(default)]
    pull_requests: Option<u32>,
    #[serde(default)]
    issues: Option<IssuesSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IssuesSpec {
    limit: u32,
    #[serde(default)]
    label: Option<String>,
}

fn list_size(n: u32) -> Result<u32> {
    if (1..=MAX_LIST).contains(&n) {
        Ok(n)
    } else {
        Err(Error::ForbiddenOperation)
    }
}

/// Builds the batched repository query. Only the constant pieces above and
/// numbered variable names end up in the text; every value from the
/// frontend is passed as a variable. Results are under the aliases `r0`,
/// `r1`, ... in the order given.
pub fn repos_query(repos: &[RepoSpec]) -> Result<(String, Value)> {
    if repos.is_empty() || repos.len() > MAX_REPOS_PER_REQUEST {
        return Err(Error::ForbiddenOperation);
    }
    let mut defs: Vec<String> = Vec::new();
    let mut selections: Vec<String> = Vec::new();
    let mut vars = Map::new();

    for (i, repo) in repos.iter().enumerate() {
        defs.push(format!("$o{i}: String!, $n{i}: String!"));
        vars.insert(format!("o{i}"), Value::from(repo.owner.as_str()));
        vars.insert(format!("n{i}"), Value::from(repo.name.as_str()));

        let mut parts = vec!["nameWithOwner url isPrivate isArchived".to_owned()];
        parts.push(if repo.ci {
            concat!(
                "defaultBranchRef { name target { ... on Commit { ",
                ci_rollup!(),
                " } } }"
            )
            .to_owned()
        } else {
            "defaultBranchRef { name }".to_owned()
        });

        if let Some(n) = repo.pull_requests {
            defs.push(format!("$pr{i}: Int!"));
            vars.insert(format!("pr{i}"), Value::from(list_size(n)?));
            parts.push(format!(
                "pullRequests(states: OPEN, first: $pr{i}, orderBy: {{ field: UPDATED_AT, direction: DESC }}) {{ totalCount nodes {{ {} }} }}",
                pr_fields!()
            ));
        }
        if let Some(issues) = &repo.issues {
            defs.push(format!("$is{i}: Int!"));
            vars.insert(format!("is{i}"), Value::from(list_size(issues.limit)?));
            let mut label_arg = String::new();
            if let Some(label) = &issues.label {
                defs.push(format!("$il{i}: [String!]"));
                vars.insert(format!("il{i}"), Value::from(vec![label.as_str()]));
                label_arg = format!(", labels: $il{i}");
            }
            parts.push(format!(
                "issues(states: OPEN, first: $is{i}{label_arg}, orderBy: {{ field: UPDATED_AT, direction: DESC }}) {{ totalCount nodes {{ {} }} }}",
                issue_fields!()
            ));
        }
        selections.push(format!(
            "r{i}: repository(owner: $o{i}, name: $n{i}) {{ {} }}",
            parts.join(" ")
        ));
    }

    let query = format!(
        "query IsItGreenRepos({}) {{ {} rateLimit {{ remaining limit resetAt }} }}",
        defs.join(", "),
        selections.join(" ")
    );
    Ok((query, Value::Object(vars)))
}

/// Resolves what the frontend asked for into a document and its variables.
/// `IsItGreenRepos` takes `{ "repos": [RepoSpec, ...] }`; the fixed operations
/// take their own variables as they are.
pub fn resolve(operation: &str, variables: Value) -> Result<(String, Value)> {
    if !variables.is_object() {
        return Err(Error::ForbiddenOperation);
    }
    if operation == "IsItGreenRepos" {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Args {
            repos: Vec<RepoSpec>,
        }
        let args: Args =
            serde_json::from_value(variables).map_err(|_| Error::ForbiddenOperation)?;
        return repos_query(&args.repos);
    }
    let document = fixed(operation).ok_or(Error::ForbiddenOperation)?;
    Ok((document.to_owned(), variables))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graphql_guard::ensure_read_only;
    use serde_json::json;

    fn spec(value: Value) -> RepoSpec {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn fixed_operations_are_read_only_and_named() {
        for name in [
            "IsItGreenInbox",
            "IsItGreenViewerRepos",
            "IsItGreenOwnerRepos",
            "IsItGreenDetails",
        ] {
            let doc = fixed(name).unwrap();
            ensure_read_only(doc).unwrap();
            assert!(doc.starts_with(&format!("query {name}(")), "{name}");
            assert_eq!(doc.matches('{').count(), doc.matches('}').count(), "{name}");
        }
    }

    #[test]
    fn unknown_operations_and_query_text_are_refused() {
        for op in [
            "mutation { addStar(input: {}) { clientMutationId } }",
            "{ viewer { login } }",
            "IsItGreenUnknown",
            "",
        ] {
            assert!(matches!(
                resolve(op, json!({})),
                Err(Error::ForbiddenOperation)
            ));
        }
        assert!(resolve("IsItGreenInbox", json!([])).is_err());
    }

    #[test]
    fn suggestions_skip_archived_repositories() {
        assert!(VIEWER_REPOS.contains("isArchived: false"));
        assert!(OWNER_REPOS.contains("isArchived: false"));
    }

    #[test]
    fn repo_values_only_travel_as_variables() {
        let evil = "x\") { id } mutation {";
        let (query, vars) = repos_query(&[spec(json!({
            "owner": evil,
            "name": "y",
            "issues": { "limit": 1, "label": "\"}" },
        }))])
        .unwrap();
        ensure_read_only(&query).unwrap();
        assert!(!query.contains("mutation"));
        assert!(!query.contains("\"}"));
        assert_eq!(vars["o0"], evil);
        assert_eq!(vars["il0"], json!(["\"}"]));
    }

    #[test]
    fn only_requests_sections_for_enabled_widgets() {
        let (query, vars) =
            repos_query(&[spec(json!({ "owner": "a", "name": "b", "ci": true }))]).unwrap();
        assert!(query.contains("statusCheckRollup"));
        assert!(!query.contains("pullRequests("));
        assert!(!query.contains("issues("));
        assert_eq!(vars.as_object().unwrap().len(), 2);

        let (query, vars) = repos_query(&[
            spec(json!({ "owner": "a", "name": "b", "pullRequests": 50 })),
            spec(json!({ "owner": "c", "name": "d", "issues": { "limit": 5 } })),
        ])
        .unwrap();
        ensure_read_only(&query).unwrap();
        assert!(!query.contains("target { ... on Commit"));
        assert!(query.contains("r0: repository(owner: $o0, name: $n0)"));
        assert!(query.contains("r1: repository(owner: $o1, name: $n1)"));
        assert!(query.contains("rateLimit"));
        assert_eq!(vars["pr0"], 50);
        assert_eq!(vars["is1"], 5);
        assert!(vars.get("il1").is_none());
    }

    #[test]
    fn refuses_bad_repo_requests() {
        let one = || json!({ "owner": "a", "name": "b" });
        let many: Vec<Value> = (0..=MAX_REPOS_PER_REQUEST).map(|_| one()).collect();
        for variables in [
            json!({ "repos": [] }),
            json!({ "repos": many }),
            json!({ "repos": [{ "owner": "a", "name": "b", "pullRequests": 0 }] }),
            json!({ "repos": [{ "owner": "a", "name": "b", "pullRequests": 101 }] }),
            json!({ "repos": [{ "owner": "a", "name": "b", "query": "mutation" }] }),
            json!({ "repos": [one()], "extra": 1 }),
            json!({ "repos": "a/b" }),
        ] {
            assert!(
                matches!(
                    resolve("IsItGreenRepos", variables.clone()),
                    Err(Error::ForbiddenOperation)
                ),
                "{variables}"
            );
        }
        assert!(resolve("IsItGreenRepos", json!({ "repos": [one()] })).is_ok());
    }
}
