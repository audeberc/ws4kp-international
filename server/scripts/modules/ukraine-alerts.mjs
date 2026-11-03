// Ukraine air raid alert map
// Data comes from this app's own server: GET /api/ukraine-alerts (see src/ukraine-alerts/)
// Screen 0: whole country, screen 1 (only when oblasts are followed): zoomed to the followed oblasts
// When a followed oblast gets a new alert the rotation is interrupted with a warning banner.

import STATUS from './status.mjs';
import WeatherDisplay from './weatherdisplay.mjs';
import { registerDisplay, timeZone, showDisplayNow } from './navigation.mjs';
import { addScreen } from './currentweatherscroll.mjs';
import Setting from './utils/setting.mjs';
import { DateTime } from '../vendor/auto/luxon.mjs';
import { REGIONS, project } from './ukraine-alerts/map-data.mjs';
import {
	TYPE_TEXT, THREAT_TEXT, sanitizeSelection, saveSelection, loadSelection, durationSince, alertClass, loadAreas,
} from './ukraine-alerts/common.mjs';
import { playAlertTone, playClearTone } from './ukraine-alerts/sound.mjs';

const API_URL = 'api/ukraine-alerts';
const REFRESH_MS = 30_000;
// number of ticker lines this display can add
const TICKER_SLOTS = 5;
const SVG_NS = 'http://www.w3.org/2000/svg';
// warning banner durations
const ALERT_BANNER_MS = 3 * 60_000;
const CLEAR_BANNER_MS = 60_000;
// don't interrupt more often than this
const INTERRUPT_COOLDOWN_MS = 60_000;

// map frame size on screen (px), must match _ukraine-alerts.scss
const FRAME = { width: 435, height: 285 };
// smallest area to zoom to, in map units (keeps tiny Kyiv City from filling the screen)
const MIN_ZOOM_WIDTH = 150;

const TARGET_TEXT = {
	uav: 'UAV', cruise: 'Cruise Missile', ballistic: 'Ballistic', aviation: 'Aircraft', unknown: 'Target',
};
// short versions for the side panel
const TARGET_SHORT = {
	uav: 'UAV', cruise: 'Cruise', ballistic: 'Ballistic', aviation: 'Aircraft', unknown: 'Unknown',
};
const TARGET_SHAPES = {
	uav: 'M0,-6L5,5L0,2.5L-5,5Z',
	cruise: 'M0,-7L3,-2L1,-2L1,6L-1,6L-1,-2L-3,-2Z',
	ballistic: 'M0,-6L4,0L0,6L-4,0Z',
	aviation: 'M0,-6L1,-1L6,1L6,2L1,1.5L1,4L3,6L-3,6L-1,4L-1,1.5L-6,2L-6,1L-1,-1Z',
	unknown: 'M0,-4A4,4 0 1,1 0,4A4,4 0 1,1 0,-4Z',
};

// alert "rank" of a followed oblast, used to detect new alerts
const rankOf = (region) => {
	if (!region) return 0;
	if (region.status === 'full') return region.level === 'Red' ? 4 : 3;
	return region.level === 'Red' ? 2 : 1;
};

const padBox = ([x0, y0, x1, y1], fraction) => {
	const px = (x1 - x0) * fraction;
	const py = (y1 - y0) * fraction;
	return [x0 - px, y0 - py, x1 + px, y1 + py];
};

const unionBox = (boxes) => [
	Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])),
	Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3])),
];

// full-country view box, from the oblast bounding boxes
const COUNTRY_BOX = padBox(unionBox(Object.values(REGIONS).map((r) => r.bbox)), 0.01);

// expand a box to the frame aspect ratio and a minimum size
const fitBox = ([x0, y0, x1, y1]) => {
	const aspect = FRAME.width / FRAME.height;
	let w = Math.max(x1 - x0, MIN_ZOOM_WIDTH);
	let h = Math.max(y1 - y0, MIN_ZOOM_WIDTH / aspect);
	if (w / h > aspect) h = w / aspect; else w = h * aspect;
	const cx = (x0 + x1) / 2;
	const cy = (y0 + y1) / 2;
	return [cx - w / 2, cy - h / 2, w, h];
};

const viewBoxFor = (ids) => {
	if (ids.length === 0) return fitBox(COUNTRY_BOX);
	return fitBox(padBox(unionBox(ids.map((id) => REGIONS[id].bbox)), 0.12));
};

const intersects = (bbox, [vx, vy, vw, vh]) => bbox[2] >= vx && bbox[0] <= vx + vw && bbox[3] >= vy && bbox[1] <= vy + vh;

const svgEl = (name, attrs = {}) => {
	const el = document.createElementNS(SVG_NS, name);
	Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
	return el;
};

const sortedActive = (data, ids) => ids
	.filter((id) => data.regions[id])
	.sort((a, b) => {
		const ra = data.regions[a]; const rb = data.regions[b];
		// full before partial, red before yellow, then newest first (long-running front line alerts sink)
		const started = (r) => (r.since ? Date.parse(r.since) : 0);
		return rankOf(rb) - rankOf(ra) || started(rb) - started(ra) || REGIONS[a].short.localeCompare(REGIONS[b].short);
	});

// join names into ticker lines of a limited width
const wrapNames = (prefix, names, maxLength = 30) => {
	const lines = [];
	let line = prefix;
	names.forEach((name) => {
		const next = line === prefix ? `${line}${name}` : `${line}, ${name}`;
		if (next.length > maxLength && line !== prefix) {
			lines.push(line);
			line = `${prefix}${name}`;
		} else {
			line = next;
		}
	});
	if (line !== prefix) lines.push(line);
	return lines;
};

// oblast outlines are drawn on top of the area fills, built once from the oblast paths
const initBorders = (svg) => {
	const group = svg.querySelector('g.oblast-borders');
	if (group.childElementCount > 0) return;
	svg.querySelectorAll('g.oblasts path.oblast').forEach((path) => {
		group.append(svgEl('path', { d: path.getAttribute('d'), 'data-region-id': path.dataset.regionId }));
	});
};

// Kyiv local hour, for the night mute
const localHour = () => DateTime.local().setZone(timeZone() ?? 'Europe/Kyiv').hour;

// ---- display ----

class UkraineAlerts extends WeatherDisplay {
	constructor(navId, elemId) {
		super(navId, elemId, 'Air Raid Alerts', true);
		// keep running when the weather API is down (see navigation.mjs weatherFailed)
		this.independentOfWeather = true;
		this.selection = loadSelection();
		this.followedRanks = null;
		this.banner = null;
		this.lastInterrupt = 0;
		this.areas = {};
		this.setTiming();

		// background refresh so the ticker and map stay current between weather refreshes
		setInterval(() => this.refresh(), REFRESH_MS);
		document.addEventListener('DOMContentLoaded', () => {
			this.initSelectionUi();
			this.initSettings();
		});
		loadAreas().then((areas) => {
			this.areas = areas;
			if (this.active) this.drawCanvas();
		});

		// ticker lines, shown before the weather conditions
		[...Array(TICKER_SLOTS).keys()].reverse().forEach((i) => addScreen(() => this.tickerLines()[i], { first: true, independent: true }));
	}

	setTiming() {
		// country screen, then the zoomed selection if there is one
		this.timing.totalScreens = this.selection.length > 0 ? 2 : 1;
		this.timing.delay = 2;
		this.calcNavTiming();
	}

	async getData(weatherParameters) {
		if (!super.getData(weatherParameters)) return;
		const ok = await this.refresh();
		if (!ok && !this.data) {
			this.setStatus(STATUS.failed);
			this.getDataCallback(undefined);
			return;
		}
		this.getDataCallback();
		this.setStatus(STATUS.loaded);
	}

	async refresh() {
		try {
			const res = await fetch(API_URL, { cache: 'no-store' });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			this.data = await res.json();
			this.updateIndicator();
			this.checkForWarnings();
			if (this.active) this.drawCanvas();
			return true;
		} catch (e) {
			console.error('Ukraine alerts: fetch failed', e);
			if (this.data) this.data.stale = true;
			return false;
		}
	}

	updateIndicator() {
		// the "!!!" next to the display checkbox lights up when a followed oblast has an alert
		const alert = this.checkbox?.querySelector('.alert');
		if (!alert) return;
		const ids = this.selection.length > 0 ? this.selection : Object.keys(REGIONS);
		alert.classList.toggle('show', ids.some((id) => this.data?.regions?.[id]));
	}

	// ---- warning interrupt ----

	checkForWarnings() {
		if (!this.data?.regions || this.data.stale) return;
		const ranks = Object.fromEntries(this.selection.map((id) => [id, rankOf(this.data.regions[id])]));
		const previous = this.followedRanks;
		this.followedRanks = ranks;
		// first data after load (or after changing the selection) is the baseline
		if (!previous) return;

		const escalated = this.selection.filter((id) => previous[id] !== undefined && ranks[id] > previous[id]);
		const cleared = this.selection.filter((id) => previous[id] > 0 && ranks[id] === 0);
		if (escalated.length > 0) {
			const region = this.data.regions[escalated[0]];
			const type = TYPE_TEXT[region.types?.[0]] ?? 'Alert';
			const prefix = region.level === 'Yellow' ? 'Threat' : `${type} Alert`;
			const scope = region.status === 'partial' ? ' (part)' : '';
			this.warn('alert', `${prefix}: ${escalated.map((id) => REGIONS[id].short).join(', ')}${scope}`);
		} else if (cleared.length > 0) {
			this.warn('clear', `All Clear: ${cleared.map((id) => REGIONS[id].short).join(', ')}`);
		}
	}

	warn(kind, text) {
		if (!this.isEnabled) return;
		const now = Date.now();
		this.banner = { kind, text, until: now + (kind === 'alert' ? ALERT_BANNER_MS : CLEAR_BANNER_MS) };
		console.log(`Ukraine alerts: ${text}`);

		if (this.settings?.interrupt?.value !== false && now - this.lastInterrupt > INTERRUPT_COOLDOWN_MS && this.status === STATUS.loaded) {
			this.lastInterrupt = now;
			if (showDisplayNow(this) && this.selection.length > 0) {
				// go straight to the zoomed view of the followed oblasts
				this.navNext();
			}
		}

		const hour = localHour();
		const night = hour >= 22 || hour < 7;
		if (this.settings?.tone?.value && !(night && this.settings?.nightMute?.value)) {
			if (kind === 'alert') playAlertTone(); else playClearTone();
		}
		if (this.active) this.drawCanvas();
	}

	initSettings() {
		const container = document.querySelector('#ukraineAlertSettings');
		this.settings = {
			interrupt: new Setting('alertInterrupt', 'Interrupt the rotation on new alerts in my oblasts', 'checkbox', true, null, true),
			tone: new Setting('alertTone', 'Play a tone on new alerts / all clear', 'checkbox', false, null, true),
			nightMute: new Setting('alertNightMute', 'Mute the tone 22:00 - 07:00', 'checkbox', true, null, true),
		};
		if (container) container.append(...Object.values(this.settings).map((s) => s.generate()));
	}

	// ---- drawing ----

	async drawCanvas() {
		super.drawCanvas();
		if (!this.data || !this.elem) return;
		const zoomed = this.screenIndex === 1 && this.selection.length > 0;
		const svg = this.elem.querySelector('svg.ukraine-map');
		const { regions } = this.data;
		initBorders(svg);

		// zoom
		const viewBox = viewBoxFor(zoomed ? this.selection : []);
		svg.setAttribute('viewBox', viewBox.map((n) => n.toFixed(1)).join(' '));
		const unitsPerPx = viewBox[2] / FRAME.width;
		svg.classList.toggle('zoomed', zoomed);
		svg.classList.toggle('has-selection', this.selection.length > 0);
		this.elem.querySelector('.map-frame').classList.toggle('zoomed', zoomed);

		// districts / communities with an alert, drawn as real shapes when we have them
		const drawn = this.drawAreas(svg);

		// colour oblasts: full alerts are filled, partial ones are only hatched if their areas can't be drawn
		svg.querySelectorAll('g.oblasts path.oblast').forEach((path) => {
			const id = path.dataset.regionId;
			const region = regions[id];
			path.setAttribute('class', 'oblast');
			if (region?.status === 'full') {
				path.classList.add('alert', `alert-${alertClass(region)}`);
			} else if (region && !drawn.complete.has(id)) {
				path.classList.add('alert', `alert-${alertClass(region)}`, 'partial');
			}
			if (this.selection.includes(id)) path.classList.add('selected');
			// Kyiv City lies inside Kyiv Oblast: don't dim it when the oblast is followed
			if (id === '31' && this.selection.includes('14')) path.classList.add('inside-selected');
		});
		svg.querySelectorAll('g.oblast-borders path').forEach((path) => {
			path.classList.toggle('selected', this.selection.includes(path.dataset.regionId));
		});

		this.drawRaionBorders(svg, zoomed, viewBox);
		this.drawLabels(svg, zoomed, unitsPerPx);
		this.drawTargets(svg, unitsPerPx);

		// side panel
		let title = 'Ukraine';
		if (zoomed) title = this.selection.length === 1 ? REGIONS[this.selection[0]].short : 'My Regions';
		this.elem.querySelector('.map-title').textContent = title;
		this.drawList(zoomed);
		this.drawBanner();

		// footer status
		const updated = this.data.updated
			? DateTime.fromISO(this.data.updated).setZone(timeZone() ?? 'Europe/Kyiv').toFormat('HH:mm')
			: '--:--';
		const status = this.elem.querySelector('.update-status');
		status.textContent = this.data.stale ? `STALE ${updated}` : `Updated ${updated}`;
		status.classList.toggle('stale', !!this.data.stale);
		const credits = ['Alerts: ukrainealarm.com'];
		if (this.data.threatsSource === 'alerts.in.ua') credits.push('alerts.in.ua');
		if (this.data.targets?.length) credits.push('war-monitor.org');
		this.elem.querySelector('.credits').textContent = credits.join('  ');

		this.finishDraw();
	}

	// returns the set of oblasts whose alerted areas were all drawn
	drawAreas(svg) {
		const group = svg.querySelector('g.areas');
		group.innerHTML = '';
		const complete = new Set();
		Object.values(this.data.regions).forEach((region) => {
			const areas = region.areas ?? [];
			let allDrawn = areas.length > 0;
			// districts first, communities on top
			[...areas].sort((a, b) => (a.type === 'District' ? 0 : 1) - (b.type === 'District' ? 0 : 1)).forEach((area) => {
				const shape = this.areas[area.id];
				if (!shape) {
					allDrawn = false;
					return;
				}
				group.append(svgEl('path', {
					class: `area alert-${alertClass(area)}`, d: shape.d, 'data-region-id': area.id,
				}));
			});
			if (allDrawn) complete.add(region.id);
		});
		return { complete };
	}

	drawRaionBorders(svg, zoomed, viewBox) {
		const group = svg.querySelector('g.raion-borders');
		group.innerHTML = '';
		if (!zoomed) return;
		Object.values(this.areas).forEach((shape) => {
			if (shape.t !== 'D' || !intersects(shape.b, viewBox)) return;
			group.append(svgEl('path', { d: shape.d }));
		});
	}

	drawLabels(svg, zoomed, unitsPerPx) {
		const group = svg.querySelector('g.labels');
		group.innerHTML = '';
		if (!zoomed) return;
		const fontSize = 15 * unitsPerPx;
		const [vx, vy, vw, vh] = svg.getAttribute('viewBox').split(' ').map(Number);
		Object.values(REGIONS).forEach((region) => {
			const [x, y] = region.label;
			// skip labels that would be clipped by the frame edge
			const marginX = (region.short.length * 0.32 + 0.5) * fontSize;
			if (x < vx + marginX || x > vx + vw - marginX || y < vy + fontSize || y > vy + vh - fontSize) return;
			const selected = this.selection.includes(region.id);
			// wide views get crowded: only label followed oblasts
			if (!selected && unitsPerPx > 0.75) return;
			// skip Kyiv City label unless it is selected (it sits on top of Kyiv Oblast)
			if (region.id === '31' && !selected) return;
			// Kyiv City sits inside Kyiv Oblast: move the two labels apart
			let labelY = y;
			if (region.id === '31') labelY = y - fontSize * 0.9;
			if (region.id === '14' && this.selection.includes('31')) labelY = y + fontSize * 1.4;
			const text = svgEl('text', {
				x, y: labelY, 'font-size': fontSize.toFixed(2), class: selected ? 'selected' : '',
			});
			text.textContent = region.short;
			group.append(text);
		});
	}

	drawTargets(svg, unitsPerPx) {
		const group = svg.querySelector('g.targets');
		group.innerHTML = '';
		const targets = this.data.targets ?? [];
		const iconScale = 1.5 * unitsPerPx;

		targets.forEach((target) => {
			const [x, y] = project(target.lon, target.lat);
			const g = svgEl('g', { class: `target target-${target.cls}${target.stale ? ' stale' : ''}` });

			// trail (oldest first) up to the current position
			if (target.trail.length > 0) {
				const points = [...target.trail.map(([lat, lon]) => project(lon, lat)), [x, y]];
				g.append(svgEl('polyline', {
					class: 'trail', points: points.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' '),
				}));
			}
			// likely destination
			if (target.dest) {
				const [dx, dy] = project(target.dest.lon, target.dest.lat);
				g.append(svgEl('line', {
					class: 'dest', x1: x.toFixed(1), y1: y.toFixed(1), x2: dx.toFixed(1), y2: dy.toFixed(1),
				}));
			}

			// icon, rotated to the heading. Correct for the map's meridian convergence
			let rotation = 0;
			if (target.heading !== null) {
				const [nx, ny] = project(target.lon, target.lat + 0.1);
				const northOffset = (Math.atan2(nx - x, y - ny) * 180) / Math.PI;
				rotation = target.heading + northOffset;
			}
			g.append(svgEl('path', {
				class: 'icon',
				d: TARGET_SHAPES[target.cls] ?? TARGET_SHAPES.unknown,
				transform: `translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${rotation.toFixed(0)}) scale(${iconScale.toFixed(3)})`,
			}));
			if (target.n > 1) {
				const label = svgEl('text', {
					class: 'count', x: (x + 7 * iconScale).toFixed(1), y: (y - 4 * iconScale).toFixed(1), 'font-size': (14 * unitsPerPx).toFixed(2),
				});
				label.textContent = `x${target.n}`;
				g.append(label);
			}
			group.append(g);
		});
	}

	drawList(zoomed) {
		const list = this.elem.querySelector('.alert-list');
		list.innerHTML = '';
		const { regions } = this.data;
		const ids = zoomed ? this.selection : Object.keys(regions).filter((id) => REGIONS[id]);
		const active = sortedActive(this.data, ids);

		// summary block at the bottom of the panel: flying targets, or threat types by number of oblasts
		const summary = this.elem.querySelector('.target-summary');
		summary.innerHTML = '';
		const summaryRows = [];
		const targets = this.data.targets ?? [];
		const targetCounts = targets.reduce((acc, t) => ({ ...acc, [t.cls]: (acc[t.cls] ?? 0) + t.n }), {});
		Object.entries(targetCounts).forEach(([cls, n]) => summaryRows.push({ cls: `target-${cls}`, text: `${n} ${TARGET_SHORT[cls] ?? cls}` }));
		// threat types by number of oblasts (country view, unless flying targets already fill the block)
		if (!zoomed && summaryRows.length === 0) {
			const threatCounts = {};
			active.forEach((id) => (regions[id].threats ?? []).forEach((t) => { threatCounts[t] = (threatCounts[t] ?? 0) + 1; }));
			Object.entries(threatCounts).forEach(([t, n]) => summaryRows.push({ cls: 'threat', text: `${THREAT_TEXT[t] ?? 'Threat'}`, info: `${n} obl` }));
		}
		summaryRows.slice(0, 4).forEach(({ cls, text, info }) => {
			const row = document.createElement('div');
			row.className = `row ${cls}`;
			const name = document.createElement('span');
			name.textContent = text;
			row.append(name);
			if (info) {
				const right = document.createElement('span');
				right.textContent = info;
				row.append(right);
			}
			summary.append(row);
		});

		// panel fits 13 rows: heading + alerts + summary (+1 spacer)
		const usedBySummary = Math.min(4, summaryRows.length);
		const maxRows = 12 - (usedBySummary > 0 ? usedBySummary + 1 : 0);

		const heading = document.createElement('div');
		heading.className = 'list-heading';
		heading.textContent = active.length === 0 ? 'No Alerts' : `${active.length} Active`;
		list.append(heading);

		const rows = [];
		const ordered = zoomed ? ids.slice().sort((a, b) => active.indexOf(a) - active.indexOf(b)) : active;
		ordered.forEach((id) => {
			const region = regions[id];
			let info = 'Clear';
			if (region?.status === 'partial') info = 'Part';
			else if (region) info = durationSince(region.since);
			rows.push({ cls: region ? `alert-${alertClass(region)}` : 'clear', name: REGIONS[id].short, info });
			// zoomed view: threat types under each followed oblast
			if (zoomed && region?.threats?.length) {
				// as many threat names as fit the panel
				const names = region.threats.map((t) => THREAT_TEXT[t] ?? 'Threat');
				let text = names[0];
				names.slice(1).forEach((n) => { if (`${text}, ${n}`.length <= 18) text = `${text}, ${n}`; });
				rows.push({ cls: 'threat sub', name: text });
			}
		});

		rows.slice(0, maxRows).forEach(({ cls, name, info }) => {
			const row = document.createElement('div');
			row.className = `row ${cls}`;
			const nameElem = document.createElement('span');
			nameElem.className = 'name';
			nameElem.textContent = name;
			row.append(nameElem);
			if (info !== undefined) {
				const infoElem = document.createElement('span');
				infoElem.className = 'info';
				infoElem.textContent = info;
				row.append(infoElem);
			}
			list.append(row);
		});
		if (rows.length > maxRows) {
			// replace the last row with a "more" line
			list.lastChild.remove();
			const more = document.createElement('div');
			more.className = 'row more';
			more.textContent = `+${rows.length - maxRows + 1} more`;
			list.append(more);
		}
	}

	drawBanner() {
		const banner = this.elem.querySelector('.alert-banner');
		const show = this.banner && this.banner.until > Date.now();
		banner.classList.toggle('show', !!show);
		if (!show) return;
		banner.classList.toggle('clear', this.banner.kind === 'clear');
		banner.textContent = this.banner.text;
	}

	// lines for the bottom ticker (max TICKER_SLOTS)
	tickerLines() {
		if (!this.isEnabled || !this.data?.regions) return [];
		const { regions } = this.data;
		const following = this.selection.length > 0;
		const ids = following ? this.selection : Object.keys(regions).filter((id) => REGIONS[id]);
		const active = sortedActive(this.data, ids);
		const alertLines = [];

		if (active.length === 0) {
			if (following) alertLines.push({ text: 'No alerts in your regions', className: 'all-clear' });
		} else {
			// group by main alert type
			const byType = {};
			active.forEach((id) => {
				const type = regions[id].types[0] ?? 'UNKNOWN';
				byType[type] = [...(byType[type] ?? []), REGIONS[id].short];
			});
			Object.entries(byType).forEach(([type, names]) => {
				wrapNames(`${TYPE_TEXT[type] ?? 'Alert'}: `, names).forEach((text) => alertLines.push({ text, className: 'hazard' }));
			});
		}

		// most dangerous threat type among the (followed) oblasts
		const threatLines = [];
		const byThreat = {};
		active.forEach((id) => (regions[id].threats ?? []).slice(0, 1).forEach((t) => {
			byThreat[t] = [...(byThreat[t] ?? []), REGIONS[id].short];
		}));
		Object.entries(byThreat).slice(0, 1).forEach(([t, names]) => {
			threatLines.push({ text: wrapNames(`${THREAT_TEXT[t] ?? 'Threat'}: `, names, 32)[0], className: 'hazard' });
		});

		// flying targets heading somewhere (biggest groups first)
		const targetLines = (this.data.targets ?? [])
			.filter((t) => !t.stale)
			.sort((a, b) => b.n - a.n)
			.slice(0, 1)
			.map((t) => {
				const where = t.dest?.place || t.place;
				return { text: `${t.n > 1 ? `${t.n} ` : ''}${TARGET_TEXT[t.cls]}${where ? ` > ${where}` : ''}`.slice(0, 32), className: 'hazard' };
			});

		const extra = [...threatLines, ...targetLines];
		return [...alertLines.slice(0, TICKER_SLOTS - extra.length), ...extra];
	}

	// checkbox grid on the settings page
	initSelectionUi() {
		const container = document.querySelector('#ukraineAlertRegions');
		if (!container) return;
		const sorted = Object.values(REGIONS).sort((a, b) => a.short.localeCompare(b.short));
		sorted.forEach((region) => {
			const label = document.createElement('label');
			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			// no id on purpose: the share link only collects checkboxes with an id
			checkbox.name = 'ukraine-alert-region';
			checkbox.value = region.id;
			checkbox.checked = this.selection.includes(region.id);
			checkbox.addEventListener('change', () => this.selectionChange());
			const span = document.createElement('span');
			span.textContent = region.name;
			label.append(checkbox, span);
			container.append(label);
		});
	}

	selectionChange() {
		const checked = [...document.querySelectorAll('#ukraineAlertRegions input:checked')].map((c) => c.value);
		this.selection = sanitizeSelection(checked);
		saveSelection(this.selection);
		// new baseline: don't treat newly followed oblasts as new alerts
		this.followedRanks = null;
		this.checkForWarnings();
		this.setTiming();
		this.updateIndicator();
		if (this.active) this.drawCanvas();
	}
}

registerDisplay(new UkraineAlerts(14, 'ukraine-alerts'));
