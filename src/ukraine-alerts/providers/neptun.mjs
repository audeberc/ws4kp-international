// Flying targets (Shahed, missiles, KAB, MiG-31K...) from NEPTUN (https://neptun.in.ua/).
//
// NEPTUN publishes an open, keyless API (https://neptun.in.ua/developers, terms at /api-terms):
//   * WebSocket stream wss://neptun.in.ua/api/v1/stream, envelopes { type, ts, data }:
//       snapshot  { threats: [...] }   full state on connect
//       upsert    <Threat>             track appeared / changed
//       remove    { id }               track gone
//       alerts    { raions, oblasts }  official alerts (not used here, ukrainealarm stays the alert source)
//       heartbeat                      keep-alive
//   * REST snapshot GET /api/v1/threats (CDN cached, at most once every 5 s)
// Terms: visible "NEPTUN" link next to the data, one connection instead of hammering REST, and a
// clear note that NEPTUN is an aggregator, not an official alert system.
//
// We keep ONE socket for the whole server (every display shares it) and only while displays are open.
// While the socket is down we fall back to the REST snapshot every 15 s.

const DEFAULT_STREAM = 'wss://neptun.in.ua/api/v1/stream?v=2';
const REST_INTERVAL_MS = 15_000;
// server sends a heartbeat roughly every 25-30 s; reconnect if nothing arrives for this long
const SILENCE_MS = 75_000;
const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;

const restUrlFor = (streamUrl) => {
	const u = new URL(streamUrl);
	u.protocol = u.protocol === 'ws:' ? 'http:' : 'https:';
	u.pathname = u.pathname.replace(/\/stream\/?$/, '/threats');
	u.search = '';
	return u.toString();
};

const isThreat = (t) => t && typeof t === 'object' && typeof t.id === 'string'
	&& Number.isFinite(t.lat) && Number.isFinite(t.lon);

const createNeptunProvider = ({
	streamUrl = DEFAULT_STREAM, userAgent, log = () => {}, timeoutMs = 10_000,
}) => {
	const restUrl = restUrlFor(streamUrl);
	const tracks = new Map();
	let ws = null;
	let wanted = false;
	let connected = false;
	let backoff = BACKOFF_MIN_MS;
	let reconnectTimer = null;
	let watchdog = null;
	let lastFrame = 0;
	let connectStarted = 0;
	let lastRest = 0;
	let restInFlight = null;
	let updated = null; // last time we had a complete, trusted view
	let error = null;
	let version = 0; // bumps on every change, lets the service skip re-normalizing
	let readyWaiters = [];

	const markReady = () => {
		updated = new Date().toISOString();
		error = null;
		readyWaiters.forEach((resolve) => resolve());
		readyWaiters = [];
	};

	const replaceAll = (list) => {
		tracks.clear();
		(list ?? []).filter(isThreat).forEach((t) => tracks.set(t.id, t));
		version += 1;
		markReady();
	};

	const onFrame = (raw) => {
		lastFrame = Date.now();
		let env;
		try { env = JSON.parse(raw); } catch { return; }
		switch (env?.type) {
			case 'snapshot':
				replaceAll(env.data?.threats);
				break;
			case 'upsert':
				if (isThreat(env.data)) {
					if (env.data.status === 'resolved') tracks.delete(env.data.id);
					else tracks.set(env.data.id, env.data);
					version += 1;
					updated = new Date().toISOString();
				}
				break;
			case 'remove':
				if (typeof env.data?.id === 'string' && tracks.delete(env.data.id)) version += 1;
				updated = new Date().toISOString();
				break;
			case 'heartbeat':
				if (connected) updated = new Date().toISOString();
				break;
			default: // alerts and future frame types are ignored
		}
	};

	const clearTimers = () => {
		if (reconnectTimer) clearTimeout(reconnectTimer);
		if (watchdog) clearInterval(watchdog);
		reconnectTimer = null;
		watchdog = null;
	};

	const scheduleReconnect = () => {
		if (!wanted || reconnectTimer) return;
		const delay = Math.round(backoff * (0.75 + Math.random() * 0.5));
		backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			// eslint-disable-next-line no-use-before-define
			connect();
		}, delay);
	};

	const connect = () => {
		if (!wanted || ws) return;
		let socket;
		try {
			// Node >= 22 ships a WHATWG WebSocket; extra headers are not part of that API
			socket = new WebSocket(streamUrl);
		} catch (e) {
			error = `neptun: ${e.message}`;
			scheduleReconnect();
			return;
		}
		ws = socket;
		lastFrame = Date.now();
		connectStarted = Date.now();
		socket.addEventListener('open', () => {
			connected = true;
			backoff = BACKOFF_MIN_MS;
			log('neptun: stream connected');
		});
		socket.addEventListener('message', (e) => {
			if (typeof e.data === 'string') onFrame(e.data);
		});
		socket.addEventListener('error', (e) => {
			error = `neptun: ${e.message || 'stream error'}`;
		});
		socket.addEventListener('close', (e) => {
			if (ws === socket) ws = null;
			if (connected) log(`neptun: stream closed (${e.code}${e.reason ? ` ${e.reason}` : ''})`);
			connected = false;
			scheduleReconnect();
		});
		if (!watchdog) {
			watchdog = setInterval(() => {
				if (ws && Date.now() - lastFrame > SILENCE_MS) {
					log('neptun: stream silent, reconnecting');
					error = 'neptun: stream silent';
					try { ws.close(); } catch { /* ignore */ }
					ws = null;
					connected = false;
					scheduleReconnect();
				}
			}, 15_000);
			watchdog.unref?.();
		}
	};

	// REST snapshot, only used while the stream is down
	const pollRest = async () => {
		if (connected || restInFlight || Date.now() - lastRest < REST_INTERVAL_MS) return restInFlight;
		// give a fresh connection a moment before falling back
		if (ws && ws.readyState === 0 && Date.now() - connectStarted < 5_000) return null;
		lastRest = Date.now();
		restInFlight = (async () => {
			try {
				const res = await fetch(restUrl, {
					headers: { Accept: 'application/json', 'User-Agent': userAgent },
					signal: AbortSignal.timeout(timeoutMs),
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = await res.json();
				// a socket may have connected meanwhile; its snapshot wins
				if (!connected) replaceAll(Array.isArray(data?.threats) ? data.threats : []);
			} catch (e) {
				error = `neptun REST: ${e.message}`;
			} finally {
				restInFlight = null;
			}
		})();
		return restInFlight;
	};

	return {
		name: 'neptun',
		start() {
			if (wanted) return;
			wanted = true;
			backoff = BACKOFF_MIN_MS;
			connect();
		},
		stop() {
			wanted = false;
			clearTimers();
			if (ws) {
				try { ws.close(1000, 'idle'); } catch { /* ignore */ }
			}
			ws = null;
			connected = false;
			tracks.clear();
			version += 1;
			updated = null;
		},
		// called on every service tick: REST fallback while the socket is down
		async tick() {
			if (wanted && !connected) await pollRest();
		},
		// resolves once a first snapshot (stream or REST) arrived, or after timeoutMs
		waitForData(ms = 3_000) {
			if (updated) return Promise.resolve();
			return new Promise((resolve) => {
				readyWaiters.push(resolve);
				setTimeout(resolve, ms).unref?.();
			});
		},
		get threats() { return [...tracks.values()]; },
		get version() { return version; },
		get connected() { return connected; },
		get updated() { return updated; },
		get error() { return connected ? null : error; },
	};
};

export default createNeptunProvider;
