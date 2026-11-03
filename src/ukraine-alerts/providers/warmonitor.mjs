// Flying targets (Shahed, missiles...) from map.war-monitor.org.
//
// The public map requires a Cloudflare Turnstile human check plus per-request device
// signatures. This provider deliberately does NOT attempt any of that. It only runs when
// the operator has granted an API key (contact: war_monitor@proton.me) and sends it in the
// X-Api-Key header. Confirm the exact auth scheme with the operator and adjust here.

const URL_MAP = 'https://api.war-monitor.org/v2/map';

const createWarMonitorProvider = ({ apiKey, userAgent, timeoutMs = 10_000 }) => {
	let etag;
	let lastTargets = [];
	let retryAfterUntil = 0;

	return {
		name: 'war-monitor',
		// upstream client polls ~20 s with targets, ~45 s without
		get minIntervalMs() { return lastTargets.length > 0 ? 20_000 : 45_000; },
		async fetchTargets() {
			if (Date.now() < retryAfterUntil) return { targets: lastTargets, changed: false };

			const headers = { Accept: 'application/json', 'User-Agent': userAgent, 'X-Api-Key': apiKey };
			if (etag) headers['If-None-Match'] = etag;
			const res = await fetch(URL_MAP, { headers, signal: AbortSignal.timeout(timeoutMs) });

			if (res.status === 304) return { targets: lastTargets, changed: false };
			if (res.status === 429 || res.status === 503) {
				const retryAfter = Number(res.headers.get('retry-after')) || 120;
				retryAfterUntil = Date.now() + retryAfter * 1000;
				throw new Error(`war-monitor: HTTP ${res.status}, retry after ${retryAfter}s`);
			}
			if (!res.ok) {
				let code = '';
				try { code = (await res.json())?.error ?? ''; } catch { /* ignore */ }
				throw new Error(`war-monitor: HTTP ${res.status} ${code}`);
			}
			etag = res.headers.get('etag') ?? undefined;
			const data = await res.json();
			lastTargets = data?.paused ? [] : (Array.isArray(data?.targets) ? data.targets : []);
			return { targets: lastTargets, changed: true };
		},
	};
};

export default createWarMonitorProvider;
