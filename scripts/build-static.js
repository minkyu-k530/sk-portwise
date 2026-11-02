// GitHub Pages 용 정적 스냅샷 빌드: public/ 을 복사하고, 서버의 /api 응답을 data/*.json 으로 굳힌다.
//   node scripts/build-static.js [outDir=dist]
// 환경변수 CONGESTION_CACHE: 혼잡 예보 파일 캐시 디렉터리(있으면 재사용, 없으면 받아서 저장). Actions 캐시와 함께 쓴다.
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getCongestion,
  getFacilities,
  getLayer,
  getSeaFog,
  getShipping,
  getVesselDetail,
  getVesselRoute,
  getVessels,
  getWeather,
} from '../lib/sk.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, process.argv[2] ?? 'dist');
const DATA = join(OUT, 'data');
const CONGESTION_CACHE = process.env.CONGESTION_CACHE ? join(ROOT, process.env.CONGESTION_CACHE) : null;
const LAYERS = ['anchorage', 'route', 'reporting', 'pilot'];

async function writeJson(rel, value) {
  const file = join(DATA, rel);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

/** 동시 호출 수를 제한해 업스트림 부하를 줄인다 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function kstDate(offsetDays) {
  return new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }).replaceAll('-', '');
}

async function buildCongestion() {
  const dates = [kstDate(0), kstDate(1)];
  const hours = Array.from({ length: 23 }, (_, i) => `${String(i + 1).padStart(2, '0')}00`);
  const dir = CONGESTION_CACHE ?? join(DATA, 'congestion');
  await mkdir(dir, { recursive: true });
  // 지난 날짜 캐시 정리
  for (const f of await readdir(dir)) if (!dates.some((d) => f.startsWith(d))) await rm(join(dir, f));
  const jobs = dates.flatMap((date) => hours.map((time) => ({ date, time, file: join(dir, `${date}-${time}.json`) })));
  const missing = jobs.filter((j) => !existsSync(j.file));
  let failed = 0;
  await mapLimit(missing, 4, async ({ date, time, file }) => {
    try {
      await writeFile(file, JSON.stringify(await getCongestion(date, time)));
    } catch (err) {
      failed++;
      console.warn(`congestion ${date}-${time}: ${err.message}`);
    }
  });
  if (CONGESTION_CACHE) await cp(dir, join(DATA, 'congestion'), { recursive: true });
  return { fetched: missing.length - failed, cached: jobs.length - missing.length, failed };
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await cp(join(ROOT, 'public'), OUT, { recursive: true });
  const indexFile = join(OUT, 'index.html');
  const html = await readFile(indexFile, 'utf8');
  await writeFile(indexFile, html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="skpw-mode" content="static">'));

  // 핵심 데이터: 하나라도 실패하면 빌드 실패(이전 배포가 유지된다)
  const [vessels, facilities, weather, seafog, shipping] = await Promise.all([
    getVessels(),
    getFacilities(),
    getWeather(),
    getSeaFog(),
    getShipping(),
  ]);
  for (const name of LAYERS) await writeJson(`layers/${name}.json`, await getLayer(name));

  // 선박 상세: 전 선박(작은 응답). 항적: 응답이 커서 SK 시설 접안 선박만.
  const withMmsi = vessels.vessels.filter((v) => v.mmsi);
  let detailFailed = 0;
  await mapLimit(withMmsi, 6, async (v) => {
    try {
      await writeJson(`vessels/${v.mmsi}/detail.json`, await getVesselDetail(v.mmsi, v.callSign));
    } catch {
      detailFailed++;
    }
  });
  const routeMmsi = [];
  await mapLimit(withMmsi.filter((v) => v.skFacility), 3, async (v) => {
    try {
      await writeJson(`vessels/${v.mmsi}/route.json`, await getVesselRoute(v.mmsi));
      routeMmsi.push(v.mmsi);
    } catch {
      /* 항적 없는 선박은 카드에서 버튼 비활성 */
    }
  });

  await writeJson('vessels.json', { ...vessels, routeMmsi });
  await writeJson('facilities.json', facilities);
  await writeJson('weather.json', weather);
  await writeJson('seafog.json', seafog);
  await writeJson('shipping.json', shipping);
  const congestion = await buildCongestion();
  await writeFile(join(OUT, '.nojekyll'), '');

  console.log(
    JSON.stringify({
      out: OUT,
      vessels: vessels.vessels.length,
      shipyard: vessels.vessels.filter((v) => v.shipyard).length,
      skAlongside: facilities.facilities.reduce((n, f) => n + f.alongside.length, 0),
      details: withMmsi.length - detailFailed,
      routes: routeMmsi.length,
      congestion,
      fetchedAt: vessels.fetchedAt,
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
