#!/bin/bash
# Move the pins in upstream/ to a release of the upstream tree.
#
#   scripts/bump-upstream.sh [TAG]
#
# The upstream tree publishes tested builds as GitHub releases named
# "$OPENWRT_RELEASE_PREFIX<date>" (target commit + feeds-256m.buildinfo, the
# feed revisions its 256 MiB images were built with). Without TAG, the newest
# such release is used. upstream/openwrt.conf gets its commit, and every feed
# of upstream/feeds.conf that the release lists gets the release's revision;
# other feeds (your third-party ones) are left alone.
#
# Prints what changed; exits 0 with no change when already on that release.
# In GitHub Actions it also sets the outputs "changed" and "release".
set -euo pipefail

TOP=$(cd "$(dirname "$0")/.." && pwd)
CONF=$TOP/upstream/openwrt.conf
FEEDS=$TOP/upstream/feeds.conf
. "$CONF"

repo=$(echo "$OPENWRT_URL" | sed -nE 's#^https://github\.com/([^/]+/[^/]+)$#\1#p' | sed 's/\.git$//')
[ -n "$repo" ] || { echo "OPENWRT_URL is not a GitHub repository" >&2; exit 1; }
tag=${1:-}
api() { curl -fsSL ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} "https://api.github.com/repos/$repo/$1"; }

if [ -z "$tag" ]; then
	tag=$(api "releases?per_page=30" | python3 -I -c '
import json, sys
prefix = sys.argv[1]
for r in json.load(sys.stdin):
    if not r["draft"] and r["tag_name"].startswith(prefix):
        print(r["tag_name"]); break
' "$OPENWRT_RELEASE_PREFIX")
	[ -n "$tag" ] || { echo "no $OPENWRT_RELEASE_PREFIX* release in $repo" >&2; exit 1; }
fi

commit=$(api "releases/tags/$tag" | python3 -I -c 'import json, sys; print(json.load(sys.stdin)["target_commitish"])')
# target_commitish may be a branch name: resolve it to the commit
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || commit=$(api "commits/$commit" | python3 -I -c 'import json, sys; print(json.load(sys.stdin)["sha"])')
buildinfo=$(curl -fsSL "https://github.com/$repo/releases/download/$tag/feeds-256m.buildinfo")

old_commit=$OPENWRT_COMMIT
old_feeds=$(cat "$FEEDS")

sed -i -e "s/^OPENWRT_COMMIT=.*/OPENWRT_COMMIT=$commit/" -e "s/^OPENWRT_RELEASE=.*/OPENWRT_RELEASE=$tag/" "$CONF"

new_feeds=$(echo "$buildinfo" | awk -v feeds="$FEEDS" '
	$1 ~ /^src-/ { line[$2] = $0 }
	END {
		while ((getline l < feeds) > 0) {
			split(l, f, /[ \t]+/)
			if (f[1] ~ /^src-/ && (f[2] in line)) { print line[f[2]]; done[f[2]] = 1 }
			else print l
		}
		for (n in line) if (!(n in done)) print line[n]
	}')
printf '%s\n' "$new_feeds" > "$FEEDS"

changed=false
if [ "$old_commit" != "$commit" ] || [ "$old_feeds" != "$new_feeds" ]; then
	changed=true
	echo "Upstream: $tag ($commit)"
	[ "$old_commit" = "$commit" ] ||
		echo "Tree: https://github.com/$repo/compare/${old_commit:0:12}...${commit:0:12}"
	diff <(echo "$old_feeds" | grep '^src-') <(echo "$new_feeds" | grep '^src-') | sed -n 's/^> /Feed: /p' || true
else
	echo "Already on $tag"
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
	echo "changed=$changed" >> "$GITHUB_OUTPUT"
	echo "release=$tag" >> "$GITHUB_OUTPUT"
fi
