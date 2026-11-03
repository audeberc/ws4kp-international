#!/usr/bin/env node
// Build the Ukraine maps used by the "Air Raid Alerts" display.
//
// Inputs (committed in tools/data/):
//   - ocha-adm{1,2,3}.geojson  OCHA COD-AB Ukraine (CC BY-IGO), simplified by tools/prepare-ocha.mjs
//   - regions-tree.json        ukrainealarm region tree: oblast -> district -> community
//
// Outputs (committed, regenerate with `npm run build:map`):
//   - views/partials/ukraine-oblasts-svg.ejs              inline SVG, one <path data-region-id> per oblast
//   - server/scripts/modules/ukraine-alerts/map-data.mjs   projection + per-oblast metadata for the browser
//   - server/scripts/modules/ukraine-alerts/areas.json     district + community shapes keyed by ukrainealarm id
//   - src/ukraine-alerts/region-parents.json              any ukrainealarm region id -> oblast id (server side)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { geoConicConformal, geoPath, geoTransform } from 'd3-geo';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'tools/data');

// SVG coordinate system (the browser scales it with viewBox)
const WIDTH = 600;
const HEIGHT = 400;
const PADDING = 6;
// projection definition, Lambert conformal conic centred on Ukraine
const PARALLELS = [45, 50];
const ROTATE = [-31, 0];

// OCHA adm1 pcode -> ukrainealarm regionId + English names
// Sevastopol has no separate ukrainealarm region, it is reported with Crimea (9999)
const OBLASTS = {
	UA01: { id: '9999', name: 'Crimea', short: 'Crimea' },
	UA05: { id: '4', name: 'Vinnytsia Oblast', short: 'Vinnytsia' },
	UA07: { id: '8', name: 'Volyn Oblast', short: 'Volyn' },
	UA12: { id: '9', name: 'Dnipropetrovsk Oblast', short: 'Dnipro' },
	UA14: { id: '28', name: 'Donetsk Oblast', short: 'Donetsk' },
	UA18: { id: '10', name: 'Zhytomyr Oblast', short: 'Zhytomyr' },
	UA21: { id: '11', name: 'Zakarpattia Oblast', short: 'Zakarpattia' },
	UA23: { id: '12', name: 'Zaporizhzhia Oblast', short: 'Zaporizhia' },
	UA26: { id: '13', name: 'Ivano-Frankivsk Oblast', short: 'Frankivsk' },
	UA32: { id: '14', name: 'Kyiv Oblast', short: 'Kyiv' },
	UA35: { id: '15', name: 'Kirovohrad Oblast', short: 'Kirovohrad' },
	UA44: { id: '16', name: 'Luhansk Oblast', short: 'Luhansk' },
	UA46: { id: '27', name: 'Lviv Oblast', short: 'Lviv' },
	UA48: { id: '17', name: 'Mykolaiv Oblast', short: 'Mykolaiv' },
	UA51: { id: '18', name: 'Odesa Oblast', short: 'Odesa' },
	UA53: { id: '19', name: 'Poltava Oblast', short: 'Poltava' },
	UA56: { id: '5', name: 'Rivne Oblast', short: 'Rivne' },
	UA59: { id: '20', name: 'Sumy Oblast', short: 'Sumy' },
	UA61: { id: '21', name: 'Ternopil Oblast', short: 'Ternopil' },
	UA63: { id: '22', name: 'Kharkiv Oblast', short: 'Kharkiv' },
	UA65: { id: '23', name: 'Kherson Oblast', short: 'Kherson' },
	UA68: { id: '3', name: 'Khmelnytskyi Oblast', short: 'Khmelnyts.' },
	UA71: { id: '24', name: 'Cherkasy Oblast', short: 'Cherkasy' },
	UA73: { id: '26', name: 'Chernivtsi Oblast', short: 'Chernivtsi' },
	UA74: { id: '25', name: 'Chernihiv Oblast', short: 'Chernihiv' },
	UA80: { id: '31', name: 'Kyiv City', short: 'Kyiv City' },
	UA85: { id: '9999', name: 'Crimea', short: 'Crimea' },
};

// ukrainealarm "State" level regions that are really cities inside an oblast
const CITY_STATES = {
	564: '12', // Zaporizhzhia city & community -> Zaporizhzhia Oblast
	1293: '22', // Kharkiv city & community -> Kharkiv Oblast
};

// manual matches for names that differ too much between ukrainealarm and OCHA
// ukrainealarm region id -> OCHA pcode (or several pcodes, drawn together)
const MANUAL = {
	38: 'UA0702', // Volodymyr-Volynskyi district -> renamed Volodymyrskyi
	84: 'UA4412', // Sievierodonetskyi district -> Siverskodonetskyi
	127: 'UA6306', // Krasnohradskyi district -> renamed Berestynskyi
	471: 'UA1808015', // Novohrad-Volynskyi -> renamed Zviahelska
	// same-name hromadas told apart by which one contains the city
	969: 'UA5110037', // Chornomorsk city
	970: 'UA5110039', // Chornomorska (village)
	354: 'UA1208009', // Pokrov city
	353: 'UA1208011', // Pokrovska (village)
	// two OCHA "Mykolaivska" hromadas in Sumy raion, ukrainealarm lists one
	1180: ['UA5908013', 'UA5908015'],
};
const manualFeatures = (id, byPcode) => {
	const codes = MANUAL[id];
	if (!codes) return null;
	const list = [codes].flat().map((c) => byPcode[c]);
	if (list.some((f) => !f)) throw new Error(`MANUAL ${id}: unknown pcode ${codes}`);
	return list;
};

// draw order: Kyiv City / Sevastopol must be painted on top of their surroundings
const DRAW_LAST = ['UA80', 'UA85'];

const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

// ---- name matching ----

const norm = (s) => {
	if (!s) return '';
	let n = s.toLowerCase().replace(/[’ʼ`ʼ]/g, "'").replace(/\s+/g, ' ').trim();
	// "м. Харків та Харківська територіальна громада" -> "харківська ..."
	if (n.startsWith('м. ') && n.includes(' та ')) n = n.slice(n.indexOf(' та ') + 4);
	n = n.replace(/\s+(район|область|територіальна громада|міська громада|селищна громада|сільська громада|громада)$/, '');
	n = n.replace(/^м\.\s*/, '');
	return n.trim();
};

const levenshtein = (a, b) => {
	const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
	for (let j = 1; j <= b.length; j += 1) dp[0][j] = j;
	for (let i = 1; i <= a.length; i += 1) {
		for (let j = 1; j <= b.length; j += 1) {
			dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
	}
	return dp[a.length][b.length];
};

// find a unique candidate whose normalized name matches
const findMatch = (name, candidates) => {
	const n = norm(name);
	const exact = candidates.filter((c) => c.names.includes(n));
	if (exact.length === 1) return exact[0];
	if (exact.length > 1) return null;
	// "харцизьк" vs "харцизька", "нікольська" vs "нікольська селищна"
	const prefix = candidates.filter((c) => c.names.some((cn) => cn.startsWith(n) || n.startsWith(cn)));
	if (prefix.length === 1) {
		if (process.env.DEBUG_MATCH) console.log(`  prefix: ${name} -> ${prefix[0].names.join('/')}`);
		return prefix[0];
	}
	const close = candidates.filter((c) => c.names.some((cn) => levenshtein(cn, n) <= 2));
	if (close.length === 1) {
		if (process.env.DEBUG_MATCH) console.log(`  fuzzy: ${name} -> ${close[0].names.join('/')}`);
		return close[0];
	}
	return null;
};

const main = async () => {
	const load = async (f) => JSON.parse(await readFile(path.join(DATA, f), 'utf8'));
	const adm1 = await load('ocha-adm1.geojson');
	const adm2 = await load('ocha-adm2.geojson');
	const adm3 = await load('ocha-adm3.geojson');
	const tree = await load('regions-tree.json');

	adm1.features.forEach((f) => {
		if (!OBLASTS[f.properties.adm1_pcode]) throw new Error(`No mapping for ${f.properties.adm1_pcode} ${f.properties.adm1_name}`);
	});

	// ---- projection, fitted on the oblasts (planar fitting avoids spherical winding issues) ----
	const projection = geoConicConformal().parallels(PARALLELS).rotate(ROTATE).scale(1)
		.translate([0, 0]);
	let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
	const visit = (coords) => {
		if (typeof coords[0] === 'number') {
			const [x, y] = projection(coords);
			minX = Math.min(minX, x); maxX = Math.max(maxX, x);
			minY = Math.min(minY, y); maxY = Math.max(maxY, y);
			return;
		}
		coords.forEach(visit);
	};
	adm1.features.forEach((f) => visit(f.geometry.coordinates));
	const k = Math.min((WIDTH - 2 * PADDING) / (maxX - minX), (HEIGHT - 2 * PADDING) / (maxY - minY));
	const tx = (WIDTH - k * (maxX + minX)) / 2;
	const ty = (HEIGHT - k * (maxY + minY)) / 2;
	projection.scale(k).translate([tx, ty]);

	// planar paths, rounded to 0.1 unit (geometry is already simplified with topology preserved)
	const planarTransform = geoTransform({
		point(lon, lat) { const [x, y] = projection([lon, lat]); this.stream.point(x, y); },
	});
	const pathGen = geoPath(planarTransform).digits(1);
	const planar = geoPath(planarTransform);
	const bbox = (f) => planar.bounds(f).flat().map((n) => round(n));

	// ---- oblasts ----
	const features = [...adm1.features].sort((a, b) => DRAW_LAST.indexOf(a.properties.adm1_pcode) - DRAW_LAST.indexOf(b.properties.adm1_pcode));
	const regions = {};
	const paths = features.map((f) => {
		const pcode = f.properties.adm1_pcode;
		const info = OBLASTS[pcode];
		const [x0, y0, x1, y1] = bbox(f);
		const existing = regions[info.id];
		if (existing) {
			// merge Sevastopol into Crimea
			existing.bbox = [Math.min(existing.bbox[0], x0), Math.min(existing.bbox[1], y0), Math.max(existing.bbox[2], x1), Math.max(existing.bbox[3], y1)];
		} else {
			const [cx, cy] = planar.centroid(f);
			regions[info.id] = {
				id: info.id, pcode, name: info.name, short: info.short, label: [round(cx), round(cy)], bbox: [x0, y0, x1, y1],
			};
		}
		return `<path class="oblast" data-region-id="${info.id}" data-pcode="${pcode}" d="${pathGen(f)}"/>`;
	});
	// manual label nudges for awkward shapes
	if (regions['18']) regions['18'].label = [regions['18'].label[0] + 8, regions['18'].label[1] - 10];
	if (regions['9999']) regions['9999'].label = [regions['9999'].label[0], regions['9999'].label[1] + 4];

	// ---- match ukrainealarm districts / communities to OCHA raions / hromadas ----
	const pcodeByOblastId = {};
	Object.entries(OBLASTS).forEach(([pcode, info]) => { if (!pcodeByOblastId[info.id]) pcodeByOblastId[info.id] = pcode; });
	const candidates = (features2, nameKeys) => features2.map((f) => ({
		f, names: nameKeys.map((key) => norm(f.properties[key])).filter(Boolean),
	}));
	const raionsByOblast = {};
	adm2.features.forEach((f) => { (raionsByOblast[f.properties.adm1_pcode] ??= []).push(f); });
	const hromadasByRaion = {};
	const hromadasByOblast = {};
	adm3.features.forEach((f) => {
		(hromadasByRaion[f.properties.adm2_pcode] ??= []).push(f);
		(hromadasByOblast[f.properties.adm1_pcode] ??= []).push(f);
	});
	const adm3ByPcode = Object.fromEntries(adm3.features.map((f) => [f.properties.adm3_pcode, f]));
	const adm2ByPcode = Object.fromEntries(adm2.features.map((f) => [f.properties.adm2_pcode, f]));

	const areas = {};
	const unmatched = [];
	// one or more OCHA features for a ukrainealarm area
	const addArea = (id, type, oblastId, featureList, nameKey) => {
		const boxes = featureList.map(bbox);
		areas[id] = {
			t: type,
			p: oblastId,
			n: featureList[0].properties[nameKey],
			b: [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))],
			d: featureList.map((f) => pathGen(f)).join(''),
		};
	};
	const matchCommunity = (node, oblastId, raionPcode) => {
		const oblastPcode = pcodeByOblastId[oblastId];
		const found = (raionPcode && findMatch(node.regionName, candidates(hromadasByRaion[raionPcode] ?? [], ['adm3_name1', 'adm3_name1_old']))?.f)
			|| findMatch(node.regionName, candidates(hromadasByOblast[oblastPcode] ?? [], ['adm3_name1', 'adm3_name1_old']))?.f;
		const match = manualFeatures(node.regionId, adm3ByPcode) ?? (found ? [found] : null);
		if (match) addArea(node.regionId, 'C', oblastId, match, 'adm3_name');
		else unmatched.push(`community ${node.regionId} ${node.regionName}`);
	};

	const parents = {};
	const districts = {};
	tree.states.forEach((state) => {
		if (state.regionId === '0') return; // test region
		const cityOblast = CITY_STATES[state.regionId];
		const oblastId = cityOblast ?? state.regionId;
		parents[state.regionId] = oblastId;
		if (cityOblast) {
			matchCommunity(state, oblastId, null);
			return;
		}
		const oblastPcode = pcodeByOblastId[oblastId];
		if (!oblastPcode) throw new Error(`Oblast without a shape: ${state.regionId} ${state.regionName}`);
		if (!regions[oblastId]) throw new Error(`Oblast missing: ${state.regionId}`);
		(state.regionChildIds ?? []).forEach((district) => {
			parents[district.regionId] = oblastId;
			(districts[oblastId] ??= []).push(district.regionId);
			const raion = manualFeatures(district.regionId, adm2ByPcode)?.[0]
				?? findMatch(district.regionName, candidates(raionsByOblast[oblastPcode] ?? [], ['adm2_name1']))?.f;
			if (raion) addArea(district.regionId, 'D', oblastId, [raion], 'adm2_name');
			else unmatched.push(`district ${district.regionId} ${district.regionName}`);
			(district.regionChildIds ?? []).forEach((community) => {
				parents[community.regionId] = oblastId;
				matchCommunity(community, oblastId, raion?.properties.adm2_pcode);
			});
		});
	});

	// ---- write ----
	const hatch = (id, color) => `<pattern id="hatch-${id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" class="hatch-bg"/><rect width="3" height="6" fill="${color}"/></pattern>`;
	const defs = [
		hatch('air', '#e8261c'), hatch('yellow', '#e0a800'), hatch('artillery', '#ff7f11'),
		hatch('urban', '#b04ad8'), hatch('chem', '#c6e000'), hatch('unknown', '#e8261c'),
	].join('\n');

	// layers: oblast fills, alerted areas (filled by the browser), raion borders (zoomed view), oblast borders, labels, targets
	const svg = `<svg class="ukraine-map" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" preserveAspectRatio="xMidYMid meet">
<defs>
${defs}
</defs>
<g class="oblasts">
${paths.join('\n')}
</g>
<g class="areas"></g>
<g class="raion-borders"></g>
<g class="oblast-borders"></g>
<g class="labels"></g>
<g class="targets"></g>
</svg>
`;

	// projection constants for the browser: screen = [ax + k*rawX, ay - k*rawY]
	const rawProject = makeRaw(PARALLELS);
	const toRaw = ([lon, lat]) => rawProject(((lon + ROTATE[0]) * Math.PI) / 180, (lat * Math.PI) / 180);
	const probe = [30.5234, 50.4501]; // Kyiv
	const [px, py] = projection(probe);
	const [rx, ry] = toRaw(probe);
	const ax = px - k * rx;
	const ay = py + k * ry;
	[[22.3, 48.6], [40.2, 49.6], [33.5, 44.6], [24.0, 49.8]].forEach((p) => {
		const [ex, ey] = projection(p);
		const [qx, qy] = toRaw(p);
		if (Math.hypot(ax + k * qx - ex, ay - k * qy - ey) > 0.01) throw new Error(`Projection mismatch at ${p}`);
	});

	const mapData = `// GENERATED by tools/build-ukraine-map.mjs - do not edit by hand
// Boundaries: OCHA COD-AB Ukraine (CC BY-IGO)

export const WIDTH = ${WIDTH};
export const HEIGHT = ${HEIGHT};

const PARALLELS = ${JSON.stringify(PARALLELS)};
const ROTATE_LON = ${ROTATE[0]};
const K = ${k};
const AX = ${ax};
const AY = ${ay};

const RAD = Math.PI / 180;
const tany = (y) => Math.tan((Math.PI / 2 + y) / 2);
const Y0 = PARALLELS[0] * RAD;
const Y1 = PARALLELS[1] * RAD;
const N = Math.log(Math.cos(Y0) / Math.cos(Y1)) / Math.log(tany(Y1) / tany(Y0));
const F = (Math.cos(Y0) * (tany(Y0) ** N)) / N;

// project [lon, lat] (degrees) to map SVG coordinates (Lambert conformal conic, same as the SVG)
export const project = (lon, lat) => {
	const x = (lon + ROTATE_LON) * RAD;
	const y = lat * RAD;
	const r = F / (tany(y) ** N);
	return [AX + K * r * Math.sin(N * x), AY - K * (F - r * Math.cos(N * x))];
};

// oblast metadata keyed by ukrainealarm regionId. bbox = [x0, y0, x1, y1] in SVG units
export const REGIONS = ${JSON.stringify(regions, null, '\t')};
`;

	const modDir = path.join(ROOT, 'server/scripts/modules/ukraine-alerts');
	await mkdir(modDir, { recursive: true });
	await writeFile(path.join(ROOT, 'views/partials/ukraine-oblasts-svg.ejs'), svg);
	await writeFile(path.join(modDir, 'map-data.mjs'), mapData);
	const areasJson = JSON.stringify(areas);
	await writeFile(path.join(modDir, 'areas.json'), areasJson);
	await mkdir(path.join(ROOT, 'src/ukraine-alerts'), { recursive: true });
	// Ukrainian oblast names -> id, to match sources that identify oblasts by name (alerts.in.ua)
	const simpleName = (n) => n.toLowerCase().replace(/[’ʼ`\u02bc]/g, "'").replace(/^м\.\s*/, '').replace(/\s+область$/, '').trim();
	const oblastNames = { севастополь: '9999' };
	tree.states.forEach((state) => {
		if (state.regionId !== '0' && !CITY_STATES[state.regionId]) oblastNames[simpleName(state.regionName)] = state.regionId;
	});
	await writeFile(path.join(ROOT, 'src/ukraine-alerts/region-parents.json'), `${JSON.stringify({ parents, districts, oblastNames })}\n`);

	const counts = Object.values(areas).reduce((acc, a) => ({ ...acc, [a.t]: (acc[a.t] ?? 0) + 1 }), {});
	console.log(`SVG: ${paths.length} oblast paths, ${Math.round(svg.length / 1024)} KB`);
	console.log(`areas.json: ${counts.D ?? 0} districts, ${counts.C ?? 0} communities, ${Math.round(areasJson.length / 1024)} KB`);
	console.log(`region-parents: ${Object.keys(parents).length} ids`);
	if (unmatched.length) {
		console.log(`UNMATCHED (${unmatched.length}) - add to MANUAL if needed:`);
		unmatched.forEach((u) => console.log(`  ${u}`));
	}
};

// d3's conicConformalRaw (parallels in degrees)
function makeRaw([p0, p1]) {
	const tany = (y) => Math.tan((Math.PI / 2 + y) / 2);
	const y0 = (p0 * Math.PI) / 180;
	const y1 = (p1 * Math.PI) / 180;
	const n = Math.log(Math.cos(y0) / Math.cos(y1)) / Math.log(tany(y1) / tany(y0));
	const f = (Math.cos(y0) * (tany(y0) ** n)) / n;
	return (x, y) => {
		const r = f / (tany(y) ** n);
		return [r * Math.sin(n * x), f - r * Math.cos(n * x)];
	};
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
