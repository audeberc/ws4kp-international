// Ukraine air-raid alert service.
// One shared, cached upstream poll for every connected display.
//   GET /api/ukraine-alerts            current alerts (+ threat types, flying targets)
//   GET /api/ukraine-alerts/history    alert timeline for oblasts (?regions=14,31&hours=24)
//
// Environment:
//   UKRAINEALARM_API_KEY          official api.ukrainealarm.com key (preferred alert source)
//   UKRAINE_ALERTS_PROVIDER       auto (default) | official | mapupdate
//   ALERTS_IN_UA_TOKEN            alerts.in.ua token, adds threat types (drones, ballistic...) (optional)
//   WARMONITOR_API_KEY            operator-granted key for war-monitor.org flying targets (optional)
//   NEPTUN_ENABLED                1 = flying targets + threat types from the open NEPTUN stream (neptun.in.ua, optional)
//   NEPTUN_STREAM_URL             override the NEPTUN stream (default wss://neptun.in.ua/api/v1/stream?v=2)
//   UKRAINE_ALERTS_HISTORY_FILE   where history is saved (default data/ukraine-alerts-history.json)
//   UKRAINE_ALERTS_ALWAYS_POLL    1 = keep polling (and recording history) even when no display is open
//   UKRAINE_ALERTS_FIXTURE        path to a JSON file { alerts, threats, targets, neptun, history } served instead of live data
//   UKRAINE_ALERTS_USER_AGENT     override the User-Agent sent upstream (default "AirWeather/1.0")

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
	normalizeAlerts, normalizeTargets, normalizeThreats, mergeThreats, normalizeNeptunTargets, neptunThreats, combineThreats,
} from './normalize.mjs';
import createOfficialProvider from './providers/official.mjs';
import createMapUpdateProvider from './providers/mapupdate.mjs';
import createWarMonitorProvider from './providers/warmonitor.mjs';
import createAlertsInUaProvider from './providers/alertsinua.mjs';
import createNeptunProvider from './providers/neptun.mjs';
import createHistory, { mergeIntervals } from './history.mjs';

const TICK_MS = 2_000;
// stop polling upstream when no display has asked for data for this long
const IDLE_MS = 5 * 60_000;
// data older than this is flagged stale
const STALE_MS = 2 * 60_000;
// after the official API fails in auto mode, use the fallback for this long
const OFFICIAL_BACKOFF_MS = 10 * 60_000;
const VALID_ID = /^\d{1,5}$/;

const log = (...args) => console.log('[ukraine-alerts]', ...args);

const createUkraineAlertsService = (env = process.env) => {
	const userAgent = env.UKRAINE_ALERTS_USER_AGENT || 'AirWeather/1.0';
	const mode = (env.UKRAINE_ALERTS_PROVIDER || 'auto').toLowerCase();
	const fixturePath = env.UKRAINE_ALERTS_FIXTURE ? path.resolve(env.UKRAINE_ALERTS_FIXTURE) : null;
	const alwaysPoll = env.UKRAINE_ALERTS_ALWAYS_POLL === '1' || env.UKRAINE_ALERTS_ALWAYS_POLL === 'true';

	const official = env.UKRAINEALARM_API_KEY ? createOfficialProvider({ apiKey: env.UKRAINEALARM_API_KEY, userAgent }) : null;
	const mapUpdate = createMapUpdateProvider({ userAgent });
	const warMonitor = env.WARMONITOR_API_KEY ? createWarMonitorProvider({ apiKey: env.WARMONITOR_API_KEY, userAgent }) : null;
	const alertsInUa = env.ALERTS_IN_UA_TOKEN ? createAlertsInUaProvider({ token: env.ALERTS_IN_UA_TOKEN, userAgent }) : null;
	const neptunOn = ['1', 'true', 'yes'].includes(String(env.NEPTUN_ENABLED ?? '').toLowerCase()) || !!env.NEPTUN_STREAM_URL;
	const neptun = neptunOn ? createNeptunProvider({ streamUrl: env.NEPTUN_STREAM_URL || undefined, userAgent, log }) : null;
	// NEPTUN wins for flying targets when both are configured (war-monitor still fills in while NEPTUN has no data)
	const history = createHistory({
		file: path.resolve(env.UKRAINE_ALERTS_HISTORY_FILE || 'data/ukraine-alerts-history.json'),
		userAgent,
	});

	if (mode === 'official' && !official) log('UKRAINE_ALERTS_PROVIDER=official but UKRAINEALARM_API_KEY is not set');
	log([
		`alerts: ${fixturePath ? `fixture ${fixturePath}` : mode}${official ? ' (official key set)' : ''}`,
		`threats: ${[alertsInUa && 'alerts.in.ua', neptun && 'neptun'].filter(Boolean).join(' + ') || 'reasons only'}`,
		`targets: ${[neptun && 'neptun', warMonitor && 'war-monitor'].filter(Boolean).join(', then ') || 'off'}`,
		`polling: ${alwaysPoll ? 'always' : 'while displays are open'}`,
	].join('; '));

	const state = {
		source: null,
		updated: null, // last successful upstream alert fetch
		regions: {},
		error: null,
		threats: {}, // oblastId -> threat types (alerts.in.ua)
		threatsUpdated: null,
		threatsError: null,
		targets: [],
		targetsUpdated: null,
		targetsError: null,
	};

	let lastRequest = 0;
	let lastAlertsAttempt = 0;
	let lastTargetsAttempt = 0;
	let lastThreatsAttempt = 0;
	let officialBackoffUntil = 0;
	let timer = null;
	let active = false;
	let firstResult = null;

	const pickAlertProvider = () => {
		if (mode === 'mapupdate') return mapUpdate;
		if (mode === 'official') return official;
		if (official && Date.now() >= officialBackoffUntil) return official;
		return mapUpdate;
	};

	const pollAlerts = async () => {
		const provider = pickAlertProvider();
		if (!provider) return;
		lastAlertsAttempt = Date.now();
		try {
			const { alerts, changed } = await provider.fetchAlerts();
			if (changed || state.source !== provider.name) {
				state.regions = normalizeAlerts(alerts);
				log(`${provider.name}: ${Object.keys(state.regions).length} oblasts with alerts`);
			}
			state.source = provider.name;
			state.updated = new Date().toISOString();
			state.error = null;
			await history.record(state.regions);
		} catch (e) {
			state.error = e.message;
			log(`${provider.name} failed: ${e.message}`);
			if (provider === official && mode === 'auto') {
				officialBackoffUntil = Date.now() + OFFICIAL_BACKOFF_MS;
				log('falling back to mapUpdate for 10 min');
				await pollAlerts();
			}
		}
	};

	const pollThreats = async () => {
		if (!alertsInUa) return;
		lastThreatsAttempt = Date.now();
		try {
			const { alerts, changed } = await alertsInUa.fetchThreats();
			if (changed) state.threats = normalizeThreats(alerts);
			state.threatsUpdated = new Date().toISOString();
			state.threatsError = null;
		} catch (e) {
			state.threatsError = e.message;
			log(`alerts.in.ua failed: ${e.message}`);
		}
	};

	const pollTargets = async () => {
		if (!warMonitor) return;
		lastTargetsAttempt = Date.now();
		try {
			const { targets, changed } = await warMonitor.fetchTargets();
			if (changed) state.targets = normalizeTargets(targets);
			state.targetsUpdated = new Date().toISOString();
			state.targetsError = null;
		} catch (e) {
			state.targetsError = e.message;
			log(`war-monitor failed: ${e.message}`);
		}
	};

	// NEPTUN pushes over a socket; normalize only when it changed
	let neptunVersion = -1;
	let neptunCache = { targets: [], threats: {} };
	const neptunData = () => {
		if (!neptun) return neptunCache;
		if (neptun.version !== neptunVersion) {
			neptunVersion = neptun.version;
			const raw = neptun.threats;
			neptunCache = { targets: normalizeNeptunTargets(raw), threats: neptunThreats(raw) };
		}
		return neptunCache;
	};
	const neptunLive = () => !!neptun?.updated && Date.now() - Date.parse(neptun.updated) < STALE_MS;

	const tick = async () => {
		const now = Date.now();
		const jobs = [];
		if (neptun) jobs.push(neptun.tick().catch((e) => log(`neptun failed: ${e.message}`)));
		const alertProvider = pickAlertProvider();
		if (alertProvider && now - lastAlertsAttempt >= alertProvider.minIntervalMs) jobs.push(pollAlerts());
		if (alertsInUa && now - lastThreatsAttempt >= alertsInUa.minIntervalMs) jobs.push(pollThreats());
		if (warMonitor && now - lastTargetsAttempt >= warMonitor.minIntervalMs) jobs.push(pollTargets());
		await Promise.all(jobs);
	};

	const loop = async () => {
		if (!alwaysPoll && Date.now() - lastRequest > IDLE_MS) {
			active = false;
			neptun?.stop();
			log('idle, polling paused');
			return;
		}
		try { await tick(); } catch (e) { log(`tick error: ${e.message}`); }
		timer = setTimeout(loop, TICK_MS);
	};

	const ensurePolling = async () => {
		lastRequest = Date.now();
		if (active) {
			// a display asking during the very first fetch waits for it too
			if (firstResult) await firstResult;
			return;
		}
		active = true;
		log('polling started');
		neptun?.start();
		// the stream's first snapshot usually lands within a second
		firstResult = (neptun ? neptun.waitForData(3_000) : Promise.resolve())
			.then(() => tick())
			.catch((e) => log(`tick error: ${e.message}`))
			.then(() => {
				firstResult = null;
				timer = setTimeout(loop, TICK_MS);
			});
		await firstResult;
	};
	if (alwaysPoll && !fixturePath) ensurePolling();

	const withThreats = (regions, threats) => mergeThreats(structuredClone(regions), threats);

	const snapshot = () => {
		const age = state.updated ? Date.now() - Date.parse(state.updated) : Infinity;
		const nep = neptunData();
		const useNeptunTargets = neptun && (neptunLive() || !warMonitor);
		const threatsSources = [alertsInUa && alertsInUa.name, neptun && neptunLive() && neptun.name].filter(Boolean);
		return {
			source: state.source,
			updated: state.updated,
			stale: age > STALE_MS,
			error: state.error,
			regions: withThreats(state.regions, combineThreats(state.threats, neptunLive() ? nep.threats : null)),
			threatsSource: threatsSources.join(', ') || null,
			threatsUpdated: state.threatsUpdated ?? neptun?.updated ?? null,
			threatsError: state.threatsError,
			targets: useNeptunTargets ? nep.targets : state.targets,
			targetsSource: (useNeptunTargets && neptun.name) || (warMonitor ? warMonitor.name : null),
			targetsUpdated: useNeptunTargets ? neptun.updated : state.targetsUpdated,
			targetsError: useNeptunTargets ? neptun.error : state.targetsError,
		};
	};

	const readFixture = async () => JSON.parse(await readFile(fixturePath, 'utf8'));

	const fixtureSnapshot = async () => {
		const fixture = await readFixture();
		return {
			source: 'fixture',
			updated: new Date().toISOString(),
			stale: !!fixture.stale,
			error: null,
			regions: withThreats(normalizeAlerts(fixture.alerts), combineThreats(normalizeThreats(fixture.threats), neptunThreats(fixture.neptun))),
			threatsSource: [fixture.threats && 'fixture', fixture.neptun && 'neptun'].filter(Boolean).join(', ') || null,
			threatsUpdated: fixture.threats ? new Date().toISOString() : null,
			threatsError: null,
			targets: fixture.neptun ? normalizeNeptunTargets(fixture.neptun) : normalizeTargets(fixture.targets),
			targetsSource: (fixture.neptun && 'neptun') || (fixture.targets ? 'fixture' : null),
			targetsUpdated: fixture.targets || fixture.neptun ? new Date().toISOString() : null,
			targetsError: null,
		};
	};

	// fixture history: { "14": [{ "s": -6, "e": -4, "k": "full", "l": "Red" }] } with times in hours relative to now
	const fixtureHistory = async (ids, hours) => {
		const fixture = await readFixture();
		const to = Date.now();
		const from = to - hours * 3600_000;
		const hour = (h) => to + h * 3600_000;
		const regions = {};
		const all = Object.keys(fixture.history ?? {});
		(ids.length ? ids : all).forEach((id) => {
			const intervals = (fixture.history?.[id] ?? []).map((iv) => ({
				s: hour(iv.s), e: iv.e === null || iv.e === undefined ? null : hour(iv.e), k: iv.k ?? 'full', l: iv.l ?? 'Red', t: iv.t ?? 'AIR',
			}));
			const segments = mergeIntervals(intervals, from, to);
			let count = 0;
			let totalMs = 0;
			let fullMs = 0;
			segments.forEach((seg, j) => {
				totalMs += seg.e - seg.s;
				if (seg.k === 'full') fullMs += seg.e - seg.s;
				if (j === 0 || segments[j - 1].e !== seg.s) count += 1;
			});
			const gaps = (fixture.historyGaps?.[id] ?? []).map(([s, e]) => [hour(s), hour(e)]);
			regions[id] = {
				segments, gaps, count, totalMs, fullMs,
			};
		});
		return { from, to, regions };
	};

	const handler = async (req, res) => {
		res.set('Cache-Control', 'no-store');
		try {
			if (fixturePath) {
				res.json(await fixtureSnapshot());
				return;
			}
			await ensurePolling();
			res.json(snapshot());
		} catch (e) {
			res.status(500).json({ error: e.message });
		}
	};

	const historyHandler = async (req, res) => {
		res.set('Cache-Control', 'no-store');
		try {
			const ids = String(req.query.regions ?? '').split(',').map((s) => s.trim()).filter((s) => VALID_ID.test(s))
				.slice(0, 12);
			const hours = Math.min(48, Math.max(1, Number(req.query.hours) || 24));
			if (fixturePath) {
				res.json({ followed: ids.length > 0, ...(await fixtureHistory(ids, hours)) });
				return;
			}
			await ensurePolling();
			// nothing followed: busiest oblasts from the recorder
			const list = ids.length > 0 ? ids : await history.busiest(9, hours);
			const result = await history.query(list, { hours, useBackfill: ids.length > 0 });
			res.json({ followed: ids.length > 0, ...result });
		} catch (e) {
			res.status(500).json({ error: e.message });
		}
	};

	const stop = async () => {
		if (timer) clearTimeout(timer);
		timer = null;
		active = false;
		neptun?.stop();
		await history.flush();
	};

	return {
		handler, historyHandler, snapshot, stop,
	};
};

export default createUkraineAlertsService;
