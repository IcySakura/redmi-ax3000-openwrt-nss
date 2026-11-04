// What installing a release would change on this router.
//
//   ucode details.uc VERSIONS COMPONENTS PROFILE [TAG URL]
//
// VERSIONS is the release's versions-<profile>.json, COMPONENTS the sources
// the running image was built from, PROFILE its package profile. Compares
// them with the packages installed now (and in /rom, to tell packages added
// by hand) and prints JSON: changed sources, and updated, added and removed
// packages, the ones named in the profile and the kernel and NSS packages
// marked as key.
'use strict';

import { readfile } from 'fs';

// (no destructuring: the ucode of older images cannot parse it)
const versions_file = ARGV[0], components_file = ARGV[1], profile_file = ARGV[2],
	tag = ARGV[3], url = ARGV[4];

function apk_db(path) {
	let pkgs = {}, name;

	for (let line in split(readfile(path) ?? '', '\n')) {
		if (substr(line, 0, 2) == 'P:')
			name = substr(line, 2);
		else if (substr(line, 0, 2) == 'V:' && name)
			pkgs[name] = substr(line, 2);
	}
	return pkgs;
}

function compare_url(url, from, to) {
	return match(url, /^https:\/\/github\.com\/[^\/]+\/[^\/]+$/)
		? `${url}/compare/${substr(from, 0, 12)}...${substr(to, 0, 12)}` : null;
}

const release = json(readfile(versions_file));
const running = json(readfile(components_file) ?? '[]') ?? [];
const installed = apk_db('/lib/apk/db/installed');
const in_image = apk_db('/rom/lib/apk/db/installed');

let key_names = {};
for (let line in split(readfile(profile_file) ?? '', '\n')) {
	line = trim(split(line, '#')[0]);
	if (line && substr(line, 0, 1) != '-' && index(line, '_INCLUDE_') < 0)
		key_names[line] = true;
}

function is_key(name) {
	return key_names[name] || name == 'kernel' || match(name, /^(nss-firmware|kmod-nss|kmod-qca-nss)/) != null;
}

let by_id = {};
for (let c in running)
	by_id[c.id] = c;

let sources = [];
for (let c in release.components ?? []) {
	let o = by_id[c.id];

	if (o && o.commit == c.commit)
		continue;
	push(sources, {
		name: c.name,
		from: o ? substr(o.commit, 0, 7) : null,
		to: substr(c.commit, 0, 7),
		release: c.release,
		release_url: c.release_url,
		url: o ? compare_url(c.url, o.commit, c.commit) : c.url
	});
}

let updated = [], added = [], removed = [];
for (let name in sort(keys(release.packages ?? {}))) {
	let to = release.packages[name], from = installed[name];

	if (from == null)
		push(added, { name, to, key: is_key(name) });
	else if (from != to)
		push(updated, { name, from, to, key: is_key(name) });
}
for (let name in sort(keys(installed)))
	if (release.packages[name] == null)
		push(removed, { name, from: installed[name], by_hand: in_image[name] == null });

printf('%J\n', {
	available: true,
	tag, url,
	compared_with: length(running) ? 'running' : 'unknown',
	release: release.release,
	sources, updated, added, removed
});
