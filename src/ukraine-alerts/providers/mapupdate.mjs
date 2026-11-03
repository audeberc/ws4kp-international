// Fallback: the public JSON used by https://map.ukrainealarm.com/ (no key, undocumented).
// The upstream sets cache-control max-age=10; we poll no faster than every 20 s and
// only for as long as a display is actually requesting data.

const URL_MAP_UPDATE = 'https://map.ukrainealarm.com/api/v2/data/mapUpdate';

const createMapUpdateProvider = ({ userAgent, timeoutMs = 10_000 }) => {
	let lastActionIndex;
	let lastAlerts;

	return {
		name: 'mapupdate',
		minIntervalMs: 20_000,
		async fetchAlerts() {
			const res = await fetch(URL_MAP_UPDATE, {
				headers: { Accept: 'application/json', 'User-Agent': userAgent },
				signal: AbortSignal.timeout(timeoutMs),
			});
			const contentType = res.headers.get('content-type') ?? '';
			if (!res.ok || !contentType.includes('json')) {
				throw new Error(`mapUpdate: HTTP ${res.status} (${contentType || 'no content type'})`);
			}
			const data = await res.json();
			const index = data?.actionIndex?.lastActionIndex;
			if (lastAlerts && index !== undefined && index === lastActionIndex) {
				return { alerts: lastAlerts, changed: false };
			}
			lastAlerts = Array.isArray(data?.alerts) ? data.alerts : [];
			lastActionIndex = index;
			return { alerts: lastAlerts, changed: true };
		},
	};
};

export default createMapUpdateProvider;
