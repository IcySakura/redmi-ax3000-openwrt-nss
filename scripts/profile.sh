#!/bin/sh
# Package profiles (profiles/*.packages) -> OpenWrt .config, and the check
# that every requested package made it through "make defconfig".
#
#   scripts/profile.sh apply PROFILE_FILE CONFIG   append the selections to CONFIG
#   scripts/profile.sh check PROFILE_FILE CONFIG   verify an expanded CONFIG
#
# Profile format: one package per line; "-name" leaves a package out;
# "#" starts a comment.
set -eu

cmd=$1 profile=$2 config=$3

entries() {
	sed -e 's/#.*//' -e 's/[[:space:]]//g' "$profile" | grep -v '^$' || true
}

case "$cmd" in
apply)
	echo "# profile: $(basename "$profile" .packages)" >> "$config"
	entries | while read -r p; do
		case "$p" in
		-*) echo "# CONFIG_PACKAGE_${p#-} is not set" ;;
		*) echo "CONFIG_PACKAGE_$p=y" ;;
		esac
	done >> "$config"
	;;
check)
	bad=0
	for p in $(entries); do
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
	[ $bad = 0 ] && echo "profile $(basename "$profile" .packages): all $(entries | wc -l) entries applied"
	exit $bad
	;;
*)
	echo "usage: $0 apply|check PROFILE_FILE CONFIG" >&2
	exit 2
	;;
esac
