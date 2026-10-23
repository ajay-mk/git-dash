//! Ensures only read-only GraphQL documents are sent.
//!
//! For GitLab this is what keeps the frontend's queries read-only. GitHub
//! queries are IsItGreen's own (`github_queries.rs`) and are checked here too,
//! as defence in depth. Users are told to create read-only tokens, but if a
//! token has write access, a compromised frontend still must not be able to
//! modify anything on their behalf.

use crate::error::{Error, Result};

pub const MAX_QUERY_BYTES: usize = 32 * 1024;

/// Returns `Ok(())` if every top-level operation in `document` is a `query`
/// (or an anonymous `{ ... }` selection set, which is also a query).
///
/// It scans the document while skipping comments and string literals and
/// inspects every keyword that appears outside of any selection set, which is
/// where operation types (`query`, `mutation`, `subscription`) must appear.
pub fn ensure_read_only(document: &str) -> Result<()> {
    if document.len() > MAX_QUERY_BYTES {
        return Err(Error::RequestTooLarge);
    }

    let bytes = document.as_bytes();
    let mut depth: usize = 0;
    let mut i = 0;
    let mut saw_operation = false;

    while i < bytes.len() {
        let c = bytes[i];
        match c {
            b'#' => {
                // GraphQL ends a comment at either line terminator, CR or LF.
                while i < bytes.len() && bytes[i] != b'\n' && bytes[i] != b'\r' {
                    i += 1;
                }
            }
            b'"' => {
                i = skip_string(bytes, i)?;
                continue;
            }
            b'{' => {
                if depth == 0 {
                    saw_operation = true;
                }
                depth += 1;
            }
            b'}' => {
                depth = depth.checked_sub(1).ok_or(Error::ForbiddenOperation)?;
            }
            c if c.is_ascii_alphabetic() || c == b'_' => {
                let start = i;
                while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                    i += 1;
                }
                if depth == 0 {
                    let word = &document[start..i];
                    if word == "mutation" || word == "subscription" {
                        return Err(Error::ForbiddenOperation);
                    }
                }
                continue;
            }
            _ => {}
        }
        i += 1;
    }

    if depth != 0 || !saw_operation {
        return Err(Error::ForbiddenOperation);
    }
    Ok(())
}

/// Skips a `"string"` or `"""block string"""` starting at `start`, returning
/// the index just past its end.
fn skip_string(bytes: &[u8], start: usize) -> Result<usize> {
    let is_block = bytes[start..].starts_with(b"\"\"\"");
    let mut i = start + if is_block { 3 } else { 1 };
    while i < bytes.len() {
        if is_block {
            if bytes[i..].starts_with(b"\\\"\"\"") {
                i += 4;
                continue;
            }
            if bytes[i..].starts_with(b"\"\"\"") {
                return Ok(i + 3);
            }
        } else {
            match bytes[i] {
                b'\\' => {
                    i += 2;
                    continue;
                }
                b'"' => return Ok(i + 1),
                b'\n' | b'\r' => return Err(Error::ForbiddenOperation),
                _ => {}
            }
        }
        i += 1;
    }
    Err(Error::ForbiddenOperation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_queries() {
        assert!(ensure_read_only("{ viewer { login } }").is_ok());
        assert!(ensure_read_only(
            "query Q($o: String!) { repository(owner: $o, name: \"x\") { id } }"
        )
        .is_ok());
        assert!(ensure_read_only("query A { a } fragment F on User { login }").is_ok());
        // Field names inside selection sets are not operations.
        assert!(ensure_read_only("{ mutation subscription { id } }").is_ok());
    }

    #[test]
    fn rejects_mutations_and_subscriptions() {
        assert!(ensure_read_only("mutation { addStar(input: {}) { clientMutationId } }").is_err());
        assert!(ensure_read_only("subscription { x }").is_err());
        assert!(ensure_read_only("query A { a } mutation B { b }").is_err());
        assert!(ensure_read_only("  \n# comment\nmutation{x}").is_err());
    }

    #[test]
    fn strings_and_comments_cannot_hide_operations() {
        // A mutation after a string that contains braces is still detected.
        assert!(ensure_read_only("query { a(x: \"}\") } mutation { b }").is_err());
        assert!(ensure_read_only("query { a(x: \"\"\" } \"\"\") } mutation { b }").is_err());
        // Keywords inside strings/comments are harmless.
        assert!(ensure_read_only("query { a(x: \"mutation\") } # mutation").is_ok());
        // A comment ends at a bare CR, so what follows it is still checked.
        assert!(ensure_read_only("query { a } # c\rmutation { b }").is_err());
        assert!(ensure_read_only("query { a(x: \"a\rb\") }").is_err());
    }

    #[test]
    fn rejects_malformed_documents() {
        assert!(ensure_read_only("").is_err());
        assert!(ensure_read_only("{ a ").is_err());
        assert!(ensure_read_only("} {").is_err());
        assert!(ensure_read_only("query { a(x: \"unterminated) }").is_err());
        assert!(ensure_read_only(&"{a}".repeat(MAX_QUERY_BYTES)).is_err());
    }
}
