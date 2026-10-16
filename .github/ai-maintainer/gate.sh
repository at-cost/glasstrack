#!/usr/bin/env bash
# Merge gate for AI-maintainer pull requests. Deterministic: no AI involved.
# Merges a pull request only if (1) it comes from an ai/* branch in this repo,
# (2) it touches no protected path, (3) it is small, and (4) the test job passed.
# Otherwise it labels the PR needs-human and leaves it for a person.
#
# Usage: gate.sh <pr-number> <tests-result: success|failure|skipped>
# Needs: GH_TOKEN (pull-requests: write, contents: write), GITHUB_REPOSITORY.
set -euo pipefail

PR="$1"
TESTS="$2"
MAX_FILES=15
MAX_LINES=400

PROTECTED_RE='^(\.github/|deploy/|docker/|scripts/|Dockerfile|docker-compose[^/]*\.ya?ml$|package\.json$|[^/]+/[^/]+/package\.json$|[^/]+/package\.json$|pnpm-lock\.yaml$|\.env|apps/server/src/(billing|finances|auth|migrations|db|lib)/|apps/server/src/config\.ts$|apps/server/src/modules/workspaceTx\.ts$|packages/shared/src/money/|apps/server/src/site/pages/legal\.tsx$|apps/server/src/site/operator\.ts$)'

out() { echo "$1" | tee -a gate-result.md; }
hold() {
  out "Not merged: $1"
  gh pr edit "$PR" --repo "$GITHUB_REPOSITORY" --add-label needs-human >/dev/null 2>&1 || true
  gh pr comment "$PR" --repo "$GITHUB_REPOSITORY" --body "Not merged automatically: $1. A person will review this. (merge check)" >/dev/null
  exit 0
}

info=$(gh pr view "$PR" --repo "$GITHUB_REPOSITORY" --json headRefName,isCrossRepository,state,additions,deletions,files,url)
head=$(jq -r .headRefName <<<"$info")
cross=$(jq -r .isCrossRepository <<<"$info")
state=$(jq -r .state <<<"$info")
url=$(jq -r .url <<<"$info")
out "Pull request: $url"

[[ "$state" == "OPEN" ]] || { out "Skipped: pull request is $state"; exit 0; }
[[ "$cross" == "false" && "$head" == ai/* ]] || hold "it isn't an ai/* branch in this repository"

files=$(jq -r '.files[].path' <<<"$info")
nfiles=$(wc -l <<<"$files" | tr -d ' ')
lines=$(( $(jq -r .additions <<<"$info") + $(jq -r .deletions <<<"$info") ))
blocked=$(grep -E "$PROTECTED_RE" <<<"$files" || true)

[[ -z "$blocked" ]] || hold "it changes protected files ($(tr '\n' ' ' <<<"$blocked"))"
(( nfiles <= MAX_FILES )) || hold "it changes $nfiles files (limit $MAX_FILES)"
(( lines <= MAX_LINES )) || hold "it changes $lines lines (limit $MAX_LINES)"
[[ "$TESTS" == "success" ]] || hold "the tests did not pass ($TESTS)"

gh pr merge "$PR" --repo "$GITHUB_REPOSITORY" --squash --delete-branch
out "Merged: $nfiles files, $lines lines, all tests passed."
