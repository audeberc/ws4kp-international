#!/usr/bin/env node
// One-time preparation of the oblast / raion / hromada boundaries used by build-ukraine-map.mjs.
//
// Source: OCHA "Ukraine - Subnational Administrative Boundaries" (COD-AB), HDX
//   https://data.humdata.org/dataset/cod-ab-ukr   licence: CC BY-IGO
//
// Downloads the GeoJSON pack (~84 MB) to a temp dir, simplifies each level with mapshaper
// (topology preserving, so neighbouring areas still share borders) and writes small files to
// tools/data/ocha-adm{1,2,3}.geojson, which are committed. Re-run only to refresh the boundaries.
// Requires `curl` and `unzip` on the PATH.

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tools/data');
const ZIP_URL = 'https://data.humdata.org/dataset/d23f529f-31e4-4021-a65b-13987e5cfb42/resource/681beb86-391b-4a08-8140-ca52e80fcdce/download/ukr_admin_boundaries.geojson.zip';

// level -> [fields to keep, simplification interval in metres]
const LEVELS = {
	1: ['adm1_pcode,adm1_name,adm1_name1', 1200],
	2: ['adm2_pcode,adm2_name,adm2_name1,adm1_pcode', 600],
	3: ['adm3_pcode,adm3_name,adm3_name1,adm3_name1_old,adm2_pcode,adm1_pcode', 400],
};

const main = async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'ocha-'));
	try {
		console.log(`downloading ${ZIP_URL}`);
		// HDX rejects Node's fetch (HTTP 406), curl works
		const zip = path.join(dir, 'ukr.zip');
		execFileSync('curl', ['-fsSL', '-o', zip, ZIP_URL], { stdio: 'inherit' });
		execFileSync('unzip', ['-o', '-q', zip, '-d', path.join(dir, 'x')]);

		const mapshaper = path.join(ROOT, 'node_modules/.bin/mapshaper');
		Object.entries(LEVELS).forEach(([level, [fields, interval]]) => {
			const input = path.join(dir, 'x', `ukr_admin${level}.geojson`);
			const output = path.join(OUT, `ocha-adm${level}.geojson`);
			execFileSync(mapshaper, ['-i', input, '-filter-fields', fields, '-simplify', `interval=${interval}`, 'keep-shapes',
				'-o', output, 'precision=0.0001'], { stdio: 'inherit' });
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
};

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
