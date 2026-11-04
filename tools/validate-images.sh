#!/bin/bash
# Static validation of the RA81 NSS build outputs.
#   tools/validate-images.sh BIN_DIR
# Needs: dtc, unsquashfs, strings, and a Python venv with ubi_reader
# (VENV, default build/venv-tools; scripts/build.sh creates it).
#
# Adapted from tools/validate-images.sh of lutvzn/RA81OpenWRT (GPL-2.0),
# updated for the kernel 6.18 memory layout and the NSS plane.
set -uo pipefail

TOP=$(cd "$(dirname "$0")/.." && pwd)
BIN=${1:?usage: $0 BIN_DIR}
VENV=${VENV:-$TOP/build/venv-tools}/bin
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

fail=0
ok()   { echo "  OK   $*"; }
bad()  { echo "  FAIL $*"; fail=1; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

FACTORY=$(ls "$BIN"/*xiaomi_redmi-ax3000-squashfs-factory.ubi 2>/dev/null | head -1)
SYSUPG=$(ls "$BIN"/*xiaomi_redmi-ax3000-squashfs-sysupgrade.bin 2>/dev/null | head -1)
INITRD=$(ls "$BIN"/*xiaomi_redmi-ax3000-initramfs-uImage.itb 2>/dev/null | head -1)

echo "== Files"
for f in "$FACTORY" "$SYSUPG" "$INITRD"; do
	check "present: $(basename "${f:-missing}")" "[ -s '${f:-/nonexistent}' ]"
done
[ -s "$FACTORY" ] || exit 1

SLOT=$((0x2400000))
fsize=$(stat -c%s "$FACTORY")
check "factory.ubi ($fsize B) fits a 36 MiB slot" "[ $fsize -le $SLOT ]"
check "factory.ubi starts with UBI#" "[ \"\$(head -c4 '$FACTORY')\" = 'UBI#' ]"

echo "== UBI volumes"
"$VENV"/ubireader_display_info "$FACTORY" > "$WORK/ubi.txt" 2>&1
vols=$(sed -n "s/^\s*Volume Name:\s*//p" "$WORK/ubi.txt" | tr '\n' ' ')
echo "  volumes: $vols"
check "volume order kernel,rootfs,rootfs_data" "[ \"$vols\" = 'kernel rootfs rootfs_data ' ]"
"$VENV"/ubireader_extract_images -o "$WORK/ubi" "$FACTORY" >/dev/null 2>&1
KVOL=$(ls "$WORK"/ubi/*/*vol-kernel.ubifs)
RVOL=$(ls "$WORK"/ubi/*/*vol-rootfs.ubifs)
check "rootfs volume is squashfs" "[ \"\$(head -c4 '$RVOL')\" = 'hsqs' ]"

echo "== FIT (kernel volume)"
dtc -I dtb -O dts -o "$WORK/fit.dts" "$KVOL" 2>/dev/null
check "FIT default config is config@mp02.1" "grep -q 'default = \"config@mp02.1\"' '$WORK/fit.dts'"
check "FIT kernel arch arm64" "grep -q 'arch = \"arm64\"' '$WORK/fit.dts'"

echo "== DTB inside FIT"
"$VENV"/python -I - "$KVOL" "$WORK/board.dtb" <<'EOF'
import sys, struct
# Extract the first fdt image's data from the FIT via a minimal FDT walk.
d = open(sys.argv[1], 'rb').read()
magic, totalsize, off_struct, off_strings = struct.unpack_from('>IIII', d, 0)
p, path, strings = off_struct, [], d[off_strings:]
while True:
    tok, = struct.unpack_from('>I', d, p); p += 4
    if tok == 1:
        e = d.index(b'\0', p); path.append(d[p:e].decode()); p = (e + 4) & ~3
    elif tok == 2:
        path.pop()
    elif tok == 3:
        ln, no = struct.unpack_from('>II', d, p); p += 8
        name = strings[no:strings.index(b'\0', no)].decode()
        if name == 'data' and len(path) >= 2 and path[-2] == 'images' and path[-1].startswith('fdt'):
            open(sys.argv[2], 'wb').write(d[p:p+ln]); break
        p = (p + ln + 3) & ~3
    elif tok == 9:
        sys.exit("no fdt image found")
EOF
D=$WORK/board.dts
dtc -I dtb -O dts -o "$D" "$WORK/board.dtb" 2>/dev/null
check "model Xiaomi Redmi AX3000" "grep -q 'model = \"Xiaomi Redmi AX3000\"' '$D'"
# dtc < 1.8 prints string lists as "a\0b" rather than "a", "b"
check "compatible xiaomi,redmi-ax3000" "grep -Eq 'compatible = \"xiaomi,redmi-ax3000(\"|\\\\0)' '$D'"
check "bootargs-append root=/dev/ubiblock0_1" "grep -q 'bootargs-append = \" root=/dev/ubiblock0_1' '$D'"
check "smem partitions with 0:art node" "grep -q 'label = \"0:art\"' '$D'"
check "NAND ECC strength 8" "grep -q 'nand-ecc-strength = <0x08>' '$D'"
check "tz reserved 4 MiB" "grep -A1 'tz@4ac00000' '$D' | grep -q '0x4ac00000 0x00 0x400000'"
check "wcss/q6 regions 0x4b000000-0x4e000000" "grep -q 'wcss@4b000000' '$D' && grep -q 'q6-region-ipq5018@4c400000' '$D' && grep -q 'q6-region-qcn6122-1@4d200000' '$D' && grep -q 'm3-dump-qcn6122-1@4df00000' '$D'"
check "NSS heap 8 MiB (256 MiB board)" "grep -A1 'memory@40000000' '$D' | grep -q '0x40000000 0x00 0x800000'"
check "NSS core node present" "grep -q 'nss@' '$D'"
check "tsens enabled" "awk '/thermal-sensor@4a9000/,/};/' '$D' | grep -q 'status = \"okay\"'"
check "4 critical thermal trips" "[ \$(grep -c 'type = \"critical\"' '$D') -eq 4 ]"
check "wifi calibration variant (x2)" "[ \$(grep -c 'qcom,ath11k-calibration-variant = \"Xiaomi-Redmi-AX3000\"' '$D') -eq 2 ]"
check "ath11k fw memory mode 2 (x2)" "[ \$(grep -c 'qcom,ath11k-fw-memory-mode = <0x02>' '$D') -eq 2 ]"
check "qca8337 cpu port 6 sgmii" "awk '/ethernet-switch@17/,0' '$D' | grep -A3 'ethernet-port@6' | grep -q 'sgmii'"

echo "== rootfs contents"
unsquashfs -q -d "$WORK/root" "$RVOL" >/dev/null 2>&1
R=$WORK/root
for f in lib/firmware/ath11k/IPQ5018/hw1.0/board-2.bin lib/firmware/ath11k/QCN6122/hw1.0/board-2.bin \
	lib/firmware/ath11k/IPQ5018/hw1.0/q6_fw.mdt lib/firmware/qca-nss0-retail.bin \
	lib/functions/xiaomi-dualboot.sh lib/upgrade/xiaomi-dualboot.sh lib/preinit/81_xiaomi_dualboot \
	usr/sbin/fw_printenv usr/sbin/fw_setenv etc/sysctl.d/90-ra81-memory.conf etc/ra81-nss/build-info; do
	check "has /$f" "[ -e '$R/$f' ]"
done
for b in IPQ5018 QCN6122; do
	check "board-2.bin ($b) keyed for the RA81" "grep -aq 'variant=Xiaomi-Redmi-AX3000' '$R/lib/firmware/ath11k/$b/hw1.0/board-2.bin'"
done
check "xiaomi-dualboot init enabled" "ls '$R'/etc/rc.d/ | grep -q 'S99xiaomi-dualboot'"
check "nss service enabled (S19nss)" "ls '$R'/etc/rc.d/ | grep -q '^S19nss$'"
check "no ath11k autoload (the nss service loads it after the arm)" "! ls '$R'/etc/modules.d/ | grep -q ath11k"
check "ECM carries the DSA patch" "grep -aq dsa_port_from_netdev '$R'/lib/modules/*/ecm.ko"
check "no USB kmods" "! ls '$R'/lib/modules/*/ 2>/dev/null | grep -q dwc3"
check "kmod-ath11k-ahb present" "ls '$R'/lib/modules/*/ | grep -q '^ath11k_ahb.ko'"
for s in etc/init.d/xiaomi-dualboot lib/functions/xiaomi-dualboot.sh lib/upgrade/xiaomi-dualboot.sh lib/upgrade/platform.sh lib/preinit/81_xiaomi_dualboot; do
	check "sh -n /$s" "sh -n '$R/$s'"
done

check "dual-boot confirmation can be held" "grep -q xiaomi-dualboot.hold '$R/etc/init.d/xiaomi-dualboot'"
if [ -e "$R/usr/sbin/ra81-ota" ]; then
	check "sh -n /usr/sbin/ra81-ota" "sh -n '$R/usr/sbin/ra81-ota'"
	check "ra81-ota init enabled (S98, before the S99 confirmation)" "ls '$R'/etc/rc.d/ | grep -q '^S98ra81-ota$'"
	check "LuCI view for ra81-ota" "[ -e '$R/www/luci-static/resources/view/ra81-ota.js' ]"
	check "release key for ra81-ota" "[ -s '$R/etc/ra81-nss/release.pub' ]"
	check "ra81-ota what's new: details.uc, components.json, history kept" "[ -s '$R/usr/share/ra81-ota/details.uc' ] && [ -s '$R/etc/ra81-nss/components.json' ] && grep -q '/etc/ra81-ota/' '$R/lib/upgrade/keep.d/ra81-ota'"
	grep -q '^OTA_REPO=.' "$R/etc/ra81-nss/build-info" ||
		echo "  NOTE no OTA_REPO in build-info: set ra81-ota.main.repo on the router"
fi

check "default theme switch (uci-defaults/29- and 99-default-theme)" "[ -x '$R/etc/uci-defaults/29-default-theme' ] && [ -x '$R/etc/uci-defaults/99-default-theme' ]"
# Package sources must all exist on downloads.openwrt.org (apk update fails otherwise)
check "package sources: only feeds OpenWrt publishes" "! grep -E '^https?://' '$R/etc/apk/repositories.d/distfeeds.list' | grep -vqE '/(targets/[^/]+/[^/]+/packages|packages/[^/]+/(base|packages|luci|routing|telephony|video))/packages\\.adb\$'"

echo "== sysupgrade.bin"
if [ -s "$SYSUPG" ]; then
	tar tf "$SYSUPG" > "$WORK/tar.txt" 2>/dev/null
	check "tar has sysupgrade-xiaomi_redmi-ax3000/{kernel,root}" "grep -q 'sysupgrade-xiaomi_redmi-ax3000/kernel' '$WORK/tar.txt' && grep -q 'sysupgrade-xiaomi_redmi-ax3000/root' '$WORK/tar.txt'"
	check "metadata lists redmi,ax3000 + xiaomi,redmi-ax3000" "strings '$SYSUPG' | tail -c 2000 | grep -q 'redmi,ax3000' && strings '$SYSUPG' | tail -c 2000 | grep -q 'xiaomi,redmi-ax3000'"
fi

echo
[ $fail = 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
exit $fail
