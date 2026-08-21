#!/usr/bin/env bash
# Harvest a pull request's (GitHub) or merge request's (GitLab) reviewer threads and top-level
# review bodies in one shot, in one JSON shape.
#
# Usage:  threads.sh <number> [owner/repo] [--github | --gitlab] [--hostname <host>]
#         threads.sh 123                       # forge and repo from the cwd's git origin
#         threads.sh 123 owner/repo --github
#         threads.sh 45 group/sub/proj --gitlab --hostname gitlab.example.com
#
# Emits JSON on stdout:
#   .forge        "github" | "gitlab"
#   .host         the forge host
#   .repo, .pr    owner/repo (or group/path on GitLab) and the number
#   .head         current head sha
#   .pr_author    login of the PR/MR author. Their own notes are never reviewer findings.
#   .capabilities what this forge can tell you:
#       outdated          GitHub says when the line under a thread moved. GitLab does not.
#       review_commit_id  GitHub reviews carry the sha they reviewed. GitLab notes do not.
#       author_bot_flag   GitHub types every author (Bot vs User), so author_bot is reliable.
#                         GitLab only sometimes exposes author.bot; it is null when absent.
#   .threads[]    inline reviewer threads, each with:
#       thread_id      use to RESOLVE (GitHub GraphQL node id / GitLab discussion id)
#       reply_to       use to REPLY inside the thread (GitHub REST comment id / GitLab discussion id)
#       resolved, resolvable
#       outdated       GitHub only; null on GitLab
#       author, author_bot (true/false/null), author_is_pr_author
#       path, line, original_line, line_side ("RIGHT"/"LEFT" on GitHub, "new"/"old" on GitLab)
#       position_head  GitLab: the head sha the note was placed against; null on GitHub
#       comment_count  a bump since the previous round means someone followed up inside the thread
#       body           the thread's first comment, the finding itself
#       last_author, last_body
#       source         "thread" (GitHub) | "discussion" (GitLab)
#       debate_review, debate_id, debate_status, debate_severity, debate_level (P0/P1/P2)
#                      parsed from a debate-review marker in the first comment; debate-review posts
#                      from the user's own account, so these threads are reviewer threads even though
#                      the author is not a bot
#   .reviews[]    top-level bodies with no thread to resolve (Codex/Greptile summaries,
#                 the debate-review round body). Answer these with one PR comment.
#       id, author, author_bot, state (GitHub), commit_id (GitHub), submitted_at, body
#       source         "review" (GitHub) | "note" (GitLab)
#       debate_review, debate_head, debate_agreed, debate_contested
#   .unresolved   count of unresolved threads
#
# Threads and top-level bodies are different objects on both forges. A round that reads only one
# misses half the findings.
#
# GitLab: a "discussion" with individual_note:true is a plain comment, not a thread, so it is
# excluded from .threads. System notes ("changed the description") are excluded everywhere. Root
# notes of real discussions are excluded from .reviews so nothing appears twice.

set -euo pipefail

NUMBER=""; REPO=""; FORGE=""; HOST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --github) FORGE=github; shift ;;
    --gitlab) FORGE=gitlab; shift ;;
    --hostname) HOST="$2"; shift 2 ;;
    -h|--help) sed -n '2,50p' "$0"; exit 0 ;;
    *) if [ -z "$NUMBER" ]; then NUMBER="$1"; elif [ -z "$REPO" ]; then REPO="$1"; else echo "unexpected argument: $1" >&2; exit 2; fi; shift ;;
  esac
done
[ -n "$NUMBER" ] || { echo "usage: threads.sh <number> [owner/repo] [--github|--gitlab] [--hostname <host>]" >&2; exit 2; }

# ---------- detect forge and repo from git origin when not given ----------
if [ -z "$FORGE" ] || [ -z "$REPO" ]; then
  ORIGIN=$(git remote get-url origin 2>/dev/null || true)
  [ -n "$ORIGIN" ] || { echo "no --github/--gitlab + owner/repo given and no git origin in cwd" >&2; exit 2; }
  # https://host/path.git  |  git@host:path.git  |  ssh://git@host/path.git
  ORIGIN_HOST=$(printf '%s' "$ORIGIN" | sed -E 's#^(https?://|ssh://git@|git@)([^/:]+)[/:].*#\2#')
  ORIGIN_PATH=$(printf '%s' "$ORIGIN" | sed -E 's#^(https?://|ssh://git@|git@)[^/:]+[/:]##; s#/$##; s#\.git$##')
  [ -z "$FORGE" ] && { if [ "$ORIGIN_HOST" = "github.com" ]; then FORGE=github; else FORGE=gitlab; fi; }
  [ -z "$REPO" ] && REPO="$ORIGIN_PATH"
  [ -z "$HOST" ] && HOST="$ORIGIN_HOST"
fi
[ -n "$HOST" ] || { if [ "$FORGE" = github ]; then HOST=github.com; else HOST=gitlab.com; fi; }

# jq: parse the two debate-review markers. Shared by both forges.
JQ_MARKERS='
  def thread_marker:
    . + ((.body // "") | capture("<!-- debate-review:(?<debate_id>[FD][0-9]+) status=(?<debate_status>[a-z-]+) severity=(?<debate_severity>[a-z-]+)(?: level=(?<debate_level>P[0-9]))?[^>]*-->")
          // {debate_id:null, debate_status:null, debate_severity:null, debate_level:null})
    | . + {debate_review: (.debate_id != null)};
  def review_marker:
    . + ((.body // "") | capture("<!-- debate-review head=(?<debate_head>[0-9a-f]+)(?: [^>]*?agreed=(?<debate_agreed>[0-9]+) contested=(?<debate_contested>[0-9]+))?[^>]*-->")
          // {debate_head:null, debate_agreed:null, debate_contested:null})
    | .debate_agreed |= (if . == null then null else tonumber end)
    | .debate_contested |= (if . == null then null else tonumber end)
    | . + {debate_review: (.debate_head != null)};
'

# ============================================================ GitHub
harvest_github() {
  local owner="${REPO%%/*}" name="${REPO##*/}"

  local pr_author
  pr_author=$(gh api "repos/$REPO/pulls/$NUMBER" -q '.user.login')

  # --paginate follows pageInfo until exhausted; --slurp wraps the pages in one array.
  local pages
  pages=$(gh api graphql --paginate --slurp -f query='
query($owner:String!,$repo:String!,$pr:Int!,$endCursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$pr){
      headRefOid
      reviewThreads(first:100, after:$endCursor){
        pageInfo{ hasNextPage endCursor }
        nodes{
          id isResolved isOutdated path line originalLine diffSide viewerCanResolve
          first: comments(first:1){ totalCount nodes{ databaseId author{login __typename} body } }
          last:  comments(last:1){ nodes{ author{login} body } }
        }
      }
    }
  }
}' -F owner="$owner" -F repo="$name" -F pr="$NUMBER")

  local head threads reviews
  head=$(jq -r '.[0].data.repository.pullRequest.headRefOid' <<<"$pages")

  threads=$(jq --arg pr_author "$pr_author" "$JQ_MARKERS"'
    [.[].data.repository.pullRequest.reviewThreads.nodes[] | {
        thread_id:     .id,
        reply_to:      .first.nodes[0].databaseId,
        resolved:      .isResolved,
        resolvable:    .viewerCanResolve,
        outdated:      .isOutdated,
        author:        .first.nodes[0].author.login,
        author_bot:    (.first.nodes[0].author.__typename == "Bot"),
        author_is_pr_author: (.first.nodes[0].author.login == $pr_author),
        path:          .path,
        line:          (.line // .originalLine),
        original_line: .originalLine,
        line_side:     .diffSide,
        position_head: null,
        comment_count: .first.totalCount,
        body:          .first.nodes[0].body,
        last_author:   .last.nodes[0].author.login,
        last_body:     .last.nodes[0].body,
        source:        "thread"
      } | thread_marker ]' <<<"$pages")

  # --slurp here too: past one page, bare --paginate emits back-to-back arrays.
  reviews=$(gh api "repos/$REPO/pulls/$NUMBER/reviews" --paginate --slurp \
    | jq "$JQ_MARKERS"'
      [.[][] | {id, author: .user.login, author_bot: (.user.type == "Bot"),
                state, commit_id, submitted_at, body, source: "review"}
       | select(.body != "") | review_marker ]')

  emit "$head" "$pr_author" "$threads" "$reviews" \
    '{"outdated":true,"review_commit_id":true,"author_bot_flag":true}'
}

# ============================================================ GitLab
harvest_gitlab() {
  local pid base mr head pr_author discussions notes threads reviews
  pid=$(jq -rn --arg v "$REPO" '$v|@uri')
  base="projects/$pid/merge_requests/$NUMBER"

  mr=$(glab api "$base" --hostname "$HOST")
  head=$(jq -r '.sha' <<<"$mr")
  pr_author=$(jq -r '.author.username' <<<"$mr")

  discussions=$(glab api "$base/discussions?per_page=100" --hostname "$HOST" --paginate --output ndjson | jq -s '.')
  notes=$(glab api "$base/notes?per_page=100&order_by=created_at&sort=asc" --hostname "$HOST" --paginate --output ndjson | jq -s '.')

  # A real thread: individual_note false, root note not a system note.
  threads=$(jq --arg pr_author "$pr_author" "$JQ_MARKERS"'
    [ .[] | select(.individual_note == false) | select(.notes[0].system != true)
      | .notes[0] as $root | .notes[-1] as $last | {
        thread_id:     .id,
        reply_to:      .id,
        resolved:      ($root.resolved // false),
        resolvable:    ($root.resolvable // false),
        outdated:      null,
        author:        $root.author.username,
        author_bot:    ($root.author.bot // null),
        author_is_pr_author: ($root.author.username == $pr_author),
        path:          ($root.position.new_path // $root.position.old_path // null),
        line:          ($root.position.new_line // $root.position.old_line // null),
        original_line: null,
        line_side:     (if $root.position.new_line != null then "new" elif $root.position.old_line != null then "old" else null end),
        position_head: ($root.position.head_sha // null),
        comment_count: (.notes | length),
        body:          $root.body,
        last_author:   $last.author.username,
        last_body:     $last.body,
        source:        "discussion",
        note_type:     $root.type
      } | thread_marker ]' <<<"$discussions")

  # Top-level bodies: non-system notes without a diff position that are not the root of a thread.
  reviews=$(jq --argjson threads "$threads" --argjson discussions "$discussions" "$JQ_MARKERS"'
    ([ $discussions[] | select(.individual_note == false) | .notes[0].id ]) as $roots
    | [ .[] | select(.system != true) | select(.position == null) | select((.id as $i | $roots | index($i)) == null)
        | {id, author: .author.username, author_bot: (.author.bot // null),
           state: null, commit_id: null, submitted_at: .created_at, body, source: "note"}
        | review_marker ]' <<<"$notes")

  emit "$head" "$pr_author" "$threads" "$reviews" \
    '{"outdated":false,"review_commit_id":false,"author_bot_flag":false}'
}

# ============================================================ output
emit() {
  local head="$1" pr_author="$2" threads="$3" reviews="$4" caps="$5"
  jq -n --arg forge "$FORGE" --arg host "$HOST" --arg repo "$REPO" --arg pr "$NUMBER" \
        --arg head "$head" --arg pr_author "$pr_author" \
        --argjson t "$threads" --argjson r "$reviews" --argjson caps "$caps" \
    '{forge:$forge, host:$host, repo:$repo, pr:($pr|tonumber), head:$head, pr_author:$pr_author,
      capabilities:$caps, threads:$t, reviews:$r,
      unresolved:[$t[]|select(.resolved==false)]|length}'
}

case "$FORGE" in
  github) harvest_github ;;
  gitlab) harvest_gitlab ;;
  *) echo "unknown forge: $FORGE" >&2; exit 2 ;;
esac
