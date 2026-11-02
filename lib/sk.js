// SK 액체부두(SK1~8부두, SK2·3부이) 도메인: 시설 정의, 시설명 매칭, 선박 필터/정규화, 데이터 조립.
import { cached, upaPost } from './upa.js';

// AIS 조회 범위: 울산본항·온산항·외곽 정박지/부이·접근 항로
export const ULSAN_BOUNDS = { north: 35.62, south: 35.2, east: 129.75, west: 129.2 };

// 시설 목록. 부두 좌표·제원은 PortWise getWharf.do 값으로 채운다.
// 부이 2기는 PortWise가 좌표를 0,0으로 내려주므로(공개 좌표 없음) 아래 근사 좌표를 쓰고 화면에 '근사'로 표시한다.
// 정확한 좌표를 알면 lat/lng 를 고치고 approx 를 false 로 바꾼다.
export const SK_FACILITIES = [
  { id: 'SK1', kind: 'berth', no: 1, name: 'SK1부두', label: 'SK 1부두' },
  { id: 'SK2', kind: 'berth', no: 2, name: 'SK2부두', label: 'SK 2부두' },
  { id: 'SK3', kind: 'berth', no: 3, name: 'SK3부두', label: 'SK 3부두' },
  { id: 'SK4', kind: 'berth', no: 4, name: 'SK4부두', label: 'SK 4부두' },
  { id: 'SK5', kind: 'berth', no: 5, name: 'SK5부두', label: 'SK 5부두' },
  { id: 'SK6', kind: 'berth', no: 6, name: 'SK6부두', label: 'SK 6부두' },
  { id: 'SK7', kind: 'berth', no: 7, name: 'SK7부두', label: 'SK 7부두' },
  { id: 'SK8', kind: 'berth', no: 8, name: 'SK8부두', label: 'SK 8부두' },
  { id: 'SKB2', kind: 'buoy', no: 2, name: 'SK2부이', label: 'SK 2 Buoy', lat: 35.4483, lng: 129.4236, approx: true },
  { id: 'SKB3', kind: 'buoy', no: 3, name: 'SK3부이', label: 'SK 3 Buoy', lat: 35.44, lng: 129.43, approx: true },
];

/** 시설명/시설코드 → SK 시설 id (없으면 null). 예: 'SK2부두 4선석', 'SK1부두 12', 'MDU-08', 'SK3부이'. */
export function matchSkFacility(name, code) {
  const n = String(name ?? '').replace(/\s+/g, '').toUpperCase();
  let m = n.match(/^SK([1-8])부두/);
  if (m) return `SK${m[1]}`;
  m = n.match(/^SK([23])(?:번)?(?:부이|BUOY)/) || n.match(/^SK(?:부이|BUOY)0?([23])$/);
  if (m) return `SKB${m[1]}`;
  const c = String(code ?? '').toUpperCase();
  m = c.match(/^SKV-?0?([23])$/);
  if (m) return `SKB${m[1]}`;
  m = c.match(/^MDU-0?([1-8])$/);
  if (m) return `SK${m[1]}`;
  return null;
}

// PortWise vsslTp → 한글명·화물군. SK 부두 취급 화물(유류·케미칼·가스)에 해당하는 선종만 둔다.
export const VESSEL_TYPES = {
  TANKER: { kr: '유조선', cargo: 'oil' },
  GENERAL_TANKER: { kr: '일반 유조선', cargo: 'oil' },
  TANKER_CRUDE: { kr: '원유 운반선', cargo: 'oil' },
  TANKER_PRODUCT: { kr: '석유제품 운반선', cargo: 'oil' },
  TANKER_CHEMICALS: { kr: '케미컬 운반선', cargo: 'chemical' },
  GAS_CARRIER: { kr: '가스 운반선', cargo: 'gas' },
  LNG_CARRIER: { kr: 'LNG 운반선', cargo: 'gas' },
  UNCLASSIFIED_AT_SK: { kr: '미분류(SK 시설 내)', cargo: 'unknown' },
};
const UNKNOWN_TYPES = new Set(['', 'NOT_AVAILABLE', 'OTHER']);

// 시운전(S/T)·계선(LAY UP) 등 조선소 신조선: 탱커/가스선이어도 SK 터미널과 무관한 경우가 대부분
const SHIPYARD_DEST = /(S\/?T\b|SEA\s*TRIAL|TRIAL|LAY[\s_-]*UP|\bHHI|HMD|G\/T\b|GAS\s*TRIAL)/i;

/** 표시명(영문 AIS명 우선)과 PORT-MIS 한글명. 한글명이 표시명과 같으면 생략 */
function names(primary, korean) {
  const name = primary ?? korean ?? '미입력';
  const norm = (s) => String(s ?? '').replace(/[\s.]/g, '').toUpperCase();
  return { name, nameKr: korean && norm(korean) !== norm(name) ? korean : null };
}

const NAV_STATUS_KR = {
  0: '항해(동력)', 1: '정박(앵커링)', 2: '조종 불능', 3: '기동 제한', 4: '흘수 제약',
  5: '정박(계류)', 6: '좌초', 7: '어로 중', 8: '항해(범주)', 15: '상태미확인',
};

/** 선종 판정: 탱커/가스선이면 타입 키, SK 시설 위의 미분류 선박이면 UNCLASSIFIED_AT_SK, 그 외 null */
function classify(vsslTp, aisTypeCode, skFacilityId) {
  if (VESSEL_TYPES[vsslTp]) return vsslTp;
  const code = Number(aisTypeCode);
  if (code >= 80 && code <= 89 && (vsslTp == null || UNKNOWN_TYPES.has(vsslTp))) return 'TANKER';
  if (skFacilityId && (vsslTp == null || UNKNOWN_TYPES.has(vsslTp))) return 'UNCLASSIFIED_AT_SK';
  return null;
}

function blank(v) {
  return v == null || v === '' || v === '-' || v === '~' ? null : v;
}

function portPlan(a) {
  if (!a) return null;
  const plan = {
    status: blank(a.pmCurrentStatus?.trim()),
    arrival: blank(a.pmArvlDt),
    arrivalFacility: blank(a.pmArvlFacNm),
    requestFacility: blank(a.pmReqFacNm),
    requestPeriod: blank(a.pmReqPeriod),
    allotFacility: blank(a.pmAllotFacNm),
    allotPeriod: blank(a.pmAllotPeriod),
    useFacility: blank(a.pmUseFacNm),
    usePeriod: blank(a.pmUsePeriod),
    departure: blank(a.pmDepDt),
    departureFacility: blank(a.pmDepFacNm),
    portArrival: blank(a.portArvlTm),
    voyage: a.portYr && a.portSerNo ? `${a.portYr}-${a.portSerNo}` : null,
  };
  return Object.values(plan).some((v) => v != null) ? plan : null;
}

// ── 업스트림 로더 ────────────────────────────────────────────────────────────
const TTL = {
  ais: 30_000,
  arrival: 60_000,
  wharf: 24 * 3600_000,
  weather: 5 * 60_000,
  fog: 10 * 60_000,
  shipping: 30 * 60_000,
  congestion: 30 * 60_000,
  layer: 24 * 3600_000,
};

const loadAis = () =>
  cached('ais', TTL.ais, async () => {
    const d = await upaPost('/cmm/init/getAisListOnTheMap.do', { form: { bookmarkYn: 'N', ...ULSAN_BOUNDS } });
    return d.vsslList ?? [];
  });

const loadArrivals = () =>
  cached('arrivals', TTL.arrival, async () => (await upaPost('/cmm/init/getArrivalVesselList.do')).result ?? []);

const loadWharf = () =>
  cached('wharf', TTL.wharf, async () => (await upaPost('/cmm/init/getWharf.do')).result ?? []);

function meta(results, source) {
  const fetchedAt = Math.min(...results.map((r) => r.fetchedAt));
  const stale = results.some((r) => r.stale);
  return { source, fetchedAt: new Date(fetchedAt).toISOString(), stale };
}

/** 시설 정의 + getWharf 제원 병합 */
async function facilitiesWithSpecs() {
  const wharf = await loadWharf();
  const facilities = SK_FACILITIES.map((f) => {
    const rows = wharf.value.filter((w) => matchSkFacility(w.whrfNm) === f.id);
    const located = rows.find((w) => Number(w.lat) && Number(w.lng));
    const specs = rows.map((w) => ({
      operator: blank(w.userInfo),
      ownership: blank(w.seNm1),
      length: blank(w.lngth),
      depth: blank(w.dpthWtr),
      capacity: blank(w.brthdCap),
      berths: blank(w.brthdShipCnt),
      cargo: blank(w.trtmntCrg),
      code: w.fcltyCd ? `${w.fcltyCd}-${w.fcltySubCd ?? ''}` : null,
    }));
    return {
      ...f,
      lat: located ? Number(located.lat) : f.lat,
      lng: located ? Number(located.lng) : f.lng,
      approx: located ? false : Boolean(f.approx),
      port: located?.prtNm ?? rows[0]?.prtNm ?? '울산본항',
      specs,
    };
  });
  return { facilities, wharf };
}

function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 계류 중인데 PortWise 위치시설명이 없는 선박: 시설 좌표 반경 안이면 '근접 추정'으로 배정 */
function nearestFacility(facilities, lat, lng) {
  let best = null;
  for (const f of facilities) {
    if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue;
    const limit = f.kind === 'buoy' ? 600 : 250;
    const d = distanceM(lat, lng, f.lat, f.lng);
    if (d <= limit && (!best || d < best.d)) best = { id: f.id, d };
  }
  return best?.id ?? null;
}

/** 지도/목록용 선박: 유류·케미칼·가스 운반선 + SK 시설 위 미분류 선박 */
export async function getVessels({ includeShipyard = false } = {}) {
  const [ais, arrivals, { facilities, wharf }] = await Promise.all([loadAis(), loadArrivals(), facilitiesWithSpecs()]);
  const arrivalByMmsi = new Map();
  for (const a of arrivals.value) if (a.aisMmsi) arrivalByMmsi.set(String(a.aisMmsi), a);

  const vessels = [];
  let shipyardHidden = 0;
  for (const v of ais.value) {
    const mmsi = v.aisMmsi ? String(v.aisMmsi) : null;
    const arr = mmsi ? arrivalByMmsi.get(mmsi) : undefined;
    const lat = Number(v.lat);
    const lng = Number(v.lot);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    let facilityName = blank(arr?.aisFcltNm);
    let skFacility = matchSkFacility(facilityName, arr?.aisFcltCd);
    let facilitySource = skFacility ? 'portwise' : null;
    const moored = Number(v.oprtlSttsCd) === 5 || (Number(v.sog) <= 0.3 && Number(v.oprtlSttsCd) !== 1);
    if (!skFacility && !facilityName && moored) {
      skFacility = nearestFacility(facilities, lat, lng);
      if (skFacility) facilitySource = 'proximity';
    }

    const type = classify(v.vsslTp, v.aisVsslTpCd, skFacility);
    if (!type) continue;
    const dest = blank(v.aisDtn);
    const shipyard = !skFacility && dest != null && SHIPYARD_DEST.test(dest);
    if (shipyard && !includeShipyard) {
      shipyardHidden++;
      continue;
    }
    const hd = Number(v.hd);
    vessels.push({
      id: v.vsslId ?? mmsi,
      mmsi,
      imo: blank(v.aisVsslInnb),
      callSign: blank(v.portCallSgn) ?? blank(v.aisCallSgn),
      ...names(blank(v.aisVsslNm) ?? blank(arr?.portVsslEngNm), blank(arr?.portVsslNm)),
      type,
      typeKr: VESSEL_TYPES[type].kr,
      cargo: VESSEL_TYPES[type].cargo,
      rawType: v.vsslTp ?? null,
      flag: blank(v.ntnCd),
      nationality: blank(v.vsslNtnlty),
      domestic: v.ocCt === '내항' ? 'in' : v.ocCt === '외항' ? 'out' : 'unknown',
      length: Number(v.aisVsslLen) || null,
      width: Number(v.aisVsslWidth) || null,
      draft: Number(v.drft) || null,
      grossTon: Number(v.grsTn) || null,
      lat,
      lng,
      sog: Number(v.sog) || 0,
      cog: Number(v.cog) || 0,
      heading: Number.isFinite(hd) && hd >= 0 && hd < 360 ? hd : null,
      navStatus: v.oprtlSttsCd == null ? 15 : Number(v.oprtlSttsCd),
      navStatusKr: v.oprtlSttsKr ?? NAV_STATUS_KR[Number(v.oprtlSttsCd)] ?? '상태미확인',
      destination: dest,
      destinationCode: blank(v.aisDtnHrbrCd),
      departure: blank(v.aisDptre),
      eta: blank(v.aisArvlTm),
      toUlsan: v.aisDtnHrbrCd === 'KRUSN',
      shipyard,
      updated: blank(v.updtTm),
      aisSource: blank(v.aisSrc),
      facilityName,
      skFacility,
      facilitySource,
      port: portPlan(arr),
    });
  }
  return {
    vessels,
    shipyardHidden,
    ...meta([ais, arrivals, wharf], 'UPA PortWise · 해양수산부 AIS(T-AIS/S-AIS) · PORT-MIS'),
  };
}

const PLAN_FIELDS = [
  ['pmUseFacNm', 'pmUseFacCd', 'pmUsePeriod', '사용'],
  ['pmAllotFacNm', 'pmAllotFacCd', 'pmAllotPeriod', '배정'],
  ['pmReqFacNm', 'pmReqFacCd', 'pmReqPeriod', '신청'],
];

/** SK 시설 현황: 제원 + AIS 계류 선박 + PORT-MIS 신청/배정/사용 계획 */
export async function getFacilities() {
  const [{ facilities, wharf }, vesselsResult, arrivals] = await Promise.all([
    facilitiesWithSpecs(),
    getVessels({ includeShipyard: true }),
    loadArrivals(),
  ]);
  const byId = new Map(facilities.map((f) => [f.id, { ...f, alongside: [], scheduled: [] }]));

  for (const v of vesselsResult.vessels) {
    if (v.skFacility && byId.has(v.skFacility)) {
      byId.get(v.skFacility).alongside.push({
        id: v.id, mmsi: v.mmsi, name: v.name, nameKr: v.nameKr, typeKr: v.typeKr, cargo: v.cargo,
        facilityName: v.facilityName, facilitySource: v.facilitySource, navStatusKr: v.navStatusKr,
        length: v.length, grossTon: v.grossTon, lat: v.lat, lng: v.lng, port: v.port,
      });
    }
  }
  const alongsideMmsi = new Set(vesselsResult.vessels.filter((v) => v.skFacility).map((v) => v.mmsi));

  for (const a of arrivals.value) {
    if ((a.pmCurrentStatus ?? '').trim() === '출항') continue;
    for (const [nmKey, cdKey, periodKey, stage] of PLAN_FIELDS) {
      const fid = matchSkFacility(a[nmKey], a[cdKey]);
      if (!fid || !byId.has(fid)) continue;
      if (a.aisMmsi && alongsideMmsi.has(String(a.aisMmsi)) && matchSkFacility(a.aisFcltNm) === fid) break;
      byId.get(fid).scheduled.push({
        mmsi: blank(a.aisMmsi),
        callSign: blank(a.portCallSgn),
        ...names(blank(a.portVsslEngNm) ?? blank(a.aisVsslNm), blank(a.portVsslNm)),
        stage,
        facilityName: a[nmKey],
        period: blank(a[periodKey]),
        status: blank(a.pmCurrentStatus?.trim()),
        arrival: blank(a.pmArvlDt),
        location: blank(a.aisFcltNm) ?? blank(a.pmArvlFacNm),
      });
      break;
    }
  }
  const list = [...byId.values()];
  for (const f of list) f.scheduled.sort((x, y) => String(x.period ?? '').localeCompare(String(y.period ?? '')));
  return {
    facilities: list,
    ...meta([wharf, arrivals], 'UPA PortWise 접안시설·PORT-MIS 시설사용 신청/허가'),
  };
}

export async function getVesselDetail(mmsi, callSign) {
  const r = await upaPost('/cmm/init/getVesselDetailInfo.do', { form: { mmsi, callSgn: callSign ?? '' } });
  return {
    averageVoyageHours: blank(r.averge),
    facilityUseHours: blank(r.usage),
    grossTon: r.ataTon?.grsTn ?? null,
    portArrival: r.ataTon?.portArvlTm ?? null,
    port: portPlan(r.status),
    facilityName: blank(r.status?.aisFcltNm),
    skFacility: matchSkFacility(r.status?.aisFcltNm, r.status?.aisFcltCd),
  };
}

export async function getVesselRoute(mmsi) {
  const r = await upaPost('/cmm/init/getVoyageRoute.do', { form: { mmsi } });
  const pts = (list) =>
    (list ?? []).map((p) => ({ lat: Number(p.lat), lng: Number(p.lot), sog: p.sog, t: p.updtTm1 })).filter((p) => Number.isFinite(p.lat));
  return { today: pts(r.today), past: pts(r.other) };
}

export async function getWeather() {
  const [obs, wave] = await Promise.all([
    cached('weather', TTL.weather, () => upaPost('/cmm/init/getWeatherList.do')),
    cached('wave', TTL.weather, () => upaPost('/cmm/init/getSeaWaveHeightApiData.do')),
  ]);
  const w = obs.value;
  const sea = w.result;
  const air = w.airPollution;
  // PortWise 원본과 동일하게 fcstDate 에서 9시간을 빼서 발표시각으로 표시 (ny=83: 울산본항·신항 격자, 그 외: 온산항)
  const land = (w.ulsan ?? []).map((u) => ({
    grid: `${u.nx},${u.ny}`,
    areas: u.ny === '83' ? ['울산본항', '울산신항'] : ['온산항'],
    fcstDate: u.fcstDate,
    sky: u.sky,
    pty: u.pty,
    pop: u.pop,
    pcp: u.pcp,
  }));
  const wh = wave.value.seaWaveHeight;
  return {
    sea: sea && {
      station: sea.obsvtrNm, observedAt: sea.obsrvnDt, windDir: sea.wndrct, windSpeed: sea.wspd,
      gust: sea.maxMmntWspd, airTemp: sea.artmp, pressure: sea.atmpr, waterTemp: sea.wtem,
      tide: sea.bscTdlvHgt, salinity: sea.slntQty,
    },
    air: air && {
      station: air.mangName, observedAt: air.dataTime, so2: air.so2Value, o3: air.o3Value, no2: air.no2Value,
      pm10: air.pm10Value, pm10_24h: air.pm10Value24, pm25: air.pm25Value, pm25_24h: air.pm25Value24, khai: air.khaiValue,
    },
    land,
    wave: wh && {
      station: wh.name, observedAt: wh.tm4, significant: wh.whSig, max: wh.whMax, average: wh.whAve, period: wh.wp,
    },
    sources: {
      sea: { org: '국립해양조사원', interval: '10분' },
      air: { org: '한국환경공단(에어코리아)', interval: '매시 15분 내외' },
      land: { org: '기상청 단기예보', interval: '1시간' },
      wave: { org: '기상청 해양기상관측(파고부이)', interval: '1시간' },
    },
    ...meta([obs, wave], 'UPA PortWise 중계'),
  };
}

export async function getSeaFog() {
  const r = await cached('seafog', TTL.fog, () => upaPost('/cmm/init/getSeaFogProbability.do'));
  const list = r.value.seaFogProbaList ?? [];
  const labels = ['1시간 후', '3시간 후', '6시간 후'];
  return {
    station: list[0]?.obsvtrNm ?? '울산항',
    forecasts: list.slice(0, 3).map((p, i) => ({
      label: labels[i] ?? `${i + 1}`,
      at: p.predcDt,
      probability: p.crctSfogRpblty,
      rawProbability: p.orgnlSfogRpblty,
    })),
    sourceOrg: { org: '해양수산부 해무 발생 예측', interval: '1시간' },
    ...meta([r], 'UPA PortWise 중계'),
  };
}

export async function getShipping() {
  const [fi, oil] = await Promise.all([
    cached('freight', TTL.shipping, () => upaPost('/cmm/init/getFreightIndex.do')),
    cached('oil', TTL.shipping, () => upaPost('/cmm/init/getInternationalOilPrice.do')),
  ]);
  const freight = (Array.isArray(fi.value) ? fi.value : []).map((x) => ({ year: x.yr, scfi: x.scfi, ccfi: x.ccfi, bdi: x.bdi }));
  const o = oil.value ?? {};
  const price = (p) => p && { price: p.prc, currency: p.cur, at: p.crtnDt };
  return {
    freight,
    latestFreight: freight.at(-1) ?? null,
    oil: { wti: price(o.wti), brent: price(o.brent), dubai: price(o.dubai) },
    sources: {
      freight: { org: '공공데이터포털(해상운임지수)' },
      oil: { org: 'oilpriceapi', currency: 'USD' },
    },
    ...meta([fi, oil], 'UPA PortWise 중계'),
  };
}

export async function getCongestion(date, time) {
  if (!/^\d{8}$/.test(date) || !/^\d{4}$/.test(time)) {
    const err = new Error('date=YYYYMMDD, time=HHMM 형식이어야 합니다');
    err.status = 400;
    throw err;
  }
  const r = await cached(`congestion:${date}${time}`, TTL.congestion, () =>
    upaPost('/cmm/init/getSeaTfcCongstFcst.do', { json: { date, time } }),
  );
  const cells = (Array.isArray(r.value) ? r.value : []).map((c) => ({
    id: c.gridId, lat: c.latitude, lng: c.longitude, index: c.congestionIndex, level: c.congestionLevel,
    wave: c.forecastWaveHeight, wind: c.forecastWindSpeed, createdAt: c.fcstCreateDateTime,
  }));
  return { cells, ...meta([r], 'UPA PortWise 중계 · 해양교통 혼잡 예보') };
}

const LAYERS = {
  anchorage: '/cmm/init/getAnchorage.do',
  route: '/cmm/init/getPortRoute.do',
  reporting: '/cmm/init/getReportingLine.do',
  pilot: '/cmm/init/getPilotEmbarkationArea.do',
};

export async function getLayer(name) {
  const path = LAYERS[name];
  if (!path) {
    const err = new Error(`unknown layer: ${name}`);
    err.status = 404;
    throw err;
  }
  const r = await cached(`layer:${name}`, TTL.layer, () => upaPost(path));
  const raw = r.value;
  return { name, data: raw.result ?? raw.barkAreaList ?? [], ...meta([r], 'UPA PortWise 시설정보') };
}
