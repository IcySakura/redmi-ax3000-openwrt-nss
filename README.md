# OpenWrt with NSS offload for the Xiaomi Redmi AX3000 (RA81)

OpenWrt (main, kernel 6.18) with Qualcomm **NSS hardware offload** for the
Xiaomi **Redmi AX3000, model RA81**: wired forwarding, connection acceleration
(ECM) and both Wi-Fi radios run in the IPQ5000's NSS core instead of on the two
Cortex-A53 cores.

This repository is a build recipe, not a copy of OpenWrt: it pins an upstream
tree, adds the RA81 board as two patches, and builds signed images with GitHub
Actions (or locally). The NSS work itself is upstream, in
[kuncy7/openwrt-nss-edma](https://github.com/kuncy7/openwrt-nss-edma) - see
[Credits](#credits).

> [!WARNING]
> Experimental firmware for **one model only: RA81** (the model number is on the
> label underneath). It is not for the Redmi AX3000T, the Xiaomi CR880x, or any
> other "AX3000" router. Back up your flash (especially `0:ART`) before
> installing. You flash it at your own risk.

## Status

| Area | State |
|---|---|
| Boot from the stock Xiaomi U-Boot (bootloader untouched) | ✅ |
| A/B dual boot: `sysupgrade` writes the other slot, unconfirmed boots roll back by themselves | ✅ tested on hardware |
| NSS wired plane + ECM (`dsa` topology, QCA8337 on CPU port 6) | ✅ |
| Wi-Fi 2.4 GHz and 5 GHz (up to 160 MHz) on the NSS data path | ✅ |
| Temperature sensors (4 zones, upstream trip points) | ✅ |
| Factory MAC addresses | ✅ |
| WAN port with NSS | ✅ tested |
| LAN1-3 with NSS, buttons, LEDs, PPPoE, VLANs | ⚠️ built in, not tested on an RA81 yet |
| 802.11s mesh offload | ❌ not in the 256 MB profile (mesh on the host path: `mesh` profile) |

Tested on one RA81 unit. Reports from other units are welcome.

## Performance

One RA81 as a bridged access point, one 2x2 Wi-Fi 6E client on 5 GHz at 160 MHz,
TCP to a wired host behind the RA81:

| | Without NSS<sup>1</sup> | With NSS (this build) |
|---|---|---|
| Download (to the client) | 370-430 Mbit/s | **870-890 Mbit/s** |
| Upload (from the client) | 370-430 Mbit/s | **730-850 Mbit/s** |
| RA81 CPU during the transfer | ~50 % (one core pinned in softirq) | **2-5 %** |
| 2.4 GHz, 20 MHz | - | 70-90 Mbit/s at 2-3 % CPU |
| MemAvailable after boot / after sustained load | - | ~60 MiB / ~48 MiB |

<sup>1</sup> OpenWrt 25.12.5 from [lutvzn/RA81OpenWRT](https://github.com/lutvzn/RA81OpenWRT).
Spreading its interrupts over both cores reached ~530 Mbit/s with both cores busy.

With NSS the router is no longer the limit: ~900 Mbit/s is about what a single
1 Gbit/s link carries. Routed traffic between two switch ports shares the one
1 Gbit/s CPU port, so it tops out around 911 Mbit/s however idle the CPU is
(see the upstream README).

## What this build adds to upstream

- **RA81 board support** (`patches/0001`): device tree based on the Xiaomi
  CR8806 in the upstream tree (same IPQ5000 + QCN6102 + QCA8337, 256 MiB), with
  the RA81 specifics from [lutvzn/RA81OpenWRT](https://github.com/lutvzn/RA81OpenWRT):
  QCA8337 CPU port 6 over SGMII (as the vendor firmware wires it), 4 MiB TZ
  region, the RA81 Wi-Fi board data, factory MACs from `0:art`, and the Xiaomi
  dual-boot A/B upgrade with rollback. The NSS bring-up debug options of the
  upstream tree (serial SysRq, unrestricted `/dev/mem`) are dropped.
- **Temperature sensors** (`patches/0002`): enabled. The driver now enables
  TSENS itself on IPQ5018; on the RA81 it reads 48-53 °C from idle to full load
  with no bogus values (measured first with the critical trips disabled).
- **256 MiB tuning**: the low-memory NSS and ath11k profiles of the upstream
  tree, and `vm.min_free_kbytes` 8 MiB instead of OpenWrt's 16 MiB
  (`overlays/common`; ~20 MiB more MemAvailable, no allocation failures under
  load).
- **Package profiles, checked builds and signed releases** (below).

## Images

Every release (and every local build) has one set of images per profile:

| File | Use |
|---|---|
| `*-squashfs-factory.ubi` | first install into a dual-boot slot |
| `*-squashfs-sysupgrade.bin` | upgrade a router already running this firmware |
| `*-initramfs-uImage.itb` | RAM boot from U-Boot over TFTP (needs UART) |

Profiles in this repository: `default` (the base image) and `mesh` (full
`wpad-mesh-mbedtls` for 802.11s with SAE plus `batman-adv`, unconfigured).

A fresh install comes up like any OpenWrt router: `192.168.1.1`, DHCP server on
the LAN, **no root password**, Wi-Fi off. Set a password first. For a bridged
access point, see `overlays/examples/access-point`.

## How booting works

The stock U-Boot (`bootmiwifi`) boots the `kernel` UBI volume from one of two
36 MiB partitions, `rootfs` (slot 0) or `rootfs_1` (slot 1), chosen by `flag_*`
variables in its environment:

- Installs and upgrades always write **the slot that is not running** and set
  `flag_ota_reboot=1`: U-Boot tries the new slot once.
- Early in boot (preinit, before Wi-Fi) the new system sets
  `flag_boot_success=0`; at the end of boot it confirms the slot.
- If the new system never confirms - it hangs or crashes after preinit, or
  is simply rebooted before that - the next boot goes back to the old slot.
- Switch slots by hand: `fw_setenv flag_last_success <0|1>; fw_setenv flag_ota_reboot 0; reboot`.

A kernel that hangs *before* preinit is retried by U-Boot; that needs the
recovery below. The slot logic was taken from a disassembly of the RA81
U-Boot by the RA81OpenWRT project.

## Installing

**Back up every MTD partition first**, above all `0:ART` (Wi-Fi calibration and
MAC addresses, unique to your unit, cannot be recreated):

```sh
ssh root@<router> cat /proc/mtd
for i in $(seq 0 21); do ssh root@<router> "cat /dev/mtd$i" > mtd$i.bin; done
```

### From OpenWrt for the RA81 (this firmware, RA81OpenWRT)

```sh
cat *-squashfs-factory.ubi | ssh root@<router> 'cat > /tmp/f.ubi'
cat scripts/ra81-install-slot.sh | ssh root@<router> 'cat > /tmp/ra81-install-slot.sh'
ssh root@<router> sh /tmp/ra81-install-slot.sh /tmp/f.ubi <sha256>          # dry run
ssh root@<router> sh /tmp/ra81-install-slot.sh --yes --reboot /tmp/f.ubi <sha256>
```

The script checks the model and the running slot, writes only the other slot,
verifies the UBI volumes and arms a one-time trial boot.

### From the stock Xiaomi firmware

Get a root shell first, e.g. with
[XMiR-Patcher](https://github.com/openwrt-xiaomi/xmir-patcher) (it sets the
root password to `root`; the stock `dropbear` needs
`-o HostKeyAlgorithms=+ssh-rsa`). The stock firmware has `ubiformat` and
`nvram` but no `fw_setenv`, so the slot is written by hand:

```sh
cat /proc/cmdline | grep -o 'ubi.mtd=[^ ]*'  # running slot: rootfs = 0, rootfs_1 = 1
cat /proc/mtd                                # find the OTHER slot's mtd number
# copy the factory.ubi to /tmp/f.ubi, compare md5sum with the original, then:
ubiformat /dev/mtdN -f /tmp/f.ubi -y         # N = the slot that is NOT running
nvram set flag_try_sys1_failed=0
nvram set flag_try_sys2_failed=0
nvram set flag_last_success=<running slot>
nvram unset flag_boot_success
nvram set flag_ota_reboot=1
nvram commit
reboot
```

This path was tested from stock 1.0.68 with the non-NSS RA81OpenWRT image,
which was then upgraded to this firmware with `ra81-install-slot.sh`. The stock
firmware stays in the other slot until the next upgrade overwrites it.

## Upgrading

```sh
cd /tmp
# download sysupgrade.bin, sha256sums and sha256sums.sig of a release, then:
usign -V -m sha256sums -p /etc/ra81-nss/release.pub   # signature of the checksums
sha256sum -c sha256sums 2>/dev/null | grep sysupgrade # checksum of the image
sysupgrade <file>-squashfs-sysupgrade.bin
```

Settings are kept. **Packages installed with `apk add` are not**: a sysupgrade
replaces the whole system image. Put everything you want to keep into a
profile (next section), so the image you upgrade to already contains it. The
image records its build in `/etc/ra81-nss/build-info`.

## Profiles: building the packages you use

A profile, `profiles/<name>.packages`, lists packages on top of the base config
(`configs/ra81-nss.config`), one per line; `-name` leaves a package out:

```
-wpad-basic-mbedtls
wpad-mesh-mbedtls
kmod-batman-adv
```

The build **fails** if a listed package does not make it into the image
(unknown name, missing feed, unmet dependency), so an upgrade never drops
software silently.

To turn a running router into a profile:

```sh
scripts/router-packages.sh root@<router> > profiles/my-router.packages
```

It starts from the profile the router's image was built from and adds what
was installed (and `-name` for what was removed) since. Review it before
committing - it lists everything you run.

Packages can come from any feed in `upstream/feeds.conf`. To use a third-party
feed, add it there pinned to a commit (`src-git name https://...^<commit>`) and
list its packages in a profile. Check the feed's licence before publishing
images built with it. Kernel modules always have to come from this build: the
kernel is not an official OpenWrt one, so official kmods do not install.

## Building

### GitHub Actions

*Actions → Build firmware → Run workflow*, with the profiles to build
(default: `default mesh`). One run builds all of them in one tree (~1.5-3 h
for the first profile on a hosted runner, minutes for each further one),
validates them and publishes a pre-release.

Releases are signed when the repository has the secret `USIGN_SECRET_KEY`
(the content of a `usign` secret key file). If you fork this repository,
generate your own key pair and replace `keys/release.pub` and
`overlays/common/etc/ra81-nss/release.pub`:

```sh
usign -G -s release.sec -p release.pub -c "my release key"
```

### Locally

Linux with the [OpenWrt build prerequisites](https://openwrt.org/docs/guide-developer/toolchain/install-buildsystem),
`device-tree-compiler`, `squashfs-tools` and `python3-venv`; ~30 GB of disk.

```sh
scripts/build.sh                                  # profile "default"
scripts/build.sh --profile default --profile mesh # several profiles, one tree
scripts/build.sh --overlay overlays/examples/access-point
scripts/build.sh --clean                          # re-apply the patches from scratch
```

The tree goes to `build/openwrt`, downloads to `build/dl`, the images to
`out/<profile>/`. Each image is checked by `tools/validate-images.sh` (UBI
volumes, FIT, device tree, NSS service, board data, dual-boot scripts).
Under WSL the script uses a Linux-only `PATH`, since OpenWrt's host tools fail
on the Windows directories WSL adds.

## Recovery

1. **Other slot:** power-cycle after a failed boot, or switch slots by hand
   (see *How booting works*).
2. **Stock TFTP recovery** (the bootloader is never modified): hold reset
   while powering on until the system LED blinks; U-Boot then fetches a stock
   firmware image over TFTP. Use Xiaomi's MIWIFIRepairTool or any DHCP + TFTP
   server.
3. **UART** (GPIO 28/29, 115200 8N1): interrupt U-Boot to TFTP-boot the
   initramfs image or write a slot.
4. **Your flash backup**, for `0:ART` above all.

## Known limitations

- **256 MiB of RAM.** The low-memory NSS and Wi-Fi profiles are used: Wi-Fi
  firmware memory mode 2 (at most 8 interfaces and 128 clients per radio),
  smaller RX rings, no NSS mesh offload. Monitor mode is effectively unusable.
- **One 1 Gbit/s CPU port** (QCA8337 port 6): routed traffic between switch
  ports shares it.
- **Snapshot base.** The upstream tree is OpenWrt main (October 2026), not a
  stable release. Userspace packages from the official snapshot feeds may not
  match; build what you need into a profile.
- A harmless boot-time `sysctl` error from `12-nss-networking.conf`
  (`rps_default_mask` written for 4-core SoCs); the value in effect is correct.

## Repository layout

```
upstream/openwrt.conf    pinned upstream tree (URL + commit)
upstream/feeds.conf      pinned feeds; add third-party feeds here
patches/                 RA81 board support on top of the upstream tree
configs/ra81-nss.config  base build configuration (diffconfig)
profiles/                package profiles (*.packages)
overlays/common/         files in every image (memory tuning, release key)
overlays/examples/       optional first-boot examples (bridged access point)
scripts/build.sh         reproducible build of one or more profiles
scripts/profile.sh       profile -> .config, and the post-defconfig check
scripts/router-packages.sh  profile from a running router
scripts/ra81-install-slot.sh  installer for the inactive slot (runs on the router)
tools/validate-images.sh static checks of the images
keys/release.pub         public key the releases are signed with
.github/workflows/       GitHub Actions build and release
```

## Credits

This build stands on the work of others. Nothing from their repositories is
vendored here except what is listed; the build fetches the rest.

- **[OpenWrt](https://openwrt.org)** - the operating system, the
  `qualcommax/ipq50xx` target and the build system.
- **[kuncy7/openwrt-nss-edma](https://github.com/kuncy7/openwrt-nss-edma)** and
  **[kuncy7/nss-packages](https://github.com/kuncy7/nss-packages)** - NSS offload
  for IPQ5018 on kernel 6.18 with the upstream `stmmac` and DSA drivers: the
  tree this build is pinned to, the NSS packages, the 256 MiB tuning, and the
  Xiaomi CR8806 board the RA81 device tree is based on. That work builds in
  turn on [Julius Bairaktaris](https://github.com/JuliusBairaktaris)'
  `nss-edma-rework`, [George Moussalem](https://github.com/georgemoussalem)'s
  ipq50xx target, `stmmac`/uniphy conversion and the IPQ5018 TSENS fix,
  [ADCDS](https://github.com/ADCDS/openwrt-xiaomi-ax3000t-rd03v2)' first NSS on
  IPQ5018, [qosmio](https://github.com/qosmio/openwrt-ipq)'s packaging and
  firmware tarballs, and the 256 MiB ath11k work of Georg Seema and fanha99,
  measured on a CR8806. See the upstream README for the full acknowledgements.
- **[lutvzn/RA81OpenWRT](https://github.com/lutvzn/RA81OpenWRT)** - RA81
  support for OpenWrt 25.12: the hardware inventory, the analysis of the RA81
  U-Boot slot logic, the dual-boot scripts (`xiaomi-dualboot`, in patch 0001),
  the repacked Wi-Fi board data, `scripts/ra81-install-slot.sh` and the
  original `tools/validate-images.sh`.
- **[hzyitc/openwrt-redmi-ax3000](https://github.com/hzyitc/openwrt-redmi-ax3000)** -
  the original Redmi AX3000 port and the source of the Wi-Fi board data
  payloads.
- **[kmiit/Redmi_AX3000_immortalwrt](https://github.com/kmiit/Redmi_AX3000_immortalwrt)** -
  ImmortalWrt port of the RA81, used by RA81OpenWRT as a reference.
- **[openwrt-xiaomi/xmir-patcher](https://github.com/openwrt-xiaomi/xmir-patcher)** -
  root access on the stock firmware.
- **Qualcomm / Xiaomi** - the NSS and ath11k firmware (fetched by the build) and
  the Wi-Fi board data (inside patch 0001), proprietary data redistributed for
  interoperability as OpenWrt does for other devices.

## License

GPL-2.0 (see `LICENSE`), the license of OpenWrt; files keep the license in
their own SPDX header where they have one (the device tree is
`GPL-2.0-or-later OR MIT`). The Wi-Fi board data and the firmware fetched by
the build are proprietary Qualcomm/Xiaomi data, not covered by this license.
