#!/bin/sh
# Package profiles (profiles/*.packages) -> OpenWrt .config, and the check
# that every requested package made it through "make defconfig".
#
#   scripts/profile.sh apply CONFIG PACKAGES_FILE...   append the selections to CONFIG
#   scripts/profile.sh check CONFIG PACKAGES_FILE...   verify an expanded CONFIG
#
# Format: one package per line; "-name" leaves a package out; "#" starts a
# comment. With several files (configs/base.packages, then a profile), the
# last mention of a package wins, so a profile can drop a base package.
set -eu

cmd=$1 config=$2
shift 2

entries() {
	sed -e 's/#.*//' -e 's/[[:space:]]//g' "$@" | grep -v '^$' | awk '
		{ n = $0; sub(/^-/, "", n); if (!(n in last)) order[++c] = n; last[n] = $0 }
		END { for (i = 1; i <= c; i++) print last[order[i]] }'
}

case "$cmd" in
apply)
	echo "# packages: $*" >> "$config"
	entries "$@" | while read -r p; do
		case "$p" in
		-*) echo "# CONFIG_PACKAGE_${p#-} is not set" ;;
		*) echo "CONFIG_PACKAGE_$p=y" ;;
		esac
	done >> "$config"
	;;
check)
	bad=0
	for p in $(entries "$@"); do
		case "$p" in
		-*)
			if grep -q "^CONFIG_PACKAGE_${p#-}=[ym]$" "$config"; then
				echo "profile: ${p#-} is still selected (something else depends on it)" >&2
				bad=1
			fi
			;;
		*)
			if ! grep -q "^CONFIG_PACKAGE_$p=y$" "$config"; then
				echo "profile: $p is not in the image (unknown name, feed missing from upstream/feeds.conf, or unmet dependency)" >&2
				bad=1
			fi
			;;
		esac
	done
	[ $bad = 0 ] && echo "packages: all $(entries "$@" | wc -l) entries applied"
	exit $bad
	;;
*)
	echo "usage: $0 apply|check CONFIG PACKAGES_FILE..." >&2
	exit 2
	;;
esac
