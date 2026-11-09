'use strict';
'require baseclass';
'require fs';
'require ui';

/* Notices on the Dashboard, LuCI's landing page: a firmware on trial, and a
   newer release (see "notify" in /etc/config/ra81-ota). Once per page
   load; the update notice once per browser session and release, and never
   again for a release skipped with "Skip this release". */

const CMD = '/usr/sbin/ra81-ota';
const SEEN = 'ra81-ota-notice-seen', SKIPPED = 'ra81-ota-notice-skipped';

let done = false;

function ota(cmd) {
	return fs.exec(CMD, [ cmd ]).then(res => (res.code === 0) ? JSON.parse(res.stdout) : null).catch(() => null);
}

// Browser storage can be missing or refuse (private windows)
function getItem(store, key) {
	try { return window[store].getItem(key); } catch (e) { return null; }
}

function setItem(store, key, value) {
	try { window[store].setItem(key, value); } catch (e) {}
}

function dismiss(msg) {
	msg.classList.add('fade-out');
}

function open() {
	window.location.href = L.url('admin/system/ra81-ota');
}

function trialNotice(st) {
	const trial = st && st.trial;

	if (!trial || !trial.active || !trial.held)
		return;

	ui.addNotification(_('This firmware is on trial'), [
		E('p', {}, [
			(trial.on_timeout == 'confirm'
				? _('%s was just installed. Unless you choose, it is kept in about %d min if the network is up.')
				: _('%s was just installed. Unless you keep it, it is rolled back in about %d min.'))
				.format(st.installed.tag || _('This firmware'), Math.max(1, Math.round((trial.remaining || 0) / 60)))
		]),
		E('p', {}, E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': open }, _('Keep or roll back…')))
	], 'warning');
}

function updateNotice(n) {
	const rel = n && n.enabled && n.release;
	let msg;

	if (!rel || rel.relation != 'newer' || getItem('localStorage', SKIPPED) == rel.tag || getItem('sessionStorage', SEEN) == rel.tag)
		return;

	setItem('sessionStorage', SEEN, rel.tag);
	msg = ui.addNotification(_('Firmware update available'), [
		E('p', {}, _('%s is out (%s channel); this router runs %s.').format(rel.tag,
			rel.channel == 'stable' ? _('stable') : _('testing'), n.installed || _('a local build'))),
		E('p', {}, [
			E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': open }, _('See what is new…')), ' ',
			E('button', {
				'class': 'btn cbi-button cbi-button-neutral',
				'click': () => { setItem('localStorage', SKIPPED, rel.tag); dismiss(msg); }
			}, _('Skip this release'))
		])
	], 'notice');
}

return baseclass.extend({
	// Called on every Dashboard refresh: only the first one looks
	load() {
		if (!done) {
			done = true;
			ota('status').then(trialNotice);
			ota('notice').then(updateNotice);
		}
		return Promise.resolve(null);
	},

	render() {
		return null;
	}
});
