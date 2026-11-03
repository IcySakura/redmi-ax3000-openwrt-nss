#!/usr/bin/env python3
"""Version information of a build, and release notes from two of them.

  versions.py components REPO_URL REPO_COMMIT [--third-party FILE]
      The sources of the build (this repository, the OpenWrt tree from
      upstream/openwrt.conf, the feeds of upstream/feeds.conf and the sources
      of upstream/third-party.conf) as JSON. Goes into the image, so the
      router knows what it runs.

  versions.py versions COMPONENTS MANIFEST PROFILE RELEASE
      COMPONENTS plus the package versions of an image's manifest: the
      versions-<profile>.json asset of a release.

  versions.py notes NEW OLD OLD_TAG [--profile NAME] [--no-sources] [KEY_FILE...]
      Markdown "what changed" between two versions files: changed sources
      with their commit titles (GitHub API, $GITHUB_TOKEN if set), then the
      packages, the ones named in KEY_FILEs (package profiles) and the kernel
      and NSS packages first. With several profiles, list the sources once
      (--no-sources for the others) and name the profile of each package list.
"""
import json
import os
import re
import sys
import urllib.request

TOP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAX_COMMITS = 10

# Feeds hosted on git.openwrt.org have GitHub mirrors to link to
MIRRORS = {
    "https://git.openwrt.org/feed/packages.git": "https://github.com/openwrt/packages",
    "https://git.openwrt.org/project/luci.git": "https://github.com/openwrt/luci",
    "https://git.openwrt.org/feed/routing.git": "https://github.com/openwrt/routing",
    "https://git.openwrt.org/feed/telephony.git": "https://github.com/openwrt/telephony",
}


def web_url(url):
    url = MIRRORS.get(url, url)
    return re.sub(r"\.git$", "", url)


def read_conf(path):
    conf = {}
    for line in open(path):
        m = re.match(r"^([A-Z_]+)=(.*)$", line.strip())
        if m:
            conf[m.group(1)] = m.group(2)
    return conf


def components(repo_url, repo_commit, third_party=None):
    comps = [{"id": "repo", "name": "This firmware's repository",
              "url": web_url(repo_url), "commit": repo_commit}]

    conf = read_conf(os.path.join(TOP, "upstream/openwrt.conf"))
    tree = {"id": "openwrt", "name": "OpenWrt tree", "url": web_url(conf["OPENWRT_URL"]),
            "commit": conf["OPENWRT_COMMIT"]}
    if conf.get("OPENWRT_RELEASE"):
        tree["release"] = conf["OPENWRT_RELEASE"]
        releases = conf.get("RELEASES_REPO")
        tree["release_url"] = "%s/releases/tag/%s" % (
            "https://github.com/" + releases if releases else tree["url"], conf["OPENWRT_RELEASE"])
    comps.append(tree)

    for line in open(os.path.join(TOP, "upstream/feeds.conf")):
        m = re.match(r"^src-git\s+(\S+)\s+([^\s^;]+)\^([0-9a-f]+)", line)
        if m:
            comps.append({"id": "feed/" + m.group(1), "name": "Feed: " + m.group(1),
                          "url": web_url(m.group(2)), "commit": m.group(3)})

    if third_party and os.path.exists(third_party):
        for line in open(third_party):
            f = line.split("#")[0].split()
            if len(f) == 5:
                comps.append({"id": "third/" + f[0], "name": f[0], "url": web_url(f[1]),
                              "commit": f[3]})
    return comps


def manifest(path):
    pkgs = {}
    for line in open(path):
        m = re.match(r"^(\S+) - (\S+)$", line.strip())
        if m:
            pkgs[m.group(1)] = m.group(2)
    return pkgs


def gh_compare(url, a, b):
    """Commit titles from a to b, or None if GitHub cannot tell."""
    m = re.match(r"^https://github\.com/([^/]+/[^/]+)$", url)
    if not m:
        return None
    req = urllib.request.Request("https://api.github.com/repos/%s/compare/%s...%s" % (m.group(1), a, b))
    if os.environ.get("GITHUB_TOKEN"):
        req.add_header("Authorization", "Bearer " + os.environ["GITHUB_TOKEN"])
    try:
        d = json.load(urllib.request.urlopen(req, timeout=30))
    except Exception:
        return None
    titles = [c["commit"]["message"].splitlines()[0] for c in d.get("commits", [])]
    return d.get("ahead_by", len(titles)), list(reversed(titles))


def key_packages(files):
    keys = set()
    for path in files:
        for line in open(path):
            name = line.split("#")[0].strip()
            if name and not name.startswith("-") and "_INCLUDE_" not in name:
                keys.add(name)
    return keys


def is_key(name, keys):
    return name in keys or name == "kernel" or name.startswith(("nss-firmware", "kmod-nss", "kmod-qca-nss"))


def notes(new, old, old_tag, key_files, profile=None, sources=True):
    keys = key_packages(key_files)
    out = []
    if sources:
        out += sources_notes(new, old, old_tag)
    out += packages_notes(new, old, keys, profile)
    return "\n".join(out)


def sources_notes(new, old, old_tag):
    out = ["## What's new since %s" % old_tag, ""]

    oldc = {c["id"]: c for c in old.get("components", [])}
    changed = []
    for c in new.get("components", []):
        o = oldc.get(c["id"])
        if o and o["commit"] == c["commit"]:
            continue
        line = "- **%s**" % c["name"]
        if not o:
            changed.append(line + ": new, at `%s`" % c["commit"][:7])
            continue
        link = "%s/compare/%s...%s" % (c["url"], o["commit"][:12], c["commit"][:12])
        cmp = gh_compare(c["url"], o["commit"], c["commit"]) if c["url"].startswith("https://github.com/") else None
        if c.get("release") and c.get("release") != o.get("release"):
            line += " %s → [%s](%s)" % (o.get("release", "?"), c["release"], c.get("release_url", c["url"]))
        line += ": `%s` → `%s` ([%s](%s))" % (
            o["commit"][:7], c["commit"][:7],
            "%d commits" % cmp[0] if cmp else "compare", link)
        changed.append(line)
        if cmp:
            for t in cmp[1][:MAX_COMMITS]:
                changed.append("  - " + t.replace("|", "\\|"))
            if cmp[0] > MAX_COMMITS:
                changed.append("  - … and %d more" % (cmp[0] - MAX_COMMITS))
    for o in old.get("components", []):
        if o["id"] not in {c["id"] for c in new.get("components", [])}:
            changed.append("- **%s**: removed" % o["name"])
    return out + ["### Sources", ""] + (changed or ["No source changed."]) + [""]


def packages_notes(new, old, keys, profile):
    np, op = new.get("packages", {}), old.get("packages", {})
    updated = [(n, op[n], np[n]) for n in sorted(np) if n in op and op[n] != np[n]]
    added = [(n, np[n]) for n in sorted(np) if n not in op]
    removed = [(n, op[n]) for n in sorted(op) if n not in np]

    out = ["### Packages" + (" (profile `%s`)" % profile if profile else ""), ""]
    if not (updated or added or removed):
        return out + ["No package changed.", ""]
    key_rows = [u for u in updated if is_key(u[0], keys)]
    if key_rows:
        out += ["| Package | From | To |", "|---|---|---|"]
        out += ["| `%s` | %s | %s |" % u for u in key_rows] + [""]
    out.append("%d updated, %d added, %d removed." % (len(updated), len(added), len(removed)))
    rest = [u for u in updated if not is_key(u[0], keys)]
    if rest or added or removed:
        out += ["", "<details><summary>All package changes</summary>", ""]
        out += ["- `%s` %s → %s" % u for u in rest]
        out += ["- `%s` %s (added)" % a for a in added]
        out += ["- `%s` %s (removed)" % r for r in removed]
        out += ["", "</details>"]
    return out + [""]


def main(argv):
    if len(argv) >= 3 and argv[0] == "components":
        tp = argv[argv.index("--third-party") + 1] if "--third-party" in argv else None
        json.dump(components(argv[1], argv[2], tp), sys.stdout, indent=1)
    elif len(argv) == 5 and argv[0] == "versions":
        comps = json.load(open(argv[1]))
        json.dump({"profile": argv[3], "release": argv[4], "components": comps,
                   "packages": manifest(argv[2])}, sys.stdout, indent=1, sort_keys=True)
    elif len(argv) >= 4 and argv[0] == "notes":
        rest, profile, sources = argv[4:], None, True
        if "--no-sources" in rest:
            rest.remove("--no-sources")
            sources = False
        if "--profile" in rest:
            i = rest.index("--profile")
            profile = rest[i + 1]
            del rest[i:i + 2]
        print(notes(json.load(open(argv[1])), json.load(open(argv[2])), argv[3], rest, profile, sources))
    else:
        sys.exit(__doc__)
    print()


if __name__ == "__main__":
    main(sys.argv[1:])
