'use strict';
'require view';
'require dom';
'require fs';
'require ui';
'require poll';
'require form';

function ota(cmd) {
	return fs.exec('/usr/sbin/ra81-ota', [ cmd ]).then(function(res) {
		if (res.code !== 0)
			throw new Error((res.stderr || '').replace(/^ra81-ota: /, '').trim() ||
				_('ra81-ota %s failed').format(cmd));
		try { return JSON.parse(res.stdout); }
		catch (e) { return res.stdout; }
	});
}

function fmtTime(s) {
	return '%d:%02d'.format(Math.floor(s / 60), s % 60);
}

function row(label, value) {
	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td left', 'width': '33%' }, label),
		E('td', { 'class': 'td left' }, value)
	]);
}

var busyStates = [ 'checking', 'downloading', 'verifying', 'flashing' ];

return view.extend({
	load: function() {
		return ota('status').catch(function(e) { return { error: e.message }; });
	},

	awaitReboot: function(title, text) {
		ui.showModal(title, [
			E('p', { 'class': 'spinning' }, text)
		]);
		window.setTimeout(function() { ui.awaitReconnect(); }, 15000);
	},

	handleCheck: function(ev) {
		var node = this.checkNode;

		dom.content(node, E('em', { 'class': 'spinning' }, _('Checking for updates…')));
		return ota('check').then(L.bind(function(rel) {
			this.release = rel;
			this.renderCheck();
		}, this)).catch(function(e) {
			dom.content(node, E('p', { 'class': 'alert-message warning' }, e.message));
		});
	},

	renderCheck: function() {
		var rel = this.release, st = this.status || {}, items = [], busy;

		if (!rel)
			return;

		busy = st.job && busyStates.indexOf(st.job.state) >= 0;
		items.push(E('p', {}, [
			_('Newest release: '), E('strong', {}, rel.tag), ' (%s) '.format((rel.date || '').replace('T', ' ').replace('Z', ' UTC')),
			E('a', { 'href': rel.url, 'target': '_blank', 'rel': 'noreferrer' }, _('release notes'))
		]));
		if (!rel.signed)
			items.push(E('p', { 'class': 'alert-message warning' }, _('This release is not signed.')));

		if (!rel.update_available)
			items.push(E('p', {}, _('The installed firmware is up to date.')));
		else if (st.trial && st.trial.active)
			items.push(E('p', {}, _('Keep or roll back the firmware on trial before installing another one.')));
		else
			items.push(E('button', {
				'class': 'btn cbi-button cbi-button-apply',
				'disabled': busy ? true : null,
				'click': ui.createHandlerFn(this, 'handleUpdate')
			}, _('Install %s').format(rel.tag)));

		dom.content(this.checkNode, items);
	},

	handleUpdate: function(ev) {
		var rel = this.release;

		ui.showModal(_('Install %s?').format(rel.tag), [
			E('p', {}, _('%s (%1024.2mB) will be downloaded from %s, verified and written to the other firmware slot. The router then reboots into it; settings are kept.')
				.format(rel.image, rel.size, rel.repo)),
			E('p', {}, _('The new firmware starts on trial: keep it on this page afterwards, or it will be kept or rolled back automatically when the trial period ends (see the settings below).')),
			E('p', {}, _('Packages installed by hand with apk are not carried over: add them to your build profile instead.')),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')), ' ',
				E('button', {
					'class': 'btn cbi-button-action important',
					'click': ui.createHandlerFn(this, function() {
						ui.hideModal();
						return ota('start').then(L.bind(this.refresh, this)).catch(function(e) {
							ui.addNotification(null, E('p', {}, e.message), 'danger');
						});
					})
				}, _('Install'))
			])
		]);
	},

	handleConfirm: function(ev) {
		return ota('confirm').then(L.bind(this.refresh, this)).catch(function(e) {
			ui.addNotification(null, E('p', {}, e.message), 'danger');
		});
	},

	handleRollback: function(ev) {
		ui.showModal(_('Roll back?'), [
			E('p', {}, _('The router reboots into the firmware it ran before this update.')),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')), ' ',
				E('button', {
					'class': 'btn cbi-button-negative important',
					'click': ui.createHandlerFn(this, function() {
						fs.exec('/usr/sbin/ra81-ota', [ 'rollback' ]).catch(function() {});
						this.awaitReboot(_('Rolling back…'), _('The router is rebooting into the previous firmware.'));
					})
				}, _('Roll back'))
			])
		]);
	},

	refresh: function() {
		return ota('status').then(L.bind(this.renderStatus, this)).catch(function() {});
	},

	renderStatus: function(st) {
		var nodes = [], inst, job, trial;

		this.status = st;
		if (st.error) {
			dom.content(this.statusNode, E('p', { 'class': 'alert-message warning' }, st.error));
			return;
		}
		inst = st.installed || {};
		job = st.job || {};
		trial = st.trial || {};

		if (trial.active) {
			nodes.push(E('div', { 'class': 'alert-message notice' }, [
				E('h4', {}, _('This firmware is on trial')),
				E('p', {}, trial.held
					? _('Unless you choose, it will be %s in %s.').format(
						trial.on_timeout == 'confirm' ? _('kept (if the network is up)') : _('rolled back'),
						fmtTime(trial.remaining || 0))
					: _('It was not installed by this updater; it is confirmed when the boot completes.')),
				E('div', {}, [
					E('button', {
						'class': 'btn cbi-button cbi-button-positive',
						'click': ui.createHandlerFn(this, 'handleConfirm')
					}, _('Keep this firmware')), ' ',
					E('button', {
						'class': 'btn cbi-button cbi-button-negative',
						'click': ui.createHandlerFn(this, 'handleRollback')
					}, _('Roll back'))
				])
			]));
		}

		if (st.last_result)
			nodes.push(E('p', { 'class': 'alert-message' }, st.last_result));

		nodes.push(E('table', { 'class': 'table' }, [
			row(_('Installed release'), inst.tag || E('em', {}, _('local build'))),
			row(_('Build profile'), inst.profile || '?'),
			row(_('Built'), '%s (%s)'.format(inst.date || '?', inst.commit || '?')),
			row(_('Firmware slot'), st.slot >= 0 ? String(st.slot) : '?'),
			row(_('Update source'), st.repo
				? E('a', { 'href': 'https://github.com/%s/releases'.format(st.repo), 'target': '_blank', 'rel': 'noreferrer' }, st.repo)
				: E('em', {}, _('none: set a release repository below')))
		]));

		if (busyStates.indexOf(job.state) >= 0 || job.state == 'error') {
			var text = {
				checking: _('Looking up the release…'),
				downloading: _('Downloading…'),
				verifying: _('Verifying the signature and checksum…'),
				flashing: _('Writing the firmware; the router will reboot.'),
				error: _('The update failed:')
			}[job.state];

			if (job.state == 'downloading' && job.received && this.release && this.release.size)
				text += ' %d%%'.format(Math.floor(job.received * 100 / this.release.size));

			nodes.push(E('p', {
				'class': job.state == 'error' ? 'alert-message danger' : 'spinning'
			}, [ text, ' ', E('small', {}, job.message || '') ]));

			if (job.state == 'flashing' && !this.rebooting) {
				this.rebooting = true;
				this.awaitReboot(_('Installing…'), _('The new firmware is being written. The router reboots into it and this page reconnects when it is back (this takes a few minutes).'));
			}
		}

		dom.content(this.statusNode, nodes);
		this.renderCheck();
	},

	render: function(status) {
		var m, s, o;

		m = new form.Map('ra81-ota');
		s = m.section(form.NamedSection, 'main', 'ota', _('Settings'));

		o = s.option(form.Value, 'repo', _('Release repository'),
			_('GitHub repository (owner/name) whose releases are installed. Empty: the one that built this firmware.'));
		o.placeholder = (status.installed || {}).repo || '';

		o = s.option(form.Flag, 'prerelease', _('Include pre-releases'));

		o = s.option(form.Value, 'trial_timeout', _('Trial period'),
			_('Seconds a newly installed firmware waits for you to keep or roll it back.'));
		o.datatype = 'range(60,86400)';

		o = s.option(form.ListValue, 'on_timeout', _('When the trial period ends'));
		o.value('confirm', _('Keep it if the LAN is up and the health check host answers'));
		o.value('rollback', _('Roll back'));

		o = s.option(form.Value, 'check_host', _('Health check host'),
			_('Pinged before an unattended keep. Empty: the default gateway.'));
		o.datatype = 'host';

		o = s.option(form.Value, 'pubkey', _('Signing key'),
			_('usign public key file the release checksums must be signed with.'));
		o.datatype = 'file';

		o = s.option(form.Flag, 'allow_unsigned', _('Allow unsigned releases'),
			_('Not recommended: an unsigned release is only checked against its own checksums.'));

		this.statusNode = E('div');
		this.checkNode = E('div');

		return m.render().then(L.bind(function(mapEl) {
			this.renderStatus(status);
			poll.add(L.bind(this.refresh, this), 3);

			return E([], [
				E('h2', {}, _('Firmware Update')),
				E('div', { 'class': 'cbi-map-descr' },
					_('Installs signed releases into the other firmware slot. The firmware running now stays in place as the fallback.')),
				this.statusNode,
				E('div', { 'class': 'cbi-section' }, [
					E('button', {
						'class': 'btn cbi-button cbi-button-action',
						'click': ui.createHandlerFn(this, 'handleCheck')
					}, _('Check for updates')),
					this.checkNode
				]),
				mapEl
			]);
		}, this));
	}
});
