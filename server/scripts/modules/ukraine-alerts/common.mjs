// shared helpers for the Ukraine alert displays (map + history)

import { parseQueryString } from '../share.mjs';
import { REGIONS } from './map-data.mjs';

const SELECTION_KEY = 'ukraineAlertRegions';
const SELECTION_EVENT = 'ukraine-alerts:selection';
const AREAS_URL = 'scripts/modules/ukraine-alerts/areas.json';

const TYPE_CLASS = {
	AIR: 'air',
	ARTILLERY: 'artillery',
	URBAN_FIGHTS: 'urban',
	CHEMICAL: 'chem',
	NUCLEAR: 'chem',
	UNKNOWN: 'unknown',
};

const TYPE_TEXT = {
	AIR: 'Air Raid',
	ARTILLERY: 'Artillery',
	URBAN_FIGHTS: 'Urban Fights',
	CHEMICAL: 'Chemical',
	NUCLEAR: 'Nuclear',
	UNKNOWN: 'Alert',
};

// alerts.in.ua threat types (also derived from ukrainealarm reasons on the server)
const THREAT_TEXT = {
	ballistic_missiles: 'Ballistic',
	cruise_missiles: 'Cruise Msl',
	unspecified_missiles: 'Missiles',
	mig31k_departure: 'MiG-31K',
	guided_aerial_bombs: 'Guided Bomb',
	drones: 'Drones',
	strategic_aircraft_activity: 'Strat. Air',
	tactic_aircraft_activity: 'Tac. Air',
	air_defense: 'Air Defense',
	unknown: 'Threat',
};

// ---- selection (which oblasts the user follows), shared by the displays ----

const sanitizeSelection = (ids) => [...new Set(ids.map((id) => String(id).trim()).filter((id) => REGIONS[id]))];

const saveSelection = (selection) => {
	try {
		localStorage.setItem(SELECTION_KEY, JSON.stringify(selection));
	} catch { /* storage may be unavailable */ }
	window.dispatchEvent(new CustomEvent(SELECTION_EVENT, { detail: selection }));
};

const loadSelection = () => {
	// url wins: ?ukraineAlertRegions=14,31
	const fromUrl = parseQueryString()?.[SELECTION_KEY];
	if (fromUrl !== undefined) {
		const selection = sanitizeSelection(fromUrl.split(','));
		try {
			localStorage.setItem(SELECTION_KEY, JSON.stringify(selection));
		} catch { /* storage may be unavailable */ }
		return selection;
	}
	try {
		return sanitizeSelection(JSON.parse(localStorage.getItem(SELECTION_KEY) ?? '[]'));
	} catch {
		return [];
	}
};

const onSelectionChange = (fxn) => window.addEventListener(SELECTION_EVENT, (e) => fxn(e.detail));

// ---- formatting ----

const formatDuration = (ms) => {
	const minutes = Math.max(0, Math.floor(ms / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 10) return `${hours}h${String(minutes % 60).padStart(2, '0')}`;
	if (hours < 48) return `${hours}h`;
	const days = Math.floor(hours / 24);
	return days > 99 ? '99d+' : `${days}d`;
};

const durationSince = (since) => (since ? formatDuration(Date.now() - Date.parse(since)) : '');

// css class for an alert record ({ types, level }) from the server
const alertClass = (record) => {
	if (!record) return 'clear';
	const main = record.types?.[0] ?? 'UNKNOWN';
	let cls = TYPE_CLASS[main] ?? 'unknown';
	if (cls === 'air' && record.level === 'Yellow') cls = 'yellow';
	return cls;
};

// ---- district / community shapes (loaded once, ~1.3 MB) ----

let areasPromise;
const loadAreas = () => {
	if (!areasPromise) {
		areasPromise = fetch(AREAS_URL)
			.then((res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return res.json();
			})
			.catch((e) => {
				console.error('Ukraine alerts: district/community shapes unavailable, using hatching', e);
				areasPromise = undefined;
				return {};
			});
	}
	return areasPromise;
};

export {
	TYPE_CLASS,
	TYPE_TEXT,
	THREAT_TEXT,
	sanitizeSelection,
	saveSelection,
	loadSelection,
	onSelectionChange,
	formatDuration,
	durationSince,
	alertClass,
	loadAreas,
};
