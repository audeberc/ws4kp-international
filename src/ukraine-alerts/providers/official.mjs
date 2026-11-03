// Official ukrainealarm API: https://api.ukrainealarm.com (key required, request one on their site)
// Uses /alerts/status (cheap change index) and only fetches /alerts when something changed.

const BASE = 'https://api.ukrainealarm.com/api/v3';

const createOfficialProvider = ({ apiKey, userAgent, timeoutMs = 10_000 }) => {
	let lastActionIndex;
	let lastAlerts;

	const get = async (path) => {
		const res = await fetch(`${BASE}${path}`, {
			headers: { Authorization: apiKey, Accept: 'application/json', 'User-Agent': userAgent },
			signal: AbortSignal.timeout(timeoutMs),
		});
		const contentType = res.headers.get('content-type') ?? '';
		if (!res.ok || !contentType.includes('json')) {
			throw new Error(`official API ${path}: HTTP ${res.status} (${contentType || 'no content type'})`);
		}
		return res.json();
	};

	return {
		name: 'official',
		minIntervalMs: 10_000,
		async fetchAlerts() {
			const status = await get('/alerts/status');
			const index = status?.lastActionIndex;
			if (lastAlerts && index !== undefined && index === lastActionIndex) {
				return { alerts: lastAlerts, changed: false };
			}
			const alerts = await get('/alerts');
			lastAlerts = Array.isArray(alerts) ? alerts : [];
			lastActionIndex = index;
			return { alerts: lastAlerts, changed: true };
		},
	};
};

export default createOfficialProvider;
