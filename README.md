# OpenWrt with NSS offload for the Xiaomi Redmi AX3000 (RA81)

OpenWrt (main, kernel 6.18) with Qualcomm **NSS hardware offload** for the
Xiaomi **Redmi AX3000, model RA81**: wired forwarding, connection acceleration
(ECM) and both Wi-Fi radios run in the IPQ5000's NSS core instead of on the two
Cortex-A53 cores.

This repository is a build recipe, not a copy of OpenWrt: it pins an upstream
tree, adds the RA81 board as patches, and builds signed images with GitHub
Actions (or locally) that can update themselves from its releases. The NSS work itself is upstream, in
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
| Firmware updates from LuCI: signed releases, trial boot with keep / roll back | ✅ tested on hardware |
| NSS wired plane + ECM (`dsa` topology, QCA8337 on CPU port 6) | ✅ |
| Wi-Fi 2.4 GHz and 5 GHz (up to 160 MHz) on the NSS data path | ✅ |
| Temperature sensors (4 zones, upstream trip points) | ✅ |
| Factory MAC addresses | ✅ |
| WAN port with NSS | ✅ tested |
| Reset and mesh buttons (mesh = WPS) | ✅ |
| Wired clients (LAN1, bridged access point: 936 Mbit/s, CPU idle) | ✅ |
| Fast roaming (802.11r/k/v) with another OpenWrt access point | ✅ configured |
| LAN2/LAN3, LEDs, PPPoE, VLANs | ⚠️ built in, not tested on an RA81 yet |
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
- **Firmware updates** (`feeds/ra81/`, `patches/0003`): *System → Firmware
  Update* in LuCI installs this repository's signed releases into the other
  slot, on trial (see [Firmware updates](#firmware-updates)). Optional.
- **Package profiles, checked builds and signed releases** (below).

## Images

Every release (and every local build) has one set of images per profile:

| File | Use |
|---|---|
| `*-squashfs-factory.ubi` | first install into a dual-boot slot |
| `*-squashfs-sysupgrade.bin` | upgrade a router already running this firmware |
| `*-initramfs-uImage.itb` | RAM boot from U-Boot over TFTP (needs UART) |

Profiles in this repository: `default` (the base image) and `mesh` (full
`wpad-mesh-mbedtls` for 802.11s with SAE plus `batman-adv`, unconfigured); see
[Packages](#packages) for what they contain and how to build your own.

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
  `flag_boot_success=0`; at the end of boot it confirms the slot - unless
  `/var/run/xiaomi-dualboot.hold` exists, which the firmware updater uses to
  keep a new firmware on trial until it is accepted.
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

Settings are kept. **Packages installed with `apk add` are not**: an upgrade
replaces the whole system image. Put everything you want to keep into a
profile ([below](#packages)), so the image you
upgrade to already contains it. The image records its build in
`/etc/ra81-nss/build-info`.

- **In LuCI:** *System → Firmware Update* → *Show releases* → *Install*
  (see [Firmware updates](#firmware-updates)).
- **On the command line:** `ra81-ota check`, then `ra81-ota upgrade`.
- **By hand**, e.g. with an image built without the updater: use the
  `*-<profile>-squashfs-sysupgrade.bin` of the profile you run, in LuCI's
  *System → Backup / Flash Firmware* (compare the SHA256 it shows with the
  release's `sha256sums`), or:

  ```sh
  cd /tmp
  # download sysupgrade.bin, sha256sums and sha256sums.sig of a release, then:
  usign -V -m sha256sums -p /etc/ra81-nss/release.pub   # signature of the checksums
  sha256sum -c sha256sums 2>/dev/null | grep sysupgrade # checksum of the image
  sysupgrade <file>-squashfs-sysupgrade.bin
  ```

  A manual upgrade is confirmed as soon as it finishes booting: it only rolls
  back by itself if it does not get that far.

## Firmware updates

The images include `ra81-ota` (command line) and `luci-app-ra81-ota`
(*System → Firmware Update*). They update the router from the GitHub releases
of the repository that built its image:

1. **Show releases** lists the releases on the router's channel (below),
   newest first, marked newer or older than the installed firmware. Each has
   an image for the profile the router was built with (`PROFILE` in
   `/etc/ra81-nss/build-info`).
2. **Install** on any of them - the newest, or an older one to go back to -
   downloads it, verifies the release's `sha256sums` against the
   `usign` key in the image (`/etc/ra81-nss/release.pub`) and the image against
   `sha256sums`, and writes it to the other slot. Unsigned releases are refused.
3. The router reboots into the new firmware **on trial**. *System → Firmware
   Update* then offers **Keep this firmware** and **Roll back**. If you choose
   neither within the trial period (10 minutes by default), the firmware is
   kept if the LAN is up and the default gateway (or a host you set) answers,
   and rolled back otherwise. If it does not boot far enough to decide, the
   next reboot rolls it back. The previous firmware stays in its slot either
   way.

Settings (in LuCI, or `/etc/config/ra81-ota`): release repository, channel,
trial period, what happens when it ends, health-check host, signing key.

**Channels.** Releases are normally published as GitHub pre-releases, the **testing**
channel. A release that has run well is promoted to **stable** by unmarking
*Set as a pre-release* on its GitHub page. Routers on *stable* (the default)
are offered only promoted releases; routers on *testing* are offered all of
them.

**Going back.** Installing an older release keeps your current settings,
which may contain options the older firmware does not know. That is usually
harmless with these snapshot builds, but not guaranteed.

On the command line: `ra81-ota list`, `ra81-ota check`, `ra81-ota upgrade
[TAG]`, `ra81-ota confirm`, `ra81-ota rollback`.

The updater only knows what is in the release: a release built from a fork
without your packages installs without them. Keep your packages in a profile.

### Using your own fork, or no updater

The updater is not tied to this repository:

- **Your fork's releases:** a fork's GitHub Actions builds point the updater at
  the fork (`OTA_REPO` in `build-info` is set from the repository that ran the
  build) and embed the fork's `keys/release.pub`. Generate your own key pair
  and secret (see [GitHub Actions](#github-actions)); that is all.
- **Another source for a running router:** set the release repository (and,
  if it signs with another key, the key file) in *System → Firmware Update*.
- **No updater at all:** add these lines to your profile and the images are
  built without it (and without the LuCI page):

  ```
  -luci-app-ra81-ota
  -ra81-ota
  ```

  To drop it from every profile, delete both lines from
  `configs/base.packages`. The dual-boot hold in `patches/0003` does nothing
  without the updater.

## Packages

### What the images contain

Every image is built from three layers:

| Layer | File | Contents |
|---|---|---|
| Base | `configs/ra81-nss.config` | OpenWrt with LuCI, the NSS offload stack (NSS firmware and drivers, ECM, ath11k with NSS offload, PPPoE acceleration) and the RA81 board support |
| Every profile | `configs/base.packages` | `ra81-ota`, `luci-app-ra81-ota` (the [firmware updater](#firmware-updates)) |
| One profile | `profiles/<name>.packages` | what that profile adds or leaves out |

The profiles in this repository:

| Profile | Adds | Leaves out |
|---|---|---|
| `default` | nothing | nothing |
| `mesh` | `wpad-mesh-mbedtls` (802.11s with SAE, plus 802.11r/k/v), `kmod-batman-adv`, `batctl-default`, `luci-app-usteer` (client steering between bands and access points) | `wpad-basic-mbedtls` |

The complete package list of an image is in its release as
`*-<profile>.manifest`, and on a running router in `apk list --installed`.
The router also keeps the profile it was built from in
`/etc/ra81-nss/profile.packages`.

### Adding or removing packages

Packages installed on the router with `apk add` last only until the next
upgrade, which replaces the whole system image, and kernel modules cannot be
installed that way at all (the kernel is not an official OpenWrt one). To keep
a package, build it into your images:

1. Fork this repository (or work in your copy).
2. Edit a profile, or copy `profiles/default.packages` to
   `profiles/<your-name>.packages`. One package per line, `#` starts a
   comment:

   ```
   # add a package
   luci-app-sqm
   # leave out a package the base or another layer includes
   -wpad-basic-mbedtls
   ```

   Package names are those of the OpenWrt feeds: search them with `apk search`
   on a router, in [the OpenWrt package table](https://openwrt.org/packages/start),
   or with `make menuconfig` in `build/openwrt` after a local build.
   Dependencies are added automatically. Build options of a package go in the
   same way when its Kconfig names them `PACKAGE_<package>_<option>`
   (`<package>_<option>` turns one on, `-<package>_<option>` off).
3. Build: push and run *Actions → Build firmware* with your profile in
   **profiles**, or locally `scripts/build.sh --profile <your-name>`.
4. Install the new release on the router (*System → Firmware Update*).

The build **fails** if a listed package does not make it into the image
(unknown name, missing feed, unmet dependency), so an upgrade never drops
software silently.

To turn what a running router has into a profile:

```sh
scripts/router-packages.sh root@<router> > profiles/my-router.packages
```

It starts from the profile the router's image was built from and adds what
was installed (and `-name` for what was removed) since. Review it before
committing - it lists everything you run.

### Packages from other feeds

Packages can come from any feed in `upstream/feeds.conf`. To use a
third-party feed, add it there pinned to a commit, then list its packages in a
profile:

```
src-git myfeed https://github.com/<owner>/<repo>.git^<commit>
```

`scripts/bump-upstream.sh` (and with it the automatic builds) only moves the
feeds of the upstream tree; move the pin of your own feeds by hand. Check a
feed's licence before publishing images built with it.

### Your own packages

`feeds/ra81/` is a feed of this repository's own packages (the firmware
updater). Add a directory there with an OpenWrt package `Makefile` (and its
files) and list the package in a profile; `scripts/build.sh` makes the feed
available to every build.

## Building

### GitHub Actions

*Actions → Build firmware → Run workflow* builds the profiles you name
(default: `default mesh`) in one tree (~1 h on a hosted runner), validates
them and publishes a release:

- **upstream:** `pinned` builds `upstream/` as committed; `latest` first moves
  it to the newest release of the upstream tree.
- **publish:** `testing` (a pre-release), `stable`, or `none` (images only
  as a workflow artifact).

**Automatic builds.** Every day the workflow checks whether the upstream tree
has published a new release (`kuncy7/openwrt-nss-edma`, `ipq50xx-*`: a tested
commit plus the feed revisions it was built with). If it has, it moves
`upstream/` to it (`scripts/bump-upstream.sh`), builds and validates both
profiles, publishes them on the **testing** channel and commits the new pins.
If upstream breaks the build or the patches no longer apply, nothing is
published and the failed run notifies you. Nothing is ever installed
automatically: routers only update when you choose a release. (GitHub pauses
scheduled workflows in repositories without activity for 60 days; the commits
of the automatic builds count as activity.)

Releases are signed when the repository has the secret `USIGN_SECRET_KEY`
(the content of a `usign` secret key file, both lines). If you fork this
repository, generate your own key pair, replace `keys/release.pub` (the
images get it as `/etc/ra81-nss/release.pub`) and store `release.sec` as the
secret - never commit it:

```sh
usign -G -s release.sec -p release.pub -c "my release key"
```

A router running this repository's images only accepts releases signed with
this repository's key. To move one to your fork's releases, set the fork as
its release repository and install your key in *System → Firmware Update*, or
flash one of your images by hand once.

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
`out/<profile>/`. The updater in local images uses the GitHub repository of
the `origin` remote (override with `OTA_REPO=owner/name`, or `OTA_REPO=` for
none). Each image is checked by `tools/validate-images.sh` (UBI
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
upstream/openwrt.conf    pinned upstream tree (URL, commit, upstream release)
upstream/feeds.conf      pinned feeds; add third-party feeds here
patches/                 RA81 board support on top of the upstream tree
configs/ra81-nss.config  base build configuration (diffconfig)
configs/base.packages    packages in every profile (the firmware updater)
profiles/                package profiles (*.packages)
feeds/ra81/              this repository's packages: ra81-ota, luci-app-ra81-ota
overlays/common/         files in every image (memory tuning)
overlays/examples/       optional first-boot examples (bridged access point)
scripts/build.sh         reproducible build of one or more profiles
scripts/bump-upstream.sh move upstream/ to a release of the upstream tree
scripts/profile.sh       profile -> .config, and the post-defconfig check
scripts/router-packages.sh  profile from a running router
scripts/ra81-install-slot.sh  installer for the inactive slot (runs on the router)
tools/validate-images.sh static checks of the images
keys/release.pub         public key the releases are signed with (also in the images)
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
