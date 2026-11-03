#!/bin/bash
# Reproducible build of OpenWrt with NSS offload for the Xiaomi Redmi AX3000 (RA81).
#
#   scripts/build.sh [-j N] [--clean] [--profile NAME]... [--overlay DIR]...
#
# Fetches the pinned upstream tree (upstream/openwrt.conf) into $SRC, applies
# patches/*.patch, pins the feeds (upstream/feeds.conf), then builds one image
# per profile (profiles/NAME.packages, default: "default") in the same tree, so
# every profile after the first is an incremental build. Each profile gets
# overlays/common plus any --overlay directories as the image's "files/".
#
# Results: $OUT/<profile>/ (images, manifest, config, versions.json, sha256sums), validated
# with tools/validate-images.sh.
#
# Every image gets configs/base.packages (the OTA updater from feeds/ra81)
# before its profile, and keys/release.pub as the key releases are checked with.
#
# Environment: SRC (default build/openwrt), DL_DIR (default build/dl),
# OUT (default out), VENV (default build/venv-tools), OTA_REPO (GitHub
# owner/name the updater installs releases from; default: from the "origin"
# remote), RELEASE_TAG (the release these images are published as).
set -euo pipefail

# Parse the whole script before running it, so editing it mid-build is safe.
{

TOP=$(cd "$(dirname "$0")/.." && pwd)
SRC=${SRC:-$TOP/build/openwrt}
DL_DIR=${DL_DIR:-$TOP/build/dl}
OUT=${OUT:-$TOP/out}
export VENV=${VENV:-$TOP/build/venv-tools}
JOBS=$(nproc)
CLEAN=
PROFILES=()
OVERLAYS=()

while [ $# -gt 0 ]; do
	case "$1" in
	-j) JOBS=$2; shift ;;
	-j*) JOBS=${1#-j} ;;
	--clean) CLEAN=1 ;;
	--profile) PROFILES+=("$2"); shift ;;
	--overlay) OVERLAYS+=("$(cd "$2" && pwd)"); shift ;;
	*) echo "usage: $0 [-j N] [--clean] [--profile NAME]... [--overlay DIR]..." >&2; exit 2 ;;
	esac
	shift
done
[ ${#PROFILES[@]} -gt 0 ] || PROFILES=(default)
for p in "${PROFILES[@]}"; do
	[ -f "$TOP/profiles/$p.packages" ] || { echo "no such profile: profiles/$p.packages" >&2; exit 2; }
done

# OpenWrt's host tools trip over unusual PATH entries (e.g. the Windows
# directories WSL appends, which contain spaces): drop those, keep the rest
# (some distributions keep host tools such as pod2man outside /usr/bin).
PATH=$(echo "$PATH" | tr ':' '\n' | grep -v -e '^/mnt/' -e ' ' | paste -sd: -)
export PATH=${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}

. "$TOP/upstream/openwrt.conf"
REPO_COMMIT=$(git -C "$TOP" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)
if [ -z "${OTA_REPO+set}" ]; then
	OTA_REPO=$(git -C "$TOP" remote get-url origin 2>/dev/null |
		sed -nE 's#^(https://|git@|ssh://git@)github\.com[:/]([^/]+/[^/]+)$#\2#p' | sed 's/\.git$//')
fi
RELEASE_TAG=${RELEASE_TAG:-}

# --- Source tree --------------------------------------------------------------
if [ ! -d "$SRC/.git" ]; then
	mkdir -p "$SRC"
	git -C "$SRC" init -q
	git -C "$SRC" remote add origin "$OPENWRT_URL"
fi

cd "$SRC"
STAMP=$( (echo "$OPENWRT_URL $OPENWRT_COMMIT"; cat "$TOP"/patches/*.patch "$TOP/upstream/feeds.conf") | sha256sum | cut -d' ' -f1)
if [ "$(cat .ra81-nss-stamp 2>/dev/null)" != "$STAMP" ] || [ -n "$CLEAN" ]; then
	echo ">>> Checking out $OPENWRT_COMMIT and applying patches"
	git fetch -q --depth 1 origin "$OPENWRT_COMMIT"
	git checkout -q -f --detach "$OPENWRT_COMMIT"
	git clean -q -fd -- target package
	git -c user.name=ra81-nss-build -c user.email=ra81-nss-build@localhost \
		am -q --keep-cr "$TOP"/patches/*.patch
	# A patch touches package/kernel/mac80211/ath.mk, which the package
	# metadata cache does not track: drop the cache so defconfig sees it.
	rm -rf tmp/info
	echo "$STAMP" > .ra81-nss-stamp
fi

mkdir -p "$DL_DIR"
[ -e dl ] || ln -s "$DL_DIR" dl

# This repository's own packages, as a local feed
grep -v '^src-link ra81 ' "$TOP/upstream/feeds.conf" > feeds.conf
echo "src-link ra81 $TOP/feeds/ra81" >> feeds.conf

./scripts/feeds update -a
./scripts/feeds install -a

if [ ! -x "$VENV/bin/ubireader_extract_images" ]; then
	python3 -m venv "$VENV"
	"$VENV/bin/pip" install --quiet ubi_reader
fi

# --- One image per profile ------------------------------------------------------
BIN=bin/targets/qualcommax/ipq50xx
for PROFILE in "${PROFILES[@]}"; do
	echo ">>> Profile $PROFILE"

	rm -rf files
	mkdir -p files/etc/ra81-nss
	cp -a "$TOP/overlays/common/." files/
	for o in "${OVERLAYS[@]}"; do cp -a "$o/." files/; done
	[ ! -s "$TOP/keys/release.pub" ] || cp "$TOP/keys/release.pub" files/etc/ra81-nss/release.pub
	cp "$TOP/profiles/$PROFILE.packages" files/etc/ra81-nss/profile.packages
	# The sources of this build, for the updater's "what's new"
	python3 -I "$TOP/scripts/versions.py" components \
		"https://github.com/${OTA_REPO:-unknown/unknown}" "$(git -C "$TOP" rev-parse HEAD 2>/dev/null || echo unknown)" \
		> files/etc/ra81-nss/components.json
	cat > files/etc/ra81-nss/build-info <<-EOF
		PROFILE=$PROFILE
		RELEASE_TAG=$RELEASE_TAG
		OTA_REPO=$OTA_REPO
		REPO_COMMIT=$REPO_COMMIT
		UPSTREAM_RELEASE=${OPENWRT_RELEASE:-}
		UPSTREAM_COMMIT=$OPENWRT_COMMIT
		BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	EOF

	cp "$TOP/configs/ra81-nss.config" .config
	"$TOP/scripts/profile.sh" apply .config "$TOP/configs/base.packages" "$TOP/profiles/$PROFILE.packages"
	make defconfig >/dev/null
	# defconfig drops a symbol it cannot select without a word; here that is an error
	dropped=$(grep -E '^CONFIG_[A-Za-z0-9_-]+=' "$TOP/configs/ra81-nss.config" | while read -r l; do
		grep -qxF "$l" .config || echo "$l"; done)
	[ -z "$dropped" ] || { echo "defconfig dropped from configs/ra81-nss.config:" >&2; echo "$dropped" >&2; exit 1; }
	# The router's package sources (/etc/apk/repositories.d/distfeeds.list)
	# list a feed when its CONFIG_FEED_ is set. Only the feeds OpenWrt
	# publishes exist on downloads.openwrt.org; the others are built into the
	# image, and an unreachable source makes "apk update" fail.
	for f in $(awk '/^src-/ { print $2 }' feeds.conf); do
		case "$f" in packages|luci|routing|telephony|video) continue ;; esac
		sed -i "s/^CONFIG_FEED_$f=y\$/# CONFIG_FEED_$f is not set/" .config
	done
	"$TOP/scripts/profile.sh" check .config "$TOP/configs/base.packages" "$TOP/profiles/$PROFILE.packages"

	rm -f "$BIN"/*xiaomi_redmi-ax3000*
	make -j"$JOBS" download
	make -j"$JOBS" || make -j1 V=s

	dest=$OUT/$PROFILE
	rm -rf "$dest"
	mkdir -p "$dest"
	cp "$BIN"/*xiaomi_redmi-ax3000* "$BIN"/profiles.json "$dest"/
	cp .config "$dest/config.full"
	cp files/etc/ra81-nss/build-info "$dest/build-info"
	python3 -I "$TOP/scripts/versions.py" versions files/etc/ra81-nss/components.json \
		"$BIN"/*xiaomi_redmi-ax3000.manifest "$PROFILE" "$RELEASE_TAG" > "$dest/versions.json"
	(cd "$dest" && sha256sum -- *xiaomi_redmi-ax3000* > sha256sums)

	"$TOP/tools/validate-images.sh" "$dest"
	echo ">>> Images in $dest"
done
exit 0
}
