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

// ---- NEPTUN (neptun.in.ua) ----
// Ukrainian -> Latin (official KMU 2010 transliteration), the Star4000 fonts have no Cyrillic
const TRANSLIT = {
	а: 'a',
	б: 'b',
	в: 'v',
	г: 'h',
	ґ: 'g',
	д: 'd',
	е: 'e',
	є: 'ie',
	ж: 'zh',
	з: 'z',
	и: 'y',
	і: 'i',
	ї: 'i',
	й: 'i',
	к: 'k',
	л: 'l',
	м: 'm',
	н: 'n',
	о: 'o',
	п: 'p',
	р: 'r',
	с: 's',
	т: 't',
	у: 'u',
	ф: 'f',
	х: 'kh',
	ц: 'ts',
	ч: 'ch',
	ш: 'sh',
	щ: 'shch',
	ь: '',
	ю: 'iu',
	я: 'ia',
	ы: 'y',
	э: 'e',
	ё: 'io',
	ъ: '',
};
// at the start of a word
const TRANSLIT_INITIAL = {
	є: 'ye', ї: 'yi', й: 'y', ю: 'yu', я: 'ya',
};

const transliterate = (text) => {
	const chars = [...String(text ?? '').replace(/зг/gi, (m) => (m[0] === 'З' ? 'Zgh' : 'zgh'))];
	return chars.map((ch, i) => {
		const lower = ch.toLowerCase();
		if (!(lower in TRANSLIT)) return /['’ʼ`ʼ]/.test(ch) ? '' : ch;
		const initial = i === 0 || !/[\p{L}'’ʼ`ʼ]/u.test(chars[i - 1]);
		const out = (initial && TRANSLIT_INITIAL[lower]) || TRANSLIT[lower];
		return ch !== lower && out ? out[0].toUpperCase() + out.slice(1) : out;
	}).join('');
};

// NEPTUN type -> map class (same classes as war-monitor targets)
const NEPTUN_CLASS = {
	uav: 'uav', fpv: 'uav', recon: 'uav', missile: 'cruise', ballistic: 'ballistic', mig31k: 'aviation', kab: 'kab', unknown: 'unknown',
};
// NEPTUN type -> threat type vocabulary (alerts.in.ua names)
const NEPTUN_THREAT = {
	uav: 'drones', fpv: 'drones', recon: 'drones', missile: 'cruise_missiles', ballistic: 'ballistic_missiles', kab: 'guided_aerial_bombs', mig31k: 'mig31k_departure',
};

const neptunOblastId = (t) => oblastNames[simpleName(t?.region)] ?? oblastNames[simpleName(t?.oblast)];

// NEPTUN threats (WebSocket / REST) -> compact list for the map
const normalizeNeptunTargets = (threatList) => (threatList ?? [])
	.filter((t) => t && t.status !== 'resolved' && Number.isFinite(Number(t.lat)) && Number.isFinite(Number(t.lon)))
	.map((t) => {
		const type = String(t.type ?? 'unknown');
		const areaOnly = !!t.areaOnly;
		const heading = t.velocity?.bearingDeg ?? t.heading;
		return {
			id: String(t.id),
			type,
			cls: NEPTUN_CLASS[type] ?? 'unknown',
			lat: Number(t.lat),
			lon: Number(t.lon),
			// area-only records sit on the oblast centroid: no course, no trail (NEPTUN API rules)
			heading: !areaOnly && Number.isFinite(Number(heading)) && heading !== null ? Number(heading) : null,
			n: Math.max(1, Number(t.count) || 1),
			trail: areaOnly ? [] : (t.trail ?? [])
				.filter((p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lon)))
				.map((p) => [Number(p.lat), Number(p.lon)])
				.slice(-8),
			dest: null,
			place: transliterate(areaOnly ? '' : (t.locality || t.district || '')),
			oblast: neptunOblastId(t) ?? null,
			// "курсом на X": locality is where it is heading, not where it is
			toward: !!t.destination,
			// advisory = an observation (e.g. MiG-31K take-off over a calm country), shown calmly
			advisory: !!t.advisory,
			areaOnly,
			stale: t.status === 'stale' || !!t.advisory,
		};
	})
	// guided bombs are not shown on the map (same as war-monitor targets)
	.filter((t) => t.cls !== 'kab');

// NEPTUN threats -> { oblastId: [threat types] }, merged into alerted oblasts like alerts.in.ua
const neptunThreats = (threatList) => {
	const byOblast = {};
	(threatList ?? []).forEach((t) => {
		if (!t || t.status === 'resolved' || t.status === 'stale') return;
		const threat = NEPTUN_THREAT[t.type];
		const oblastId = neptunOblastId(t);
		if (!threat || !oblastId) return;
		byOblast[oblastId] = sortThreats([...(byOblast[oblastId] ?? []), threat]);
	});
	return byOblast;
};

// union of several { oblastId: [threats] } maps
const combineThreats = (...maps) => {
	const out = {};
	maps.filter(Boolean).forEach((m) => Object.entries(m).forEach(([id, list]) => {
		out[id] = sortThreats([...(out[id] ?? []), ...list]);
	}));
	return out;
};

export {
	normalizeAlerts,
	normalizeTargets,
	normalizeNeptunTargets,
	neptunThreats,
	combineThreats,
	transliterate,
	normalizeThreats,
	mergeThreats,
	parents,
	districts,
};
