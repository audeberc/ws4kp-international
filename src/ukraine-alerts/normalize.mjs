// Normalize ukrainealarm-style alert lists into one record per oblast.
// Both the official API (api.ukrainealarm.com/api/v3/alerts) and the map site's
// mapUpdate JSON use the same shape:
//   [{ regionId, regionType: State|District|Community, regionEngName, activeAlerts: [
//       { regionId, regionType, type, lastUpdate, activeAlertLevels?: [{ alertLevel, createdAt }] } ] }]

import { readFileSync } from 'node:fs';

// parents: any region id -> oblast id, districts: oblast id -> [district ids], oblastNames: ukrainian name -> oblast id
const { parents, districts, oblastNames } = JSON.parse(readFileSync(new URL('./region-parents.json', import.meta.url), 'utf8'));

const KNOWN_TYPES = ['AIR', 'ARTILLERY', 'URBAN_FIGHTS', 'CHEMICAL', 'NUCLEAR'];
// severity order used to pick the "main" type of an oblast
const TYPE_PRIORITY = ['NUCLEAR', 'CHEMICAL', 'AIR', 'URBAN_FIGHTS', 'ARTILLERY', 'UNKNOWN'];

const earliest = (a, b) => {
	if (!a) return b;
	if (!b) return a;
	return a < b ? a : b;
};

const normalizeAlerts = (alertList) => {
	const regions = {};

	(alertList ?? []).forEach((region) => {
		const regionId = String(region.regionId);
		const oblastId = parents[regionId];
		if (!oblastId) return; // unknown or test region
		const isOblast = oblastId === regionId;

		const alerts = (region.activeAlerts ?? []).map((alert) => {
			const levels = alert.activeAlertLevels ?? [];
			// official API has no levels: treat as a full (red) alert
			const level = levels.length === 0 || levels.some((l) => l.alertLevel === 'Red') ? 'Red' : 'Yellow';
			const since = levels.reduce((acc, l) => earliest(acc, l.createdAt), undefined) ?? alert.lastUpdate;
			const type = KNOWN_TYPES.includes(alert.type) ? alert.type : 'UNKNOWN';
			const reasons = levels.map((l) => (typeof l.reason === 'string' ? l.reason.trim() : '')).filter(Boolean);
			return {
				type, level, since, reasons,
			};
		});
		if (alerts.length === 0) return;

		if (!regions[oblastId]) {
			regions[oblastId] = {
				id: oblastId, status: 'partial', level: 'Yellow', types: [], since: undefined, areas: [], reasons: [], threats: [],
			};
		}
		const oblast = regions[oblastId];

		alerts.forEach((alert) => {
			if (!oblast.types.includes(alert.type)) oblast.types.push(alert.type);
			if (alert.level === 'Red') oblast.level = 'Red';
			alert.reasons.forEach((reason) => {
				const threat = reasonToThreat(reason);
				if (!oblast.reasons.includes(reason)) oblast.reasons.push(reason);
				if (threat && !oblast.threats.includes(threat)) oblast.threats.push(threat);
			});
		});

		if (isOblast) {
			oblast.status = 'full';
			oblast.since = alerts.reduce((acc, a) => earliest(acc, a.since), oblast.ownSince);
			oblast.ownSince = oblast.since;
		} else {
			// partial alerts: "since" tracks the earliest air alert among the areas
			if (!oblast.ownSince) {
				oblast.since = alerts.filter((a) => a.type === 'AIR').reduce((acc, a) => earliest(acc, a.since), oblast.since);
			}
			oblast.areas.push({
				id: regionId,
				type: region.regionType,
				name: region.regionEngName || region.regionName || regionId,
				types: [...new Set(alerts.map((a) => a.type))],
				level: alerts.some((a) => a.level === 'Red') ? 'Red' : 'Yellow',
			});
		}
	});

	Object.values(regions).forEach((r) => {
		// every district of the oblast under alert counts as the whole oblast
		const oblastDistricts = districts[r.id] ?? [];
		const alertedDistricts = new Set(r.areas.filter((a) => a.type === 'District').map((a) => a.id));
		if (r.status === 'partial' && oblastDistricts.length > 0 && oblastDistricts.every((id) => alertedDistricts.has(id))) {
			r.status = 'full';
		}
		r.since = r.since ?? null;
		r.threats = sortThreats(r.threats);
		delete r.ownSince;
		// sort types by severity
		r.types.sort((a, b) => TYPE_PRIORITY.indexOf(a) - TYPE_PRIORITY.indexOf(b));
	});

	return regions;
};

// ---- threat types ----
// common vocabulary (alerts.in.ua threat_type values), most dangerous first
const THREAT_PRIORITY = [
	'ballistic_missiles', 'cruise_missiles', 'unspecified_missiles', 'mig31k_departure', 'guided_aerial_bombs',
	'drones', 'strategic_aircraft_activity', 'tactic_aircraft_activity', 'air_defense', 'unknown',
];

// free text reasons (ukrainealarm, usually Ukrainian) -> threat type
const REASON_PATTERNS = [
	[/балісти|ballistic|іскандер|кинджал|kinzhal/i, 'ballistic_missiles'],
	[/крилат|cruise|калібр|kalibr|х-101|kh-101/i, 'cruise_missiles'],
	[/міг-?31|mig-?31/i, 'mig31k_departure'],
	[/каб|guided|авіабомб/i, 'guided_aerial_bombs'],
	[/ракет|missile/i, 'unspecified_missiles'],
	[/бпла|шахед|дрон|shahed|drone|uav/i, 'drones'],
	[/стратегічн|strategic|ту-?95|tu-?95/i, 'strategic_aircraft_activity'],
	[/тактичн|tactic|авіац|aviation/i, 'tactic_aircraft_activity'],
];

function reasonToThreat(reason) {
	const found = REASON_PATTERNS.find(([re]) => re.test(reason));
	return found ? found[1] : 'unknown';
}

const sortThreats = (list) => [...new Set(list)].sort((a, b) => THREAT_PRIORITY.indexOf(a) - THREAT_PRIORITY.indexOf(b));

const simpleName = (n) => String(n ?? '').toLowerCase().replace(/[’ʼ`\u02bc]/g, "'").replace(/^м\.\s*/, '')
	.replace(/\s+область$/, '')
	.trim();

// alerts.in.ua active alerts -> { oblastId: [threat types] }
const normalizeThreats = (alertList) => {
	const byOblast = {};
	(alertList ?? []).forEach((alert) => {
		const threats = (alert.threats ?? []).map((t) => (THREAT_PRIORITY.includes(t.threat_type) ? t.threat_type : 'unknown'));
		if (threats.length === 0) return;
		const oblastId = oblastNames[simpleName(alert.location_oblast)] ?? oblastNames[simpleName(alert.location_title)];
		if (!oblastId) return;
		byOblast[oblastId] = sortThreats([...(byOblast[oblastId] ?? []), ...threats]);
	});
	return byOblast;
};

// add threat types to normalized regions (in place)
const mergeThreats = (regions, threatsByOblast) => {
	Object.values(regions).forEach((region) => {
		region.threats = sortThreats([...(region.threats ?? []), ...(threatsByOblast?.[region.id] ?? [])]);
	});
	return regions;
};

// war-monitor style targets -> compact list for the map
const TARGET_CLASSES = ['uav', 'cruise', 'ballistic', 'aviation'];

const normalizeTargets = (targetList) => (targetList ?? [])
	.filter((t) => Number.isFinite(Number(t?.lat)) && Number.isFinite(Number(t?.lon)))
	.map((t) => {
		const type = String(t.type ?? 'unknown');
		const prefix = type.split('.')[0];
		return {
			id: String(t.id ?? `${t.lat},${t.lon}`),
			type,
			cls: TARGET_CLASSES.includes(prefix) ? prefix : 'unknown',
			lat: Number(t.lat),
			lon: Number(t.lon),
			heading: Number.isFinite(Number(t.heading)) ? Number(t.heading) : null,
			n: Math.max(1, Number(t.n) || 1),
			trail: (t.trail ?? [])
				.filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
				.map((p) => [Number(p[0]), Number(p[1])]),
			dest: t.dest && Number.isFinite(Number(t.dest.lat)) && Number.isFinite(Number(t.dest.lon))
				? { lat: Number(t.dest.lat), lon: Number(t.dest.lon), place: t.dest.place ?? '' }
				: null,
			place: t.place ?? '',
			stale: t.status === 'stale',
		};
	})
	// guided bombs are not shown (same as the source site)
	.filter((t) => !t.type.startsWith('kab'));

export {
	normalizeAlerts,
	normalizeTargets,
	normalizeThreats,
	mergeThreats,
	parents,
	districts,
};
