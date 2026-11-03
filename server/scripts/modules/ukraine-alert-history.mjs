// Ukraine air raid alert history: 24 hour timeline per followed oblast
// Data: GET /api/ukraine-alerts/history (server records alerts + backfills from ukrainealarm)

import STATUS from './status.mjs';
import WeatherDisplay from './weatherdisplay.mjs';
import { registerDisplay, timeZone } from './navigation.mjs';
import { DateTime } from '../vendor/auto/luxon.mjs';
import { REGIONS } from './ukraine-alerts/map-data.mjs';
import { loadSelection, onSelectionChange, formatDuration } from './ukraine-alerts/common.mjs';

const API_URL = 'api/ukraine-alerts/history';
const HOURS = 24;
const REFRESH_MS = 5 * 60_000;
const MAX_ROWS = 8;
// timeline geometry (px), must match _ukraine-alerts.scss
const BAR = { left: 140, width: 380 };

const zone = () => timeZone() ?? 'Europe/Kyiv';

class UkraineAlertHistory extends WeatherDisplay {
	constructor(navId, elemId) {
		super(navId, elemId, 'Alert History', true);
		this.independentOfWeather = true;
		this.selection = loadSelection();
		this.timing.totalScreens = 1;
		this.timing.delay = 2;

		setInterval(() => this.refresh(), REFRESH_MS);
		onSelectionChange((selection) => {
			this.selection = selection;
			this.refresh();
		});
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
			const url = new URL(API_URL, document.baseURI);
			url.searchParams.set('hours', HOURS);
			if (this.selection.length > 0) url.searchParams.set('regions', this.selection.join(','));
			const res = await fetch(url, { cache: 'no-store' });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			this.data = await res.json();
			// nothing to show (no followed oblasts and nothing recorded yet): skip the screen
			this.timing.totalScreens = Object.keys(this.data.regions ?? {}).length > 0 ? 1 : 0;
			this.calcNavTiming();
			if (this.active) this.drawCanvas();
			return true;
		} catch (e) {
			console.error('Ukraine alert history: fetch failed', e);
			return false;
		}
	}

	async drawCanvas() {
		super.drawCanvas();
		if (!this.data || !this.elem) return;
		const { from, to, regions } = this.data;
		const span = to - from;
		const x = (t) => ((t - from) / span) * BAR.width;

		this.elem.querySelector('.history-title').textContent = this.data.followed ? `Past ${HOURS} Hours` : `Busiest Oblasts, ${HOURS}h`;

		const rowsElem = this.elem.querySelector('.history-rows');
		rowsElem.innerHTML = '';
		const ids = (this.data.followed ? this.selection.filter((id) => regions[id]) : Object.keys(regions)).slice(0, MAX_ROWS);
		// few rows: space them out
		rowsElem.classList.toggle('roomy', ids.length <= 5);

		ids.forEach((id) => {
			const history = regions[id];
			const row = document.createElement('div');
			row.className = 'history-row';

			const name = document.createElement('div');
			name.className = 'name';
			name.textContent = REGIONS[id]?.short ?? id;

			const bar = document.createElement('div');
			bar.className = 'bar';
			const piece = (cls, s, e) => {
				const el = document.createElement('div');
				el.className = cls;
				el.style.left = `${x(s).toFixed(1)}px`;
				el.style.width = `${Math.max(1, x(e) - x(s)).toFixed(1)}px`;
				bar.append(el);
			};
			history.gaps.forEach(([s, e]) => piece('gap', s, e));
			history.segments.forEach((seg) => piece(`seg ${seg.k}-${seg.l === 'Red' ? 'red' : 'yellow'}`, seg.s, seg.e));

			const stats = document.createElement('div');
			stats.className = 'stats';
			stats.textContent = history.count > 0 ? `${history.count}x ${formatDuration(history.totalMs)}` : 'None';

			row.append(name, bar, stats);
			rowsElem.append(row);
		});

		// hour ticks every 6 hours (local time) + "now"
		const axis = this.elem.querySelector('.axis');
		axis.innerHTML = '';
		let tick = DateTime.fromMillis(from).setZone(zone()).startOf('hour');
		while (tick.hour % 6 !== 0) tick = tick.plus({ hours: 1 });
		// leave room for the "Now" label at the end
		for (; tick.toMillis() < to - 2.5 * 3600_000; tick = tick.plus({ hours: 6 })) {
			const label = document.createElement('div');
			label.className = 'tick';
			label.style.left = `${x(tick.toMillis()).toFixed(1)}px`;
			label.textContent = tick.toFormat('HH');
			axis.append(label);
		}
		const now = document.createElement('div');
		now.className = 'tick now';
		now.style.left = `${BAR.width}px`;
		now.textContent = 'Now';
		axis.append(now);

		this.finishDraw();
	}
}

registerDisplay(new UkraineAlertHistory(15, 'ukraine-alert-history'));
