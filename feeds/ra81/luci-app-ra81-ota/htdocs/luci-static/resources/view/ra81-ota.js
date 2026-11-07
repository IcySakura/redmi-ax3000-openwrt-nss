'use strict';
'require view';
'require dom';
'require fs';
'require ui';
'require poll';
'require form';
'require uci';

var CMD = '/usr/sbin/ra81-ota';

/* Releases and history entries shown before "Show more" */
var SHOWN = 5;

var busyStates = [ 'checking', 'downloading', 'verifying', 'flashing' ];

/* Cards and lists in the style of the theme and the dashboard: only the
   theme's own classes and colour variables (with fallbacks for other themes) */
var css = '\
.ota { display: grid; gap: 16px; margin-bottom: 16px; }\
.ota-cards { display: flex; flex-wrap: wrap; gap: 16px; }\
.ota-cards > .cbi-section { flex: 1 1 220px; min-width: 0; margin: 0; }\
.ota .cbi-section { margin-bottom: 0; }\
.ota-card small { display: block; color: var(--text-color-medium, #6b7280); overflow-wrap: anywhere; }\
.ota-card strong { display: block; font-size: 20px; line-height: 1.25; margin: 2px 0 4px; overflow-wrap: anywhere; }\
.ota-card .btn { margin-top: 10px; }\
.ota-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; }\
.ota-head h3 { margin: 0; }\
.ota-head small { color: var(--text-color-medium, #6b7280); }\
.ota-list { list-style: none; margin: 8px 0 0; padding: 0; }\
.ota-list > li { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 10px 0; border-top: 1px solid var(--border-color-medium, rgba(0, 0, 0, .12)); }\
.ota-list > li:first-child { border-top: 0; }\
.ota-main { flex: 1 1 240px; min-width: 0; }\
.ota-main > a, .ota-main > b { font-weight: 600; overflow-wrap: anywhere; }\
.ota-main .label { margin-left: 6px; vertical-align: middle; }\
.ota-meta { display: block; font-size: 12.5px; color: var(--text-color-medium, #6b7280); }\
.ota-actions { display: flex; flex-wrap: wrap; gap: 6px; }\
.ota-more { margin-top: 6px; }\
.ota-progress { height: 6px; margin-top: 10px; border-radius: 3px; overflow: hidden; background: var(--border-color-medium, rgba(0, 0, 0, .12)); }\
.ota-progress > i { display: block; height: 100%; background: var(--primary-color-high, #1976d2); transition: width .5s; }\
.ota-modal h5 { margin: 14px 0 6px; }\
';

function ota(cmd, arg) {
	return fs.exec(CMD, arg ? [ cmd, arg ] : [ cmd ]).then(function(res) {
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

function toDate(d) {
	var t = (typeof(d) == 'number') ? new Date(d * 1000) : new Date(d || NaN);
	return isNaN(t.getTime()) ? null : t;
}

function fmtDate(d) {
	var t = toDate(d);
	return t ? t.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '?';
}

function ago(d) {
	var t = toDate(d), s;

	if (!t)
		return '';
	s = Math.max(0, Math.floor((Date.now() - t.getTime()) / 1000));
	if (s < 3600)
		return _('%d min ago').format(Math.max(1, Math.floor(s / 60)));
	if (s < 86400)
		return _('%d h ago').format(Math.floor(s / 3600));
	if (s < 172800)
		return _('yesterday');
	return _('%d days ago').format(Math.floor(s / 86400));
}

function link(href, text) {
	return E('a', { 'href': href, 'target': '_blank', 'rel': 'noreferrer' }, text);
}

function badge(text, kind) {
	return E('span', { 'class': 'label ' + (kind || '') }, text);
}

function card(title, value, sub, extra) {
	return E('div', { 'class': 'cbi-section ota-card' }, [
		E('small', {}, title),
		E('strong', {}, value)
	].concat((sub || []).filter(function(s) { return s; }).map(function(s) {
		return E('small', {}, s);
	}), extra || []));
}

function section(title, note, body) {
	return E('div', { 'class': 'cbi-section' }, [
		E('div', { 'class': 'ota-head' }, [ E('h3', {}, title), note || '' ])
	].concat(body));
}

function table(titles, rows) {
	return E('table', { 'class': 'table' }, [
		E('tr', { 'class': 'tr table-titles' }, titles.map(function(t) { return E('th', { 'class': 'th' }, t); }))
	].concat(rows.map(function(r) {
		return E('tr', { 'class': 'tr' }, r.map(function(c) { return E('td', { 'class': 'td left' }, c); }));
	})));
}

/* A list that shows its first SHOWN items, and the rest on demand */
function foldList(items, open, onToggle, moreText) {
	var nodes = [ E('ul', { 'class': 'ota-list' }, open ? items : items.slice(0, SHOWN)) ];

	if (items.length > SHOWN)
		nodes.push(E('button', {
			'class': 'btn cbi-button cbi-button-neutral ota-more',
			'click': onToggle
		}, open ? _('Show fewer') : moreText.format(items.length - SHOWN)));
	return nodes;
}

/* What installing a release changes, from "ra81-ota details" */
function renderDetails(d, brief) {
	var nodes = [], key, rest, byHand;

	if (!d.available)
		return [ E('p', {}, [ _('This release carries no version information (it predates it).'), ' ',
			link(d.url, _('Read its release notes on GitHub.')) ]) ];

	if (d.compared_with == 'unknown')
		nodes.push(E('p', {}, _('The running firmware predates version tracking: the sources below are those of the release, and its packages are compared with the ones installed now.')));

	if (d.sources.length)
		nodes.push(E('h5', {}, _('Sources')), table([ _('Source'), _('Change') ], d.sources.map(function(c) {
			var change = c.from ? '%s → %s'.format(c.from, c.to) : _('new (%s)').format(c.to);
			return [
				c.release && c.release_url ? [ c.name, E('br'), link(c.release_url, c.release) ] : c.name,
				c.url ? link(c.url, change) : change
			];
		})));
	else
		nodes.push(E('p', {}, _('Built from the same sources as the running firmware.')));

	key = d.updated.filter(function(p) { return p.key; });
	rest = d.updated.filter(function(p) { return !p.key; });
	byHand = d.removed.filter(function(p) { return p.by_hand; });

	nodes.push(E('h5', {}, _('Packages')));
	if (key.length)
		nodes.push(table([ _('Package'), _('Installed'), _('New') ], key.map(function(p) {
			return [ E('code', {}, p.name), p.from, p.to ];
		})));
	nodes.push(E('p', {}, _('%d updated, %d added, %d removed.').format(d.updated.length, d.added.length, d.removed.length)));

	if (!brief && (rest.length || d.added.length || d.removed.length))
		nodes.push(E('details', {}, [
			E('summary', {}, _('All package changes')),
			E('ul', {}, [].concat(
				rest.map(function(p) { return E('li', {}, [ E('code', {}, p.name), ' %s → %s'.format(p.from, p.to) ]); }),
				d.added.map(function(p) { return E('li', {}, [ E('code', {}, p.name), ' %s '.format(p.to), E('em', {}, _('(added)')) ]); }),
				d.removed.map(function(p) { return E('li', {}, [ E('code', {}, p.name), ' %s '.format(p.from), E('em', {}, p.by_hand ? _('(installed by hand, will be gone)') : _('(removed)')) ]); })
			))
		]));

	if (byHand.length)
		nodes.push(E('p', { 'class': 'alert-message warning' }, _('Installed by hand on this router and not part of this release, so they will be gone after installing it: %s. Add them to your build profile to keep them.')
			.format(byHand.map(function(p) { return p.name; }).join(', '))));

	nodes.push(E('p', {}, link(d.url, _('Release notes on GitHub'))));
	return nodes;
}

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

	/* The release list (one GitHub API call): on opening the page and on demand */
	handleCheck: function(ev) {
		this.releases = null;
		this.listError = null;
		this.checking = true;
		this.renderAll();
		return ota('list').then(L.bind(function(list) {
			this.releases = list;
		}, this)).catch(L.bind(function(e) {
			this.listError = e.message;
		}, this)).then(L.bind(function() {
			this.checking = false;
			this.renderAll();
		}, this));
	},

	handleDetails: function(rel, ev) {
		var title = _('%s compared to this firmware').format(rel.tag),
		    close = E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')));

		ui.showModal(title, [ E('p', { 'class': 'spinning' }, _('Comparing…')) ]);
		return ota('details', rel.tag).then(function(d) {
			ui.showModal(title, [ E('div', { 'class': 'ota-modal' }, renderDetails(d)), close ]);
		}).catch(function(e) {
			ui.showModal(title, [ E('p', { 'class': 'alert-message warning' }, e.message), close ]);
		});
	},

	handleUpdate: function(rel, repo, ev) {
		ui.showModal(_('Install %s?').format(rel.tag), [ E('p', { 'class': 'spinning' }, _('Comparing with this firmware…')) ]);
		return ota('details', rel.tag).catch(function() { return null; }).then(L.bind(function(d) {
			this.confirmUpdate(rel, repo, d);
		}, this));
	},

	confirmUpdate: function(rel, repo, details) {
		var older = rel.relation == 'older';

		ui.showModal(_('Install %s?').format(rel.tag), [
			details ? E('div', { 'class': 'cbi-section ota-modal' }, [ E('h4', {}, _('What changes')) ].concat(renderDetails(details, true))) : '',
			older ? E('p', { 'class': 'alert-message warning' },
				_('This release is older than the installed firmware. Your current settings are kept and may include options the older firmware does not know; this is usually harmless, but not guaranteed.')) : '',
			E('p', {}, _('%s (%1024.2mB) will be downloaded from %s, verified and written to the other firmware slot. The router then reboots into it; settings are kept.')
				.format(rel.image, rel.size, repo)),
			E('p', {}, _('The new firmware starts on trial: keep it on this page afterwards, or it will be kept or rolled back automatically when the trial period ends (see the settings below).')),
			E('p', {}, _('Packages installed by hand with apk are not carried over: add them to your build profile instead.')),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')), ' ',
				E('button', {
					'class': 'btn important ' + (older ? 'cbi-button-negative' : 'cbi-button-action'),
					'click': ui.createHandlerFn(this, function() {
						ui.hideModal();
						this.installing = rel;
						return ota('start', rel.tag).then(L.bind(this.refresh, this)).catch(function(e) {
							ui.addNotification(null, E('p', {}, e.message), 'danger');
						});
					})
				}, older ? _('Install older release') : _('Install'))
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
						fs.exec(CMD, [ 'rollback' ]).catch(function() {});
						this.awaitReboot(_('Rolling back…'), _('The router is rebooting into the previous firmware.'));
					})
				}, _('Roll back'))
			])
		]);
	},

	refresh: function() {
		return ota('status').then(L.bind(function(st) {
			this.status = st;
			this.renderAll();
		}, this)).catch(function() {});
	},

	/* Whether a release may be installed now */
	blocked: function() {
		var st = this.status || {};
		return (st.job && busyStates.indexOf(st.job.state) >= 0) || (st.trial && st.trial.active);
	},

	renderTrial: function(trial) {
		if (!trial.active)
			return '';

		return E('div', { 'class': 'alert-message notice' }, [
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
		]);
	},

	/* The middle card: the newest release, or what an install is doing */
	renderUpdateCard: function(st) {
		var job = st.job || {}, list = this.releases, newest, text, pct;

		if (busyStates.indexOf(job.state) >= 0) {
			text = {
				checking: _('Looking up the release…'),
				downloading: _('Downloading…'),
				verifying: _('Verifying…'),
				flashing: _('Writing the firmware…')
			}[job.state];

			if (job.state == 'downloading' && job.received && this.installing && this.installing.size)
				pct = Math.min(100, Math.floor(job.received * 100 / this.installing.size));

			if (job.state == 'flashing' && !this.rebooting) {
				this.rebooting = true;
				this.awaitReboot(_('Installing…'), _('The new firmware is being written. The router reboots into it and this page reconnects when it is back (this takes a few minutes).'));
			}

			return card(_('Update'), E('span', { 'class': 'spinning' }, pct != null ? '%s %d%%'.format(text, pct) : text),
				[ this.installing ? this.installing.tag : null, job.message ],
				pct != null ? [ E('div', { 'class': 'ota-progress' }, E('i', { 'style': 'width:%d%%'.format(pct) })) ] : []);
		}

		if (job.state == 'error')
			return card(_('Update'), _('The update failed'), [ job.message ],
				[ E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': ui.createHandlerFn(this, 'handleCheck') }, _('Check again')) ]);

		if (this.checking)
			return card(_('Updates'), E('span', { 'class': 'spinning' }, _('Checking…')));

		if (this.listError)
			return card(_('Updates'), _('Could not check'), [ this.listError ],
				[ E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': ui.createHandlerFn(this, 'handleCheck') }, _('Try again')) ]);

		if (!list || !list.releases.length)
			return card(_('Updates'), _('No releases'), [ list ? _('Nothing on the %s channel for profile %s.').format(list.channel, list.profile) : null ]);

		newest = list.releases[0];
		if (newest.relation != 'newer')
			return card(_('Updates'), _('Up to date'),
				[ _('No newer %s release').format(list.channel == 'stable' ? _('stable') : _('testing')) ]);

		return card(_('Update available'), newest.tag, [ '%s · %s'.format(fmtDate(newest.date), ago(newest.date)) ], [
			E('div', { 'class': 'ota-actions' }, [
				E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'click': ui.createHandlerFn(this, 'handleDetails', newest)
				}, _("What's new")),
				E('button', {
					'class': 'btn cbi-button cbi-button-action important',
					'disabled': this.blocked() ? true : null,
					'click': ui.createHandlerFn(this, 'handleUpdate', newest, list.repo)
				}, _('Install'))
			])
		]);
	},

	renderRelease: function(rel, repo) {
		var labels = [];

		if (rel.relation == 'installed')
			labels.push(badge(_('installed'), 'notice'));
		else if (rel.relation == 'newer')
			labels.push(badge(_('newer'), 'success'));
		if (!rel.signed)
			labels.push(badge(_('unsigned'), 'warning'));

		return E('li', {}, [
			E('div', { 'class': 'ota-main' }, [ link(rel.url, rel.tag) ].concat(labels, [
				E('span', { 'class': 'ota-meta' }, [ fmtDate(rel.date), ' · ', ago(rel.date), ' · ',
					rel.channel == 'stable' ? _('stable') : _('testing') ])
			])),
			rel.relation == 'installed' ? '' : E('div', { 'class': 'ota-actions' }, [
				E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'click': ui.createHandlerFn(this, 'handleDetails', rel)
				}, _("What's new")),
				E('button', {
					'class': 'btn cbi-button ' + (rel.relation == 'newer' ? 'cbi-button-action important' : 'cbi-button-neutral'),
					'disabled': this.blocked() ? true : null,
					'click': ui.createHandlerFn(this, 'handleUpdate', rel, repo)
				}, _('Install'))
			])
		]);
	},

	renderReleases: function() {
		var list = this.releases, refresh, body;

		refresh = E('button', {
			'class': 'btn cbi-button cbi-button-neutral',
			'disabled': this.checking ? true : null,
			'click': ui.createHandlerFn(this, 'handleCheck')
		}, _('Check again'));

		if (this.checking)
			body = [ E('p', { 'class': 'spinning' }, _('Looking up releases…')) ];
		else if (this.listError)
			body = [ E('p', { 'class': 'alert-message warning' }, this.listError) ];
		else if (!list)
			body = [];
		else if (!list.releases.length)
			body = [ E('p', { 'class': 'alert-message warning' },
				list.channel == 'stable'
					? _('%s has no stable release for profile %s yet. Switch the channel to "testing" below to see test releases.').format(list.repo, list.profile)
					: _('%s has no release for profile %s.').format(list.repo, list.profile)) ];
		else
			body = foldList(list.releases.map(L.bind(function(rel) { return this.renderRelease(rel, list.repo); }, this)),
				this.allReleases, L.bind(function() { this.allReleases = !this.allReleases; this.renderAll(); }, this),
				_('Show %d older releases'));

		if (list && list.releases.length && this.blocked())
			body.unshift(E('p', {}, _('Keep or roll back the firmware on trial, or wait for the running update, before installing another one.')));

		return section(_('Releases'), E('div', { 'class': 'ota-actions' }, [
			list && list.releases.length ? E('small', {}, _('%d on the %s channel, newest first').format(list.releases.length,
				list.channel == 'stable' ? _('stable') : _('testing'))) : '',
			refresh
		]), body);
	},

	renderHistory: function(history) {
		if (!history || !history.length)
			return '';

		return section(_('Update history'), '', foldList(history.map(function(h) {
			return E('li', {}, E('div', { 'class': 'ota-main' }, [
				E('span', {}, h.text),
				E('span', { 'class': 'ota-meta' }, [ fmtDate(h.time), ' · ', ago(h.time) ])
			]));
		}), this.allHistory, L.bind(function() { this.allHistory = !this.allHistory; this.renderAll(); }, this),
			_('Show %d earlier events')));
	},

	renderAll: function() {
		var st = this.status || {}, inst, repo, channel;

		if (st.error) {
			dom.content(this.mainNode, E('p', { 'class': 'alert-message warning' }, st.error));
			return;
		}

		inst = st.installed || {};
		repo = st.repo;
		channel = this.releases ? this.releases.channel : null;

		dom.content(this.mainNode, [
			this.renderTrial(st.trial || {}),
			E('div', { 'class': 'ota-cards' }, [
				card(_('Installed firmware'), inst.tag || _('Local build'), [
					'%s · %s'.format(inst.profile || '?', fmtDate(inst.date)),
					_('Commit %s · slot %s').format(inst.commit ? inst.commit.substring(0, 7) : '?', st.slot >= 0 ? String(st.slot) : '?')
				]),
				this.renderUpdateCard(st),
				card(_('Update source'), repo ? link('https://github.com/%s/releases'.format(repo), repo.replace(/^.*\//, '')) : _('None'), [
					repo ? repo.replace(/\/.*$/, '') : _('Set a release repository below'),
					channel ? _('%s channel').format(channel == 'stable' ? _('Stable') : _('Testing')) : null,
					repo ? link('https://github.com/%s/commits'.format(repo), _('Change history')) : null
				])
			]),
			this.renderReleases(),
			this.renderHistory(st.history)
		]);
	},

	render: function(status) {
		var m, s, o;

		if (!document.querySelector('style[data-ota]'))
			document.head.appendChild(E('style', { 'data-ota': '' }, css));

		m = new form.Map('ra81-ota');
		s = m.section(form.NamedSection, 'main', 'ota', _('Settings'));

		o = s.option(form.Value, 'repo', _('Release repository'),
			_('GitHub repository (owner/name) whose releases are installed. Empty: the one that built this firmware.'));
		o.placeholder = (status.installed || {}).repo || '';

		o = s.option(form.ListValue, 'channel', _('Channel'),
			_('Stable: releases the repository has marked as stable. Testing: every release, including automatic builds of new upstream versions.'));
		o.value('stable', _('Stable'));
		o.value('testing', _('Testing'));
		o.cfgvalue = function(section_id) {
			// settings from before channels existed
			return uci.get('ra81-ota', section_id, 'channel') ||
				(uci.get('ra81-ota', section_id, 'prerelease') == '1' ? 'testing' : 'stable');
		};

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

		this.status = status;
		this.mainNode = E('div', { 'class': 'ota' });

		return m.render().then(L.bind(function(mapEl) {
			this.renderAll();
			if (!status.error)
				this.handleCheck();
			poll.add(L.bind(this.refresh, this), 3);

			return E([], [
				E('h2', {}, _('Firmware Update')),
				E('div', { 'class': 'cbi-map-descr' },
					_('Installs signed releases into the other firmware slot. The firmware running now stays in place as the fallback.')),
				this.mainNode,
				mapEl
			]);
		}, this));
	}
});
