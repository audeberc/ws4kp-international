// Alert history for the "Alert History" display.
//
// Two sources, merged:
//  1. a recorder: every successful alert poll is turned into per-oblast intervals
//     (full / partial, level, main type) and persisted to a JSON file, so history survives restarts.
//     It only knows about time when polling was running ("coverage").
//  2. a backfill: map.ukrainealarm.com/api/data/lastAlerts/{oblastId} (public JSON, last 20 alarms
//     of the oblast and its districts/communities), fetched at most every 10 min per oblast.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

const RETENTION_MS = 48 * 3600_000;
// polls further apart than this are a coverage gap
const GAP_MS = 3 * 60_000;
const SAVE_DEBOUNCE_MS = 30_000;
const COVERAGE_SAVE_MS = 5 * 60_000;
const BACKFILL_TTL_MS = 10 * 60_000;
const BACKFILL_URL = 'https://map.ukrainealarm.com/api/data/lastAlerts/';
const MAX_BACKFILL_PER_REQUEST = 6;

const RANK = {
	'full:Red': 4, 'full:Yellow': 3, 'partial:Red': 2, 'partial:Yellow': 1,
};
const rank = (iv) => RANK[`${iv.k}:${iv.l}`] ?? 0;

const log = (...args) => console.log('[ukraine-alerts history]', ...args);

// state of one normalized oblast record -> interval key, or null when clear
const stateOf = (region) => {
	if (!region) return null;
	return { k: region.status === 'full' ? 'full' : 'partial', l: region.level === 'Red' ? 'Red' : 'Yellow', t: region.types?.[0] ?? 'AIR' };
};
const sameState = (a, b) => a && b && a.k === b.k && a.l === b.l && a.t === b.t;

// merge overlapping intervals into a flat timeline: highest rank wins
const mergeIntervals = (intervals, from, to) => {
	const clipped = intervals
		.map((iv) => ({ ...iv, s: Math.max(iv.s, from), e: Math.min(iv.e ?? to, to) }))
		.filter((iv) => iv.e > iv.s);
	const bounds = [...new Set(clipped.flatMap((iv) => [iv.s, iv.e]))].sort((a, b) => a - b);
	const segments = [];
	for (let i = 0; i < bounds.length - 1; i += 1) {
		const mid = (bounds[i] + bounds[i + 1]) / 2;
		const best = clipped.filter((iv) => iv.s <= mid && iv.e >= mid).sort((a, b) => rank(b) - rank(a))[0];
		if (best) {
			const last = segments[segments.length - 1];
			if (last && last.e === bounds[i] && last.k === best.k && last.l === best.l && last.t === best.t) {
				last.e = bounds[i + 1];
			} else {
				segments.push({
					s: bounds[i], e: bounds[i + 1], k: best.k, l: best.l, t: best.t,
				});
			}
		}
	}
	return segments;
};

// union of [s, e] ranges
const unionRanges = (ranges) => {
	const sorted = ranges.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
	const out = [];
	sorted.forEach(([s, e]) => {
		const last = out[out.length - 1];
		if (last && s <= last[1]) last[1] = Math.max(last[1], e);
		else out.push([s, e]);
	});
	return out;
};

const createHistory = ({ file, userAgent }) => {
	let state = {
		version: 1, lastSeen: 0, coverage: [], open: {}, closed: {},
	};
	let saveTimer = null;
	let lastSaveAt = 0;
	const backfillCache = new Map(); // oblastId -> { at, intervals, coverageFrom }

	const save = async () => {
		saveTimer = null;
		lastSaveAt = Date.now();
		try {
			await mkdir(path.dirname(file), { recursive: true });
			const tmp = `${file}.tmp`;
			await writeFile(tmp, JSON.stringify(state));
			await rename(tmp, file);
		} catch (e) {
			log(`save failed: ${e.message}`);
		}
	};
	const scheduleSave = () => {
		if (!saveTimer) saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
	};

	const load = async () => {
		try {
			const loaded = JSON.parse(await readFile(file, 'utf8'));
			if (loaded?.version === 1) state = loaded;
			// intervals left open by a previous run end when that run was last seen
			if (Date.now() - state.lastSeen > GAP_MS) {
				Object.entries(state.open).forEach(([id, iv]) => {
					(state.closed[id] ??= []).push({ ...iv, e: state.lastSeen });
				});
				state.open = {};
			}
			log(`loaded ${file}`);
		} catch (e) {
			if (e.code !== 'ENOENT') log(`load failed: ${e.message}`);
		}
	};
	const loaded = load();

	const prune = (now) => {
		const cutoff = now - RETENTION_MS;
		Object.keys(state.closed).forEach((id) => {
			state.closed[id] = state.closed[id].filter((iv) => iv.e > cutoff);
			if (state.closed[id].length === 0) delete state.closed[id];
		});
		state.coverage = state.coverage.filter(([, e]) => e > cutoff);
	};

	// record one poll result (normalized regions)
	const record = async (regions, now = Date.now()) => {
		await loaded;
		// coverage
		const last = state.coverage[state.coverage.length - 1];
		if (last && now - last[1] <= GAP_MS) last[1] = now;
		else state.coverage.push([now, now]);

		let changed = false;
		const ids = new Set([...Object.keys(state.open), ...Object.keys(regions)]);
		ids.forEach((id) => {
			const current = stateOf(regions[id]);
			const previous = state.open[id];
			if (sameState(current, previous)) return;
			if (previous) (state.closed[id] ??= []).push({ ...previous, e: now });
			if (current) state.open[id] = { ...current, s: now };
			else delete state.open[id];
			changed = true;
		});
		state.lastSeen = now;
		prune(now);
		// save on changes, and every few minutes so coverage survives a restart
		if (changed || now - lastSaveAt > COVERAGE_SAVE_MS) scheduleSave();
	};

	const backfill = async (oblastId) => {
		const cached = backfillCache.get(oblastId);
		if (cached && Date.now() - cached.at < BACKFILL_TTL_MS) return cached;
		let result = { at: Date.now(), intervals: [], coverageFrom: null };
		try {
			const res = await fetch(`${BACKFILL_URL}${encodeURIComponent(oblastId)}`, {
				headers: { Accept: 'application/json', 'User-Agent': userAgent },
				signal: AbortSignal.timeout(10_000),
			});
			if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			const alarms = (Array.isArray(data) ? data : []).flatMap((r) => r.alarms ?? []);
			const intervals = alarms.map((a) => {
				const s = Date.parse(a.startDate);
				const ended = a.endDate && !a.endDate.startsWith('0001');
				return {
					s,
					e: ended ? Date.parse(a.endDate) : null,
					k: String(a.regionId) === String(oblastId) ? 'full' : 'partial',
					l: a.alertLevel === 'Yellow' ? 'Yellow' : 'Red',
					t: a.alertType ?? 'AIR',
				};
			}).filter((iv) => Number.isFinite(iv.s));
			// the list is capped: nothing is known before its oldest alarm
			const coverageFrom = intervals.length > 0 ? Math.min(...intervals.map((iv) => iv.s)) : null;
			result = { at: Date.now(), intervals, coverageFrom };
		} catch (e) {
			log(`backfill ${oblastId} failed: ${e.message}`);
			// keep a stale result rather than nothing
			if (cached) result = { ...cached, at: Date.now() };
		}
		backfillCache.set(oblastId, result);
		return result;
	};

	// history for the given oblasts over the last `hours`
	const query = async (ids, { hours = 24, useBackfill = true } = {}) => {
		await loaded;
		const to = Date.now();
		const from = to - hours * 3600_000;
		const out = {};
		const backfills = useBackfill
			? await Promise.all(ids.slice(0, MAX_BACKFILL_PER_REQUEST).map((id) => backfill(id)))
			: [];

		ids.forEach((id, i) => {
			const recorded = [...(state.closed[id] ?? []), ...(state.open[id] ? [{ ...state.open[id], e: null }] : [])];
			const bf = backfills[i];
			const segments = mergeIntervals([...recorded, ...(bf?.intervals ?? [])], from, to);
			const covered = unionRanges([
				...state.coverage.map(([s, e]) => [s, e + 60_000]),
				...(bf?.coverageFrom ? [[bf.coverageFrom, to]] : []),
			].map(([s, e]) => [Math.max(s, from), Math.min(e, to)]));
			// gaps = window minus covered
			const gaps = [];
			let cursor = from;
			covered.forEach(([s, e]) => {
				if (s > cursor) gaps.push([cursor, s]);
				cursor = Math.max(cursor, e);
			});
			if (cursor < to) gaps.push([cursor, to]);

			// stats: separate alerts = runs of non-clear time
			let count = 0;
			let total = 0;
			let fullTotal = 0;
			segments.forEach((seg, j) => {
				total += seg.e - seg.s;
				if (seg.k === 'full') fullTotal += seg.e - seg.s;
				if (j === 0 || segments[j - 1].e !== seg.s) count += 1;
			});
			out[id] = {
				segments, gaps, count, totalMs: total, fullMs: fullTotal,
			};
		});
		return { from, to, regions: out };
	};

	// oblasts with the most alert time in the recorder (used when nothing is followed)
	const busiest = async (limit, hours = 24) => {
		const { regions } = await query([...new Set([...Object.keys(state.closed), ...Object.keys(state.open)])], { hours, useBackfill: false });
		return Object.entries(regions)
			.filter(([, r]) => r.totalMs > 0)
			.sort((a, b) => b[1].fullMs - a[1].fullMs || b[1].totalMs - a[1].totalMs)
			.slice(0, limit)
			.map(([id]) => id);
	};

	const flush = async () => {
		if (saveTimer) clearTimeout(saveTimer);
		await save();
	};

	return {
		record, query, busiest, flush,
	};
};

export default createHistory;
export { mergeIntervals, unionRanges };
