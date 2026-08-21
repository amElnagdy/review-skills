#!/usr/bin/env bash
# Harvest a PR's review threads and top-level bot reviews in one shot.
#
# Usage:  threads.sh <pr-number> [owner/repo]
#         threads.sh 123
#         threads.sh 123 owner/repo
#
# Emits JSON on stdout:
#   .head       the PR's current head SHA. Compare each review's commit_id
#                 against it to know which bots have reviewed the current push.
#   .threads[]  inline review threads (all pages), each with:
#       thread_id      GraphQL node id  -> use to RESOLVE the conversation
#       reply_to       REST comment id  -> use to REPLY inside the thread
#       resolved       bool             already-resolved threads need nothing
#       outdated       bool             the line moved; finding may be stale
#       line           current line, falls back to original_line when outdated
#       comment_count  a bump since the previous round means a bot followed up
#                      inside the thread; fetch that thread directly to read it
#       body           the thread's first comment, the finding itself
#       last_author, last_body   the newest comment in the thread
#       debate_review  true when the first comment carries a debate-review
#                      marker. Those threads are reviewer threads even though
#                      the author is the PR owner's own account, not a [bot].
#       debate_id, debate_status, debate_severity
#                      parsed from the marker (F1/D2, agreed|contested,
#                      blocking|non-blocking); null when not a debate-review thread
#   .reviews[]  top-level (non-inline) review bodies, which is where Codex
#                 and Greptile post their summary findings. These have no
#                 thread to resolve; answer them with one PR comment.
#                 A debate-review round's body is here too, with
#                 debate_review:true and debate_head (the sha it reviewed).
#
# Threads and top-level reviews are different objects in GitHub's model. A
# babysit round that only reads one of them will silently miss half the
# findings. Codex posts its P1 list as a top-level review body, while
# debate-review and CodeRabbit post inline.

set -euo pipefail

PR="${1:?usage: threads.sh <pr-number> [owner/repo]}"
REPO="${2:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

# --paginate follows pageInfo until exhausted, so >100 threads are not silently
# dropped; --slurp wraps the pages in one array so the output stays valid JSON.
PAGES=$(gh api graphql --paginate --slurp -f query='
query($owner:String!,$repo:String!,$pr:Int!,$endCursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$pr){
      headRefOid
      reviewThreads(first:100, after:$endCursor){
        pageInfo{ hasNextPage endCursor }
        nodes{
          id isResolved isOutdated path line originalLine
          first: comments(first:1){ totalCount nodes{ databaseId author{login} body } }
          last:  comments(last:1){ nodes{ author{login} body } }
        }
      }
    }
  }
}' -F owner="$OWNER" -F repo="$NAME" -F pr="$PR")

HEAD_SHA=$(jq -r '.[0].data.repository.pullRequest.headRefOid' <<<"$PAGES")

THREADS=$(jq '[.[].data.repository.pullRequest.reviewThreads.nodes[] | {
        thread_id:     .id,
        reply_to:      .first.nodes[0].databaseId,
        resolved:      .isResolved,
        outdated:      .isOutdated,
        author:        .first.nodes[0].author.login,
        path:          .path,
        line:          (.line // .originalLine),
        original_line: .originalLine,
        comment_count: .first.totalCount,
        body:          .first.nodes[0].body,
        last_author:   .last.nodes[0].author.login,
        last_body:     .last.nodes[0].body
      }
      | . + (.body | capture("<!-- debate-review:(?<debate_id>[FD][0-9]+) status=(?<debate_status>[a-z-]+) severity=(?<debate_severity>[a-z-]+) -->")
                   // {debate_id:null, debate_status:null, debate_severity:null})
      | . + {debate_review: (.debate_id != null)}
      ]' <<<"$PAGES")

# --slurp here too: past one page, bare --paginate emits back-to-back arrays,
# which is not valid JSON for the --argjson merge below. gh refuses --slurp
# together with --jq, so the filter runs in external jq.
REVIEWS=$(gh api "repos/$REPO/pulls/$PR/reviews" --paginate --slurp \
  | jq '[.[][] | {id, author: .user.login, state, commit_id, submitted_at, body}
         | select(.body != "")
         | . + ((.body | capture("<!-- debate-review head=(?<debate_head>[0-9a-f]+)")) // {debate_head:null})
         | . + {debate_review: (.debate_head != null)}]')

jq -n --argjson t "$THREADS" --argjson r "$REVIEWS" \
      --arg repo "$REPO" --arg pr "$PR" --arg head "$HEAD_SHA" \
  '{repo:$repo, pr:($pr|tonumber), head:$head, threads:$t, reviews:$r,
    unresolved:[$t[]|select(.resolved==false)]|length}'
