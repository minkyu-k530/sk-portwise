// 2D 지도 화면용 목업 API. 예전 PortWise 중계(/api/*)와 같은 모양의 응답을 브라우저 안에서 만든다.
// 선박·시설 상태는 3D 뷰와 같은 시뮬레이션(매일 KST 07:30 고정 시작 → 현재 시각까지 진행)에서 나오고,
// 기상·해운·해무·혼잡도·지도 레이어는 고정 목업 값이다. 외부 API 를 부르지 않는다.
import { advance, kstText, scenarioClock } from './clock.js';
import { ANCHORAGES, FACILITY_POS, NODES, VOYAGES, WEATHER } from './data.js';
import { toLatLng, toLocal } from './geo.js';
import { KN, PHASE_KR, STAGE_KR, Simulation, fmtDur, navStatus, windFrom } from './sim.js';

export const SOURCE = '가상 시뮬레이션 (목업)';

const TYPE_OF = { crude: 'TANKER_CRUDE', product: 'TANKER_PRODUCT', chemical: 'TANKER_CHEMICALS', lpg: 'GAS_CARRIER', vlgc: 'GAS_CARRIER' };
const TYPE_KR = { TANKER_CRUDE: '원유 운반선', TANKER_PRODUCT: '석유제품 운반선', TANKER_CHEMICALS: '케미컬 운반선', GAS_CARRIER: '가스 운반선' };
const CARGO_OF = { TANKER_CRUDE: 'oil', TANKER_PRODUCT: 'oil', TANKER_CHEMICALS: 'chemical', GAS_CARRIER: 'gas' };
const NATION = { KR: 'Korea', MH: 'Marshall Islands', LR: 'Liberia', PA: 'Panama', SG: 'Singapore', HK: 'Hong Kong' };
const AT_FACILITY = new Set(['moored', 'buoyMoored', 'berthing', 'unberthing', 'buoyMooring', 'buoyLeave']);
const IN_PORT = new Set(['seaIn', 'portIn', 'buoyIn', 'berthing', 'buoyMooring', 'moored', 'buoyMoored', 'anchoring', 'anchored', 'heaving', 'toAnchor']);

let ctx = null;

/** 시뮬레이션을 현재 시각까지 진행하고 항적을 기록한다 */
function sync() {
  if (!ctx) {
    const { startUtc, elapsed } = scenarioClock();
    ctx = { sim: new Simulation(), startUtc, tracks: new Map(), lastRec: -Infinity };
    advance(ctx.sim, elapsed, 120, record);
    return ctx;
  }
  const target = (Date.now() - ctx.startUtc) / 1000;
  if (target > ctx.sim.t) advance(ctx.sim, target - ctx.sim.t, 120, record);
  return ctx;
}

function record(sim) {
  if (sim.t - ctx.lastRec < 60) return;
  ctx.lastRec = sim.t;
  for (const s of sim.ships) {
    let tr = ctx.tracks.get(s.id);
    if (!tr) ctx.tracks.set(s.id, (tr = { today: [], past: [] }));
    if (s.phase === 'away') {
      if (tr.today.length) {
        tr.past = tr.today;
        tr.today = [];
      }
      continue;
    }
    const { lat, lng } = toLatLng(s.x, s.y);
    tr.today.push({ lat, lng, sog: +(s.sog / KN).toFixed(1), t: kstText(ctx.startUtc + sim.t * 1000) });
    if (tr.today.length > 1500) tr.today.shift();
  }
}

const at = (simT) => kstText(ctx.startUtc + simT * 1000);
const slotLabel = (slot) => {
  if (slot.facility.kind === 'buoy') return `SK${slot.id.slice(3)}부이`;
  const [fac, no] = slot.id.split('-');
  return `${fac}부두${no ? ` ${no}선석` : ''}`;
};

function portPlan(s, sim) {
  const f = sim.facility(s.spec.home);
  const voyage = `${new Date(ctx.startUtc).getUTCFullYear()}-${String(101 + s.index)}`;
  if (s.phase === 'away') {
    return { status: '입항 예정', arrival: at(s.returnAt), requestFacility: f.label, requestPeriod: `${at(s.returnAt)} ~`, voyage };
  }
  const plan = { status: ['portOut', 'unberthing', 'buoyLeave'].includes(s.phase) ? '출항' : '입항', voyage, requestFacility: f.label };
  if (s.slot) {
    plan.allotFacility = slotLabel(s.slot);
    plan.allotPeriod = s.phase === 'moored' || s.phase === 'buoyMoored' ? `${at(s.berthedAt ?? sim.t)} ~` : `ETA ${at(sim.etaOf(s) ?? sim.t)}`;
  }
  if ((s.phase === 'moored' || s.phase === 'buoyMoored') && s.slot) {
    const end = s.stage === 'cargo' ? s.stageEnd + 50 * 60 : s.stage === 'ready' ? sim.t : s.stageEnd + (s.stage === 'hoseOff' ? 0 : s.spec.opHours * 3600);
    plan.arrival = at(s.berthedAt ?? sim.t);
    plan.arrivalFacility = slotLabel(s.slot);
    plan.useFacility = slotLabel(s.slot);
    plan.usePeriod = `${at(s.berthedAt ?? sim.t)} ~ ${at(end)} (${STAGE_KR[s.stage]})`;
    plan.departure = at(end);
  }
  if (s.waitSince != null) plan.status = `${plan.status} · 대기 ${fmtDur(sim.t - s.waitSince)}`;
  return plan;
}

function vesselOf(s, sim) {
  const type = TYPE_OF[s.cls.kind];
  const st = navStatus(s);
  const { lat, lng } = toLatLng(s.x, s.y);
  const atFac = AT_FACILITY.has(s.phase) && s.slot;
  const [from, to] = VOYAGES[s.id] ?? [null, null];
  const outbound = ['portOut', 'unberthing', 'buoyLeave'].includes(s.phase);
  const small = ['PRODUCT_S', 'CHEM', 'LPG_S'].includes(s.spec.cls) && s.spec.flag === 'KR';
  const eta = sim.etaOf(s);
  let facilityName = null;
  if (atFac) facilityName = slotLabel(s.slot);
  else if (s.spot && ['anchoring', 'anchored', 'heaving'].includes(s.phase)) facilityName = s.spot.anchorage.label;
  return {
    id: s.id,
    mmsi: s.spec.mmsi,
    imo: s.spec.imo,
    callSign: s.spec.callSign,
    name: s.name,
    nameKr: null,
    type,
    typeKr: TYPE_KR[type],
    cargo: CARGO_OF[type],
    rawType: s.cls.kr,
    flag: s.spec.flag,
    nationality: NATION[s.spec.flag] ?? null,
    domestic: small ? 'in' : 'out',
    length: s.L,
    width: s.B,
    draft: +s.draft.toFixed(1),
    grossTon: Math.round(s.spec.dwt * 0.56 / 10) * 10,
    lat,
    lng,
    sog: +(s.sog / KN).toFixed(1),
    cog: s.sog > 0.15 ? Math.round((s.cog * 180) / Math.PI) % 360 : 0,
    heading: Math.round((s.psi * 180) / Math.PI) % 360,
    navStatus: st.code,
    navStatusKr: st.kr,
    destination: outbound ? to : 'ULSAN',
    destinationCode: outbound ? null : 'KRUSN',
    departure: outbound ? 'ULSAN' : from,
    eta: outbound ? null : eta != null ? at(eta) : null,
    toUlsan: !outbound,
    shipyard: false,
    updated: at(sim.t),
    aisSource: 'SIM',
    facilityName,
    skFacility: atFac ? s.slot.facility.id : null,
    facilitySource: atFac ? 'sim' : null,
    port: portPlan(s, sim),
    phaseKr: PHASE_KR[s.phase],
  };
}

function vessels() {
  const { sim } = sync();
  return {
    vessels: sim.ships.filter((s) => s.phase !== 'away').map((s) => vesselOf(s, sim)),
    source: SOURCE,
    fetchedAt: new Date().toISOString(),
    stale: false,
    routeMmsi: null,
  };
}

function facilities() {
  const { sim } = sync();
  const list = sim.ships.filter((s) => s.phase !== 'away').map((s) => vesselOf(s, sim));
  return {
    facilities: sim.facilities.map((f) => {
      const no = Number(f.id.replace(/\D/g, ''));
      const pos = FACILITY_POS[f.id];
      const alongside = list.filter((v) => v.skFacility === f.id).map((v) => ({
        id: v.id, mmsi: v.mmsi, name: v.name, nameKr: null, typeKr: v.typeKr, cargo: v.cargo,
        facilityName: v.facilityName, facilitySource: v.facilitySource, navStatusKr: v.navStatusKr,
        length: v.length, grossTon: v.grossTon, lat: v.lat, lng: v.lng, port: v.port,
      }));
      const scheduled = [];
      for (const slot of f.slots) {
        const s = slot.occupant && sim.ships.find((x) => x.id === slot.occupant);
        if (s && !AT_FACILITY.has(s.phase)) {
          scheduled.push({ mmsi: s.spec.mmsi, callSign: s.spec.callSign, name: s.name, nameKr: null, stage: '배정', facilityName: slotLabel(slot), period: `ETA ${at(sim.etaOf(s) ?? sim.t)}`, status: PHASE_KR[s.phase], arrival: null, location: s.spot?.anchorage.label ?? null });
        }
      }
      for (const id of f.queue) {
        const s = sim.ships.find((x) => x.id === id);
        scheduled.push({ mmsi: s.spec.mmsi, callSign: s.spec.callSign, name: s.name, nameKr: null, stage: '신청', facilityName: f.label, period: `대기 ${fmtDur(sim.t - (s.waitSince ?? sim.t))}`, status: PHASE_KR[s.phase], arrival: null, location: s.spot?.anchorage.label ?? null });
      }
      for (const s of sim.ships) {
        if (s.phase === 'away' && s.spec.home === f.id && s.returnAt - sim.t < 24 * 3600) {
          scheduled.push({ mmsi: s.spec.mmsi, callSign: s.spec.callSign, name: s.name, nameKr: null, stage: '신청', facilityName: f.label, period: `입항 예정 ${at(s.returnAt)}`, status: '입항 예정', arrival: at(s.returnAt), location: null });
        }
      }
      return {
        id: f.id,
        kind: f.kind === 'buoy' ? 'buoy' : 'berth',
        no,
        name: f.kind === 'buoy' ? `SK${no}부이` : `SK${no}부두`,
        label: f.label,
        lat: pos.lat,
        lng: pos.lng,
        approx: Boolean(pos.approx),
        port: '울산본항',
        specs: [{
          operator: f.operator, ownership: null, length: f.lengthM ? String(f.lengthM) : '1기', depth: String(f.depth),
          capacity: f.capacity.replace(/ DWT.*$/, ''), berths: String(f.slots.length), cargo: f.cargo, code: null,
        }],
        alongside,
        scheduled,
      };
    }),
    source: SOURCE,
    fetchedAt: new Date().toISOString(),
    stale: false,
  };
}

function detail(mmsi) {
  const { sim } = sync();
  const s = sim.ships.find((x) => x.spec.mmsi === mmsi);
  if (!s) throw Object.assign(new Error('목업에 없는 선박'), { status: 404 });
  const v = vesselOf(s, sim);
  return {
    averageVoyageHours: String(s.spec.opHours + s.spec.awayHours),
    facilityUseHours: String(s.spec.opHours + 1),
    grossTon: v.grossTon,
    portArrival: v.port?.arrival ?? null,
    port: v.port,
    facilityName: v.facilityName,
    skFacility: v.skFacility,
  };
}

function route(mmsi) {
  sync();
  const s = ctx.sim.ships.find((x) => x.spec.mmsi === mmsi);
  const tr = s && ctx.tracks.get(s.id);
  return { today: tr?.today ?? [], past: tr?.past ?? [] };
}

// ── 고정 목업: 기상·해무·해운 ─────────────────────────────────────────────

function kstHour(ms = Date.now()) {
  const d = new Date(ms + 9 * 3600_000);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

function weather() {
  const { sim } = sync();
  const h = kstHour();
  const now = Date.now();
  const wind = ((windFrom(sim.t) * 180) / Math.PI + 360) % 360;
  const ws = +(WEATHER.windKn * KN * (1 + 0.12 * Math.sin(sim.t / 5400))).toFixed(1);
  const hourUtc = Math.floor(now / 3600_000) * 3600_000;
  const issued = kstText(hourUtc + 9 * 3600_000); // 화면이 9시간을 빼서 발표시각으로 보여 준다
  const waveAt = kstText(hourUtc).replace(/[-: ]/g, '').slice(0, 10);
  const land = (areas, sky) => ({ grid: '0,0', areas, fcstDate: issued, sky, pty: '0', pop: '10', pcp: '강수없음' });
  return {
    sea: {
      station: '울산항(가상)', observedAt: kstText(now), windDir: Math.round(wind), windSpeed: ws, gust: +(ws * 1.4).toFixed(1),
      airTemp: +(14.5 + 3.5 * Math.sin(((h - 9) / 24) * 2 * Math.PI)).toFixed(1), pressure: 1017.8, waterTemp: 17.4,
      tide: Math.round(40 + 32 * Math.sin((2 * Math.PI * sim.t) / (12.42 * 3600))), salinity: 33.2,
    },
    air: { station: '울산 남구(가상)', observedAt: kstText(hourUtc), so2: '0.004', o3: '0.031', no2: '0.017', pm10: '34', pm10_24h: '31', pm25: '16', pm25_24h: '14', khai: '62' },
    land: [land(['울산본항', '울산신항'], '1'), land(['온산항'], '3')],
    wave: { station: '울산 파고부이(가상)', observedAt: waveAt, significant: WEATHER.swellM * 0.8, max: +(WEATHER.swellM * 1.4).toFixed(1), average: +(WEATHER.swellM * 0.55).toFixed(1), period: 7.8 },
    sources: {
      sea: { org: '가상 해양관측(목업)', interval: '10분' },
      air: { org: '가상 대기측정(목업)', interval: '1시간' },
      land: { org: '가상 단기예보(목업)', interval: '1시간' },
      wave: { org: '가상 파고부이(목업)', interval: '1시간' },
    },
    source: SOURCE, fetchedAt: new Date().toISOString(), stale: false,
  };
}

function seafog() {
  const now = Date.now();
  const h = kstHour();
  const base = h < 9 ? 18 : 6;
  return {
    station: '울산항',
    forecasts: [1, 3, 6].map((k, i) => ({
      label: `${k}시간 후`,
      at: `${kstText(now + k * 3600_000)}:00`,
      probability: base + i * 4,
      rawProbability: base + i * 5,
    })),
    sourceOrg: { org: '가상 해무 예측(목업)', interval: '1시간' },
    source: SOURCE, fetchedAt: new Date().toISOString(), stale: false,
  };
}

function shipping() {
  const year = new Date().getUTCFullYear();
  const freight = [
    [1022, 838, 1366], [2783, 1885, 2943], [3429, 2797, 1934], [1059, 942, 1378], [1895, 1213, 1623], [1541, 1302, 1489], [1407, 1188, 1612], [1386, 1172, 1544],
  ].map(([scfi, ccfi, bdi], i) => ({ year: String(year - 7 + i), scfi, ccfi, bdi }));
  const day = `${kstText(Date.now()).slice(0, 10)} 09:00`;
  return {
    freight,
    latestFreight: freight.at(-1),
    oil: { wti: { price: 71.84, currency: 'USD', at: day }, brent: { price: 75.12, currency: 'USD', at: day }, dubai: { price: 74.37, currency: 'USD', at: day } },
    sources: { freight: { org: '가상 운임지수(목업)' }, oil: { org: '가상 유가(목업)', currency: 'USD' } },
    source: SOURCE, fetchedAt: new Date().toISOString(), stale: false,
  };
}

// ── 혼잡도: 현재 선박 밀도 + 시간대 가중으로 만든 가상 예보 ─────────────────

let coastPromise = null;
const coast = () => (coastPromise ??= fetch('data/coastline.json').then((r) => r.json()));
function inPoly(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

async function congestion(date, time) {
  if (!/^\d{8}$/.test(date) || !/^\d{4}$/.test(time)) throw Object.assign(new Error('date=YYYYMMDD, time=HHMM 형식이어야 합니다'), { status: 400 });
  const { sim } = sync();
  const land = (await coast()).land;
  const hour = Number(time.slice(0, 2));
  const busy = Math.exp(-(((hour - 10) / 4) ** 2)) + 0.6 * Math.exp(-(((hour - 16) / 3) ** 2));
  const ships = sim.ships.filter((s) => s.phase !== 'away');
  const cells = [];
  const STEP = 0.025;
  for (let lat = 35.4125; lat < 35.53; lat += STEP) {
    for (let lng = 129.3425; lng < 129.49; lng += STEP) {
      const p = toLocal(lat, lng);
      if (land.some((r) => inPoly(p.x, p.y, r))) continue;
      const n = ships.filter((s) => Math.abs(s.x - p.x) < 1150 && Math.abs(s.y - p.y) < 1400).length;
      const seed = Math.abs(Math.sin(lat * 917 + lng * 331 + hour)) * 8;
      const index = Math.min(100, Math.round(6 + n * 17 + busy * 14 + seed));
      const level = index < 20 ? '매우낮음' : index < 40 ? '낮음' : index < 60 ? '보통' : index < 80 ? '높음' : '매우높음';
      const exposure = Math.min(1, Math.max(0, (-p.y - 300) / 3200));
      cells.push({
        id: `G${Math.round((lat - 35) * 400)}-${Math.round((lng - 129) * 400)}`, lat: +lat.toFixed(4), lng: +lng.toFixed(4), index, level,
        wave: +(0.2 + WEATHER.swellM * exposure).toFixed(1), wind: +(WEATHER.windKn * KN).toFixed(1), createdAt: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)} 04:30`,
      });
    }
  }
  return { cells, source: SOURCE, fetchedAt: new Date().toISOString(), stale: false };
}

// ── 지도 레이어: data.js 의 항로 노드·묘박지로 만든 가상 레이어 ─────────────

function offsetRing(ids, half) {
  const pts = ids.map((id) => NODES[id]);
  const side = (sign) => pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: p.x + ((b.y - a.y) / l) * half * sign, y: p.y - ((b.x - a.x) / l) * half * sign };
  });
  return [...side(1), ...side(-1).reverse()];
}

function layer(name) {
  let data;
  let seq = 0;
  const ll = (p) => toLatLng(p.x, p.y);
  if (name === 'anchorage') {
    data = ANCHORAGES.flatMap((a) => [
      { anchrgNm: a.id, anchrgTp: 'TEXT', ...ll({ x: a.spots[0].x, y: a.spots[0].y + 420 }), seqNo: seq++ },
      ...a.spots.map((p, i) => ({
        anchrgNm: `${a.id}-${i + 1}`, anchrgTp: 'CIRCLE', rad: 300, rmrk: a.maxDwt === Infinity ? '3만톤 초과' : `${a.maxDwt / 10000}만톤 이하`, ...ll(p), seqNo: seq++,
      })),
    ]);
  } else if (name === 'route') {
    const poly = (nm, ids, half) => offsetRing(ids, half).map((p, idx) => ({ rtNm: nm, ttlYn: 'N', idx, seqNo: seq++, ...ll(p) }));
    data = [
      { rtNm: '제1항로', ttlYn: 'Y', idx: 0, seqNo: seq++, ...ll(NODES.CH1) },
      ...poly('제1항로', ['CH0', 'CH1', 'CH2', 'CH3', 'CH4'], 190),
      { rtNm: '내항 진입로', ttlYn: 'Y', idx: 0, seqNo: seq++, ...ll(NODES.IN2) },
      ...poly('내항 진입로', ['CH4', 'IN1', 'IN2', 'IN3', 'IN4', 'TB12'], 90),
    ];
  } else if (name === 'reporting') {
    data = [{ x: -1200, y: -5600 }, { x: 4800, y: -5600 }].map((p) => ({ rprtLnNm: 'VTS 보고선(가상)', seqNo: seq++, ...ll(p) }));
  } else if (name === 'pilot') {
    data = [{ areaNm: '도선사 승선구역', areaExpln: '가상 도선 승선 구역', mileRad: 0.32, ...ll(NODES.PILOT) }];
  } else {
    throw Object.assign(new Error(`unknown layer: ${name}`), { status: 404 });
  }
  return { name, data, source: SOURCE, fetchedAt: new Date().toISOString(), stale: false };
}

/** 예전 api(path) 와 같은 호출 형식 */
export async function api(path) {
  const [p, q] = path.split('?');
  const qs = new URLSearchParams(q ?? '');
  let m;
  if (p === '/vessels') return vessels();
  if (p === '/facilities') return facilities();
  if ((m = p.match(/^\/vessels\/([^/]+)\/detail$/))) return detail(decodeURIComponent(m[1]));
  if ((m = p.match(/^\/vessels\/([^/]+)\/route$/))) return route(decodeURIComponent(m[1]));
  if (p === '/weather') return weather();
  if (p === '/seafog') return seafog();
  if (p === '/shipping') return shipping();
  if (p === '/congestion') return congestion(qs.get('date') ?? '', qs.get('time') ?? '');
  if ((m = p.match(/^\/layers\/([a-z]+)$/))) return layer(m[1]);
  throw new Error(`not found: ${p}`);
}
