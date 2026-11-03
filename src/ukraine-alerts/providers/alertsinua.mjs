// Threat types (drones, ballistic missiles, ...) from the alerts.in.ua API.
// Docs: https://devs.alerts.in.ua  Token: request at https://alerts.in.ua/api-request
// Their rules: keep the token server side (we do), stay under ~8 requests/min (we poll every 30 s)
// and use If-Modified-Since.

const URL_ACTIVE = 'https://api.alerts.in.ua/v1/alerts/active.json';

const createAlertsInUaProvider = ({ token, userAgent, timeoutMs = 10_000 }) => {
	let lastModified;
	let lastAlerts = [];
	let retryAfterUntil = 0;

	return {
		name: 'alerts.in.ua',
		minIntervalMs: 30_000,
		async fetchThreats() {
			if (Date.now() < retryAfterUntil) return { alerts: lastAlerts, changed: false };
			const headers = { Accept: 'application/json', 'User-Agent': userAgent, Authorization: `Bearer ${token}` };
			if (lastModified) headers['If-Modified-Since'] = lastModified;
			const res = await fetch(URL_ACTIVE, { headers, signal: AbortSignal.timeout(timeoutMs) });
			if (res.status === 304) return { alerts: lastAlerts, changed: false };
			if (res.status === 429) {
				retryAfterUntil = Date.now() + 120_000;
				throw new Error('alerts.in.ua: HTTP 429 rate limited, pausing 2 min');
			}
			if (!res.ok) {
				let message = '';
				try { message = (await res.json())?.message ?? ''; } catch { /* ignore */ }
				throw new Error(`alerts.in.ua: HTTP ${res.status} ${message}`);
			}
			lastModified = res.headers.get('last-modified') ?? undefined;
			const data = await res.json();
			lastAlerts = Array.isArray(data?.alerts) ? data.alerts : [];
			return { alerts: lastAlerts, changed: true };
		},
	};
};

export default createAlertsInUaProvider;
