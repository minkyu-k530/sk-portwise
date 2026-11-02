/* global L */
// SK 울산 액체부두 선박운항 정보공유 — 2D 지도 화면.
// 데이터는 mock-api.js 가 브라우저 안에서 만든다(3D 뷰와 같은 가상 시뮬레이션 + 고정 목업). 외부 API 를 부르지 않는다.
import { SOURCE, api } from './mock-api.js';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => (v == null ? '' : String(v).replace(/[&<>"']/g, (c) => ESC[c]));
const dash = (v, unit = '') => (v == null || v === '' ? '-' : `${esc(v)}${unit}`);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ── 상수 ──────────────────────────────────────────────────────────────────
const TYPES = [
  ['TANKER', 'TANKER', '유조선'],
  ['GENERAL_TANKER', 'GENERAL TANKER', '일반 유조선'],
  ['TANKER_CRUDE', 'TANKER CRUDE', '원유 운반선'],
  ['TANKER_PRODUCT', 'TANKER PRODUCT', '석유제품 운반선'],
  ['TANKER_CHEMICALS', 'TANKER CHEMICALS', '케미컬 운반선'],
  ['GAS_CARRIER', 'GAS CARRIER', '가스 운반선'],
  ['LNG_CARRIER', 'LNG CARRIER', 'LNG 운반선'],
  ['UNCLASSIFIED_AT_SK', 'UNCLASSIFIED', '미분류 (SK 시설 내)'],
];
const CARGO = {
  oil: { kr: '유류', color: '#e2621b' },
  chemical: { kr: '케미칼', color: '#8e44ad' },
  gas: { kr: '가스', color: '#1e88e5' },
  unknown: { kr: '미분류', color: '#7f8c8d' },
};
const DEST_COLOR = { ulsan: '#f03c4a', other: '#22b04b' };
const NAV_STATUS = [
  [0, 'Using Engine', '항해(동력)'],
  [8, 'Sailing', '항해(범주)'],
  [1, 'At Anchor', '정박(앵커링)'],
  [5, 'Moored', '정박(계류)'],
  [3, 'Restricted maneuverability', '기동 제한'],
  [2, 'Not Under Command', '조종 불능'],
  [4, 'Constrained by draught', '흘수 제약'],
  [6, 'Aground', '좌초'],
  [15, 'Unconfirmed', '상태미확인'],
];
const FOG_STATUS = (p) => (p <= 20 ? '매우 맑음' : p <= 40 ? '맑음' : p <= 60 ? '보통' : p <= 80 ? '짙음' : '매우 짙음');
const CONGESTION_COLOR = { 매우낮음: '#2b8a3e', 낮음: '#40c057', 보통: '#fab005', 높음: '#fd7e14', 매우높음: '#e03131' };
const REFRESH_MS = 5_000;

// ── 상태 ──────────────────────────────────────────────────────────────────
const state = {
  vessels: [],
  facilities: [],
  routeMmsi: null, // 정적 모드: 스냅샷에 항적이 있는 MMSI 집합
  fetchedAt: null,
  stale: false,
  filter: {
    dom: new Set(['in', 'out', 'unknown']),
    types: new Set(TYPES.map((t) => t[0])),
    skOnly: false,
    shipyard: false,
  },
  colorBy: 'dest',
  layers: { sk: true, labels: true, cog: true },
  selected: null,
  routeFor: null,
  panel: null,
  cache: {},
  boardFocus: null,
};

// ── 지도 ──────────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true, minZoom: 9, maxZoom: 18, worldCopyJump: false }).setView([35.478, 129.4], 14);
const baseLayers = {
  map: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }),
  sky: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Imagery &copy; Esri',
  }),
};
baseLayers.map.addTo(map);
const encLayer = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: 'Seamarks &copy; OpenSeaMap',
});

const groups = {
  overlay: L.layerGroup().addTo(map),
  congestion: L.layerGroup().addTo(map),
  route: L.layerGroup().addTo(map),
  cog: L.layerGroup().addTo(map),
  sk: L.layerGroup().addTo(map),
  vessels: L.layerGroup().addTo(map),
  measure: L.layerGroup().addTo(map),
};
const overlayLayers = {}; // name -> L.LayerGroup

$$('.seg button').forEach((b) =>
  b.addEventListener('click', () => {
    $$('.seg button').forEach((x) => x.classList.toggle('on', x === b));
    for (const [k, layer] of Object.entries(baseLayers)) {
      if (k === b.dataset.base) layer.addTo(map);
      else map.removeLayer(layer);
    }
  }),
);
$('#encToggle').addEventListener('click', (e) => {
  const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  e.currentTarget.setAttribute('aria-pressed', String(on));
  if (on) encLayer.addTo(map);
  else map.removeLayer(encLayer);
});

// 좌표 표시 (원본: N35°29'7.8 / E129°24'17.64 / (35.4855, 129.4049))
function dms(v, pos, neg) {
  const h = v >= 0 ? pos : neg;
  const a = Math.abs(v);
  const d = Math.floor(a);
  const mFloat = (a - d) * 60;
  const m = Math.floor(mFloat);
  const s = ((mFloat - m) * 60).toFixed(2);
  return `${h}${d}°${m}'${s}"`;
}
function showCoord(ll) {
  $('#coord').textContent = `${dms(ll.lat, 'N', 'S')}\n${dms(ll.lng, 'E', 'W')}\n(${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)})`;
}
map.on('mousemove', (e) => showCoord(e.latlng));
showCoord(map.getCenter());

// ── 거리 측정 ─────────────────────────────────────────────────────────────
const measure = { on: false, pts: [], line: null, tip: null };
function fmtDist(m) {
  return `${m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m'} · ${(m / 1852).toFixed(2)} NM`;
}
function resetMeasure() {
  groups.measure.clearLayers();
  measure.pts = [];
  measure.line = null;
  measure.tip = null;
}
$('#measureToggle').addEventListener('change', (e) => {
  measure.on = e.target.checked;
  map.getContainer().style.cursor = measure.on ? 'crosshair' : '';
  if (measure.on) map.doubleClickZoom.disable();
  else {
    map.doubleClickZoom.enable();
    resetMeasure();
  }
});
map.on('click', (e) => {
  if (!measure.on) return;
  measure.pts.push(e.latlng);
  L.circleMarker(e.latlng, { radius: 4, color: '#23324a', fillColor: '#fff', fillOpacity: 1, weight: 2 }).addTo(groups.measure);
  if (!measure.line) measure.line = L.polyline(measure.pts, { color: '#e8590c', weight: 3, dashArray: '6 4' }).addTo(groups.measure);
  else measure.line.setLatLngs(measure.pts);
  let total = 0;
  for (let i = 1; i < measure.pts.length; i++) total += map.distance(measure.pts[i - 1], measure.pts[i]);
  if (measure.tip) groups.measure.removeLayer(measure.tip);
  measure.tip = L.tooltip({ permanent: true, direction: 'right', className: 'measure-tip', offset: [8, 0] })
    .setLatLng(e.latlng)
    .setContent(measure.pts.length < 2 ? '시작점 (다음 지점을 클릭)' : fmtDist(total))
    .addTo(groups.measure);
});

// ── 선박 렌더링 ───────────────────────────────────────────────────────────
function vesselColor(v) {
  if (state.colorBy === 'cargo') return CARGO[v.cargo]?.color ?? CARGO.unknown.color;
  return v.toUlsan ? DEST_COLOR.ulsan : DEST_COLOR.other;
}
function shipSvg(fill, w, h) {
  return `<svg width="${w}" height="${h}" viewBox="0 0 10 24" preserveAspectRatio="none"><path d="M5 0L10 7V24H0V7Z" fill="${fill}" stroke="#141414" stroke-width="0.9" vector-effect="non-scaling-stroke"/></svg>`;
}
function vesselIcon(v) {
  const z = map.getZoom();
  let h = z >= 13 ? 18 : 14;
  let w = z >= 13 ? 8 : 7;
  if (z >= 15 && v.length) {
    const mpp = (156543.03392 * Math.cos((v.lat * Math.PI) / 180)) / 2 ** z;
    h = clamp(v.length / mpp, 18, 260);
    w = clamp((v.width || v.length / 6) / mpp, 8, 64);
  }
  const rot = v.heading ?? v.cog ?? 0;
  const html = `<div style="width:${w}px;height:${h}px;transform:rotate(${rot}deg)">${shipSvg(vesselColor(v), w, h)}</div>`;
  return L.divIcon({
    className: `vessel-icon${state.selected === v.id ? ' selected' : ''}`,
    html,
    iconSize: [w, h],
    iconAnchor: [w / 2, h / 2],
  });
}
function destPoint(lat, lng, bearingDeg, meters) {
  const R = 6371000;
  const br = (bearingDeg * Math.PI) / 180;
  const p1 = (lat * Math.PI) / 180;
  const l1 = (lng * Math.PI) / 180;
  const d = meters / R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(br));
  const l2 = l1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [(p2 * 180) / Math.PI, (l2 * 180) / Math.PI];
}

function visibleVessels() {
  const f = state.filter;
  return shipPool().filter(
    (v) => f.dom.has(v.domestic) && f.types.has(v.type) && (!f.skOnly || v.skFacility),
  );
}
/** 조선소 시운전·계선 선박 숨김만 적용한 목록 (검색·목록·필터 집계 기준) */
function shipPool() {
  return state.filter.shipyard ? state.vessels : state.vessels.filter((v) => !v.shipyard);
}
function routeAvailable(v) {
  return Boolean(v.mmsi) && (!state.routeMmsi || state.routeMmsi.has(v.mmsi));
}

function hoverHtml(v) {
  return `<b>${esc(v.name)}</b>${v.nameKr ? ` (${esc(v.nameKr)})` : ''}<br>${esc(v.typeKr)} · ${esc(v.navStatusKr)}<br>${v.sog.toFixed(1)} kn · ${v.destination ? esc(v.destination) : '목적지 미입력'}`;
}

function renderVessels() {
  groups.vessels.clearLayers();
  groups.cog.clearLayers();
  const showLabels = state.layers.labels && map.getZoom() >= 14;
  for (const v of visibleVessels()) {
    const m = L.marker([v.lat, v.lng], {
      icon: vesselIcon(v),
      keyboard: false,
      zIndexOffset: state.selected === v.id ? 1000 : v.skFacility ? 200 : 0,
    });
    if (showLabels) m.bindTooltip(esc(v.name), { permanent: true, direction: 'right', offset: [6, 0], className: 'vessel-label' });
    else m.bindTooltip(hoverHtml(v), { direction: 'top', offset: [0, -8], className: 'vessel-hover' });
    m.on('click', (e) => {
      if (measure.on) {
        map.fire('click', { latlng: e.latlng });
        return;
      }
      selectVessel(v.id, { fly: false });
    });
    m.addTo(groups.vessels);
    // 계류 중(SK 시설) 선박의 SOG 잡음은 무시, 3분 후 예상 위치까지 COG 벡터
    if (state.layers.cog && !v.skFacility && v.sog >= 0.5 && v.sog < 40) {
      const end = destPoint(v.lat, v.lng, v.cog, (v.sog * 1852) / 20);
      L.polyline([[v.lat, v.lng], end], { color: '#2fa6ff', weight: 2, interactive: false }).addTo(groups.cog);
    }
  }
}
map.on('zoomend', renderVessels);

// ── SK 시설 마커 ─────────────────────────────────────────────────────────
function facilityPopupHtml(f) {
  const spec = f.specs[0] ?? {};
  const rows = f.alongside
    .map((v) => `<li><a href="#" data-select="${esc(v.id)}">${esc(v.name)}</a> <small>${esc(v.facilityName ?? '')} · ${esc(v.typeKr)}</small></li>`)
    .join('');
  return `<div style="min-width:220px">
    <b style="font-size:14px">${esc(f.label)}</b> ${f.approx ? '<span class="badge approx">위치 근사</span>' : ''}<br>
    <small>${esc(f.specs.map((s) => s.operator).filter(Boolean).join(', ') || '-')} · ${esc(f.port)}</small><br>
    <small>접안능력 ${dash(spec.capacity)} DWT · 수심 ${dash(spec.depth, 'm')} · ${dash(spec.cargo)}</small>
    <div style="margin-top:6px;font-weight:700">접안 중 ${f.alongside.length}척 · 예정 ${f.scheduled.length}건</div>
    ${rows ? `<ul style="margin:4px 0 0;padding-left:16px">${rows}</ul>` : ''}
    <div style="margin-top:6px"><a href="#/berths" data-board="${esc(f.id)}">SK 부두 현황에서 보기 →</a></div>
  </div>`;
}
function renderFacilities() {
  groups.sk.clearLayers();
  if (!state.layers.sk) return;
  for (const f of state.facilities) {
    if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue;
    const short = f.kind === 'buoy' ? `SK${f.no} Buoy` : `SK${f.no}`;
    const cls = ['sk-marker', f.kind === 'buoy' ? 'buoy' : '', f.approx ? 'approx' : '', f.alongside.length ? 'busy' : ''].join(' ');
    const m = L.marker([f.lat, f.lng], {
      icon: L.divIcon({ className: cls, html: `<div>${short}${f.alongside.length ? ` · ${f.alongside.length}` : ''}</div>`, iconSize: [0, 0] }),
      zIndexOffset: -100,
      keyboard: false,
    });
    m.bindPopup(() => facilityPopupHtml(f), { maxWidth: 320 });
    m.addTo(groups.sk);
    if (f.kind === 'buoy') {
      L.circle([f.lat, f.lng], {
        radius: 350, color: '#ea7600', weight: 1.5, dashArray: f.approx ? '4 4' : null, fillOpacity: 0.06, interactive: false,
      }).addTo(groups.sk);
    }
  }
}
map.on('popupopen', (e) => {
  const el = e.popup.getElement();
  el?.querySelectorAll('[data-select]').forEach((a) =>
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      map.closePopup();
      selectVessel(a.dataset.select, { fly: true });
    }),
  );
  el?.querySelectorAll('[data-board]').forEach((a) =>
    a.addEventListener('click', () => {
      state.boardFocus = a.dataset.board;
    }),
  );
});
function focusFacility(id) {
  const f = state.facilities.find((x) => x.id === id);
  if (!f) return;
  location.hash = '#/map';
  map.flyTo([f.lat, f.lng], Math.max(map.getZoom(), f.kind === 'buoy' ? 14 : 16), { duration: 0.6 });
  map.once('moveend', () => {
    groups.sk.eachLayer((l) => {
      if (l instanceof L.Marker && l.getLatLng().equals([f.lat, f.lng])) l.openPopup();
    });
  });
}

// ── 선박 정보 카드 ────────────────────────────────────────────────────────
const SHIP_SIDE = (color) => `<svg viewBox="0 0 220 70" aria-hidden="true">
  <path d="M6 44h200l-14 18H22z" fill="${color}"/>
  <path d="M6 44h200" stroke="#0e1726" stroke-width="2"/>
  <rect x="150" y="18" width="30" height="26" fill="#f2f4f7" stroke="#0e1726" stroke-width="1.5"/>
  <rect x="156" y="8" width="18" height="10" fill="#f2f4f7" stroke="#0e1726" stroke-width="1.5"/>
  <rect x="162" y="2" width="6" height="6" fill="#0e1726"/>
  <path d="M24 44V38h118v6M40 38V32h86v6" fill="none" stroke="#0e1726" stroke-width="1.5"/>
  <path d="M50 32v-6M70 32v-6M90 32v-6M110 32v-6" stroke="#0e1726" stroke-width="1.5"/>
  <path d="M0 66c12 3 22-3 34 0s22 3 34 0 22-3 34 0 22 3 34 0 22-3 34 0 22 3 34 0" fill="none" stroke="#5fb4ff" stroke-width="2"/>
</svg>`;

function fmtTime(v) {
  if (v == null) return '-';
  if (typeof v === 'number') {
    const d = new Date(v);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return esc(String(v).replace(/:00$/, '').slice(0, 16));
}
function portRows(p) {
  if (!p) return '<tr><td colspan="2" class="note">입항·시설사용 정보 없음</td></tr>';
  const row = (k, fac, per) => (fac || per ? `<tr><th>${k}</th><td>${dash(fac)}${per ? `<br><span class="note">${esc(per)}</span>` : ''}</td></tr>` : '');
  return `
    <tr><th>진행 상태</th><td><b>${dash(p.status)}</b>${p.voyage ? ` <span class="note">항차 ${esc(p.voyage)}</span>` : ''}</td></tr>
    ${row('입항', p.arrivalFacility, p.arrival)}
    ${row('시설 신청', p.requestFacility, p.requestPeriod)}
    ${row('시설 배정', p.allotFacility, p.allotPeriod)}
    ${row('시설 사용', p.useFacility, p.usePeriod)}
    ${row('출항', p.departureFacility, p.departure)}`;
}
function renderCard(v, detail) {
  const card = $('#shipCard');
  const color = CARGO[v.cargo]?.color ?? CARGO.unknown.color;
  const fac = state.facilities.find((f) => f.id === v.skFacility);
  const loc = v.facilityName
    ? `${esc(v.facilityName)}${fac ? ` <span class="chip sk">${esc(fac.label)}</span>` : ''}`
    : fac
      ? `<span class="chip sk">${esc(fac.label)}</span> <span class="note">근접 추정</span>`
      : esc(v.navStatusKr);
  const detailRows =
    detail === undefined
      ? '<tr><td colspan="2" class="note">상세 정보 조회 중…</td></tr>'
      : detail === null
        ? '<tr><td colspan="2" class="note">상세 정보를 불러오지 못했습니다</td></tr>'
        : `<tr><th>항차 사용</th><td>${dash(detail.averageVoyageHours, ' 시간')}<br><span class="note">(전년 및 올해 항차 평균 시간)</span></td></tr>
           <tr><th>시설 사용</th><td>${dash(detail.facilityUseHours, ' 시간')}<br><span class="note">(이전 항차 시설 사용 시간)</span></td></tr>`;
  const port = detail?.port ?? v.port;
  card.innerHTML = `
    <div class="hd" style="background:linear-gradient(180deg,#eaf3ff,#cfe3fb)">${SHIP_SIDE(color)}
      <button class="close" aria-label="닫기" data-act="close">×</button></div>
    <div class="actions">
      <button data-act="route" class="${state.routeFor === v.mmsi ? 'on' : ''}" ${routeAvailable(v) ? '' : 'disabled title="MMSI 없음"'}>항해경로 표시하기</button>
      <button data-act="3d">3D로 보기</button>
      <button data-act="center">위치로 이동</button>
    </div>
    <table>
      <tr><th>국적</th><td><span class="flag">${dash(v.flag)}</span>${dash(v.nationality)}</td></tr>
      <tr><th>선박명</th><td><span class="name">${esc(v.name)}</span>${v.nameKr ? `<br>${esc(v.nameKr)}` : ''}</td></tr>
      <tr><th>실시간 위치</th><td>${loc}<br><span class="note">${v.lat.toFixed(5)}, ${v.lng.toFixed(5)}</span></td></tr>
      <tr><th>MMSI</th><td>${dash(v.mmsi)}</td></tr>
      <tr><th>IMO</th><td>${dash(v.imo)}</td></tr>
      <tr><th>호출부호</th><td>${dash(v.callSign)}</td></tr>
      <tr><th>선박 타입</th><td>${esc(v.typeKr)} <span class="chip" style="background:${color}">${esc(CARGO[v.cargo]?.kr ?? '')}</span>${v.rawType ? `<br><span class="note">${esc(v.rawType)}</span>` : ''}</td></tr>
      <tr><th>항행 상태</th><td>${esc(v.navStatusKr)} · ${v.sog.toFixed(1)} kn · COG ${v.cog}°${v.heading != null ? ` · HDG ${v.heading}°` : ''}</td></tr>
      <tr><th>제원</th><td>${v.length ? `${v.length} × ${v.width ?? '-'} m` : '-'} · 흘수 ${dash(v.draft, ' m')}<br>총톤수 ${v.grossTon ? v.grossTon.toLocaleString() : '-'} GT</td></tr>
      <tr><th>항로</th><td>${dash(v.departure)} → <b>${dash(v.destination)}</b><br><span class="note">ETA ${fmtTime(v.eta)}</span></td></tr>
      <tr><th>내외항</th><td>${v.domestic === 'in' ? '내항' : v.domestic === 'out' ? '외항' : '-'}</td></tr>
      ${detailRows}
      <tr><th>AIS 갱신</th><td>${fmtTime(v.updated)} <span class="note">${dash(v.aisSource)}</span></td></tr>
    </table>
    <div class="sec">입항·시설사용 (가상)</div>
    <table>${portRows(port)}</table>`;
  card.classList.remove('hidden');
}
// 카드는 갱신 때마다 다시 그리므로 click 대신 pointerdown 으로 받는다
$('#shipCard').addEventListener('pointerdown', async (e) => {
  if (e.button !== 0) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  const v = state.vessels.find((x) => x.id === state.selected);
  if (!act) return;
  if (act === 'close') return closeCard();
  if (!v) return;
  if (act === 'center') map.flyTo([v.lat, v.lng], Math.max(map.getZoom(), 15), { duration: 0.5 });
  if (act === 'route') await toggleRoute(v);
  if (act === '3d') location.href = `3d.html?vessel=${encodeURIComponent(v.id)}`;
});
function closeCard() {
  state.selected = null;
  $('#shipCard').classList.add('hidden');
  groups.route.clearLayers();
  state.routeFor = null;
  renderVessels();
}
async function toggleRoute(v) {
  groups.route.clearLayers();
  if (state.routeFor === v.mmsi) {
    state.routeFor = null;
    renderCard(v, state.cache[`detail:${v.mmsi}`]);
    return;
  }
  state.routeFor = v.mmsi;
  renderCard(v, state.cache[`detail:${v.mmsi}`]);
  try {
    const r = await api(`/vessels/${encodeURIComponent(v.mmsi)}/route`);
    if (state.routeFor !== v.mmsi) return;
    const past = r.past.map((p) => [p.lat, p.lng]);
    const today = r.today.map((p) => [p.lat, p.lng]);
    if (past.length) L.polyline(past, { color: '#6c7a91', weight: 2, dashArray: '5 5' }).bindTooltip('이전 항적').addTo(groups.route);
    if (today.length) L.polyline(today, { color: '#1f7bf2', weight: 3 }).bindTooltip('오늘 항적').addTo(groups.route);
    const all = [...past, ...today];
    if (all.length) map.fitBounds(L.latLngBounds(all).pad(0.15), { maxZoom: 15 });
    else toast('항적 데이터가 없습니다');
  } catch (err) {
    toast(`항적 조회 실패: ${err.message}`);
  }
}
async function selectVessel(id, { fly }) {
  const v = state.vessels.find((x) => x.id === id);
  if (!v) {
    toast('현재 AIS 목록에 없는 선박입니다 (필터·범위 확인)');
    return;
  }
  if (location.hash !== '#/map' && location.hash !== '') location.hash = '#/map';
  if (state.routeFor && state.routeFor !== v.mmsi) {
    groups.route.clearLayers();
    state.routeFor = null;
  }
  state.selected = id;
  // 필터에 가려진 선박이면 필터를 풀어 보이게 한다
  if (!visibleVessels().some((x) => x.id === id)) {
    state.filter.types.add(v.type);
    state.filter.dom.add(v.domestic);
    state.filter.skOnly = false;
    if (v.shipyard) state.filter.shipyard = true;
    syncFilterInputs();
  }
  renderVessels();
  if (fly) map.flyTo([v.lat, v.lng], Math.max(map.getZoom(), 15), { duration: 0.6 });
  const key = `detail:${v.mmsi}`;
  renderCard(v, state.cache[key]);
  if (!v.mmsi || state.cache[key] !== undefined) return;
  try {
    const d = await api(`/vessels/${encodeURIComponent(v.mmsi)}/detail?callSign=${encodeURIComponent(v.callSign ?? '')}`);
    state.cache[key] = d;
  } catch {
    state.cache[key] = null;
  }
  if (state.selected === id) renderCard(v, state.cache[key]);
}

// ── 토스트 ────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText =
      'position:absolute;left:50%;top:70px;transform:translateX(-50%);z-index:3000;background:#23324a;color:#fff;padding:8px 14px;border-radius:8px;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,.3)';
    $('.stage').append(el);
  }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

// ── 검색 ──────────────────────────────────────────────────────────────────
const searchInput = $('#searchInput');
const searchResults = $('#searchResults');
let searchActive = 0;
function searchItems(q) {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const fac = state.facilities
    .filter((f) => `${f.name} ${f.label}`.toLowerCase().replace(/\s/g, '').includes(s.replace(/\s/g, '')))
    .map((f) => ({ kind: 'facility', id: f.id, title: f.label, sub: `${f.kind === 'buoy' ? '부이' : '부두'} · 접안 ${f.alongside.length}` }));
  const ves = shipPool()
    .filter((v) => [v.name, v.nameKr, v.mmsi, v.callSign, v.imo].some((x) => x && String(x).toLowerCase().includes(s)))
    .slice(0, 30)
    .map((v) => ({ kind: 'vessel', id: v.id, title: v.name, sub: `${v.typeKr}${v.skFacility ? ` · ${v.skFacility}` : ''}` }));
  return [...fac, ...ves];
}
function renderSearch() {
  const items = searchItems(searchInput.value);
  searchActive = clamp(searchActive, 0, Math.max(0, items.length - 1));
  searchResults.innerHTML = items.length
    ? items
        .map((it, i) => `<li role="option" data-kind="${it.kind}" data-id="${esc(it.id)}" class="${i === searchActive ? 'active' : ''}"><span>${esc(it.title)}</span><small>${esc(it.sub)}</small></li>`)
        .join('')
    : searchInput.value.trim()
      ? '<li><small>검색 결과 없음</small></li>'
      : '';
  searchResults.classList.toggle('open', Boolean(searchInput.value.trim()));
  return items;
}
function pickSearch(li) {
  if (!li?.dataset.id) return;
  searchResults.classList.remove('open');
  if (li.dataset.kind === 'facility') focusFacility(li.dataset.id);
  else selectVessel(li.dataset.id, { fly: true });
}
searchInput.addEventListener('input', () => {
  searchActive = 0;
  renderSearch();
});
searchInput.addEventListener('keydown', (e) => {
  const lis = $$('li[data-id]', searchResults);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    searchActive = clamp(searchActive + (e.key === 'ArrowDown' ? 1 : -1), 0, Math.max(0, lis.length - 1));
    renderSearch();
  } else if (e.key === 'Enter') pickSearch(lis[searchActive]);
  else if (e.key === 'Escape') searchResults.classList.remove('open');
});
searchResults.addEventListener('click', (e) => pickSearch(e.target.closest('li')));
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search')) searchResults.classList.remove('open');
});

// ── 범례 ──────────────────────────────────────────────────────────────────
function renderLegend() {
  const ship = (c) => `<svg viewBox="0 0 10 24"><path d="M5 0L10 7V24H0V7Z" fill="${c}" stroke="#141414" stroke-width="1"/></svg>`;
  const items =
    state.colorBy === 'dest'
      ? [`<span>${ship(DEST_COLOR.ulsan)}To Ulsan</span>`, `<span>${ship(DEST_COLOR.other)}To Other</span>`]
      : Object.values(CARGO).map((c) => `<span>${ship(c.color)}${c.kr}</span>`);
  $('#legend').innerHTML = `${items.join('')}<span><i class="cog"></i>COG</span><span><i class="sk-dot"></i>SK 부두·부이</span>`;
}

// ── 도크 패널 ─────────────────────────────────────────────────────────────
const PANEL_RENDER = {
  filter: renderFilterPanel,
  layers: () => {},
  weather: renderWeatherPanel,
  shipping: renderShippingPanel,
  berth: renderBerthPanel,
  fog: renderFogPanel,
  congestion: renderCongestionPanel,
  live: renderLivePanel,
};
$$('.dock button').forEach((b) =>
  b.addEventListener('click', () => {
    const name = b.dataset.panel;
    state.panel = state.panel === name ? null : name;
    $$('.dock button').forEach((x) => x.classList.toggle('on', x.dataset.panel === state.panel));
    $$('.dock-panel').forEach((p) => p.classList.toggle('hidden', p.id !== `panel-${state.panel}`));
    $('.stage').classList.toggle('panel-open', Boolean(state.panel));
    if (state.panel) PANEL_RENDER[state.panel]();
  }),
);

function srcLine(parts) {
  return `<span class="src">${parts.filter(([, v]) => v != null && v !== '').map(([k, v]) => `<span><b>${esc(k)}</b>${esc(v)}</span>`).join('')}</span>`;
}
function metrics(list, cols) {
  return `<dl class="metric-grid" style="grid-template-columns:repeat(${cols},1fr)">${list
    .map(([k, v, unit, sub]) => `<div class="metric"><dt>${esc(k)}</dt><dd>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}${v == null || v === '' ? '-' : esc(v)}${unit && v != null && v !== '' ? `<small>${esc(unit)}</small>` : ''}</dd></div>`)
    .join('')}</dl>`;
}
async function cachedApi(key, path, maxAgeMs) {
  const hit = state.cache[key];
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.data;
  const data = await api(path);
  state.cache[key] = { at: Date.now(), data };
  return data;
}

// 선박 필터
function syncFilterInputs() {
  $$('#panel-filter [data-dom]').forEach((i) => (i.checked = state.filter.dom.has(i.dataset.dom)));
  $('#fSkOnly').checked = state.filter.skOnly;
  $('#fShipyard').checked = state.filter.shipyard;
  $$('#typeFilters input[data-type]').forEach((i) => (i.checked = state.filter.types.has(i.dataset.type)));
  const all = $('#typeFilters input[data-type="ALL"]');
  if (all) all.checked = state.filter.types.size === TYPES.length;
}
function renderFilterPanel() {
  const counts = {};
  const pool = shipPool();
  for (const v of pool) counts[v.type] = (counts[v.type] ?? 0) + 1;
  $('#typeFilters').innerHTML =
    `<label class="chk"><span><input type="checkbox" data-type="ALL"> 전체</span><span class="n">${pool.length}</span></label>` +
    TYPES.map(([key, en, kr]) => {
      const cargo = state.vessels.find((v) => v.type === key)?.cargo ?? (key.includes('CHEM') ? 'chemical' : key.includes('GAS') || key.includes('LNG') ? 'gas' : key.startsWith('UNCL') ? 'unknown' : 'oil');
      return `<label class="chk"><span><input type="checkbox" data-type="${key}"><i class="swatch" style="background:${CARGO[cargo].color}"></i>${en} <em>${kr}</em></span><span class="n">${counts[key] ?? 0}</span></label>`;
    }).join('');
  const hidden = state.vessels.filter((v) => v.shipyard).length;
  $('#shipyardCount').textContent = state.filter.shipyard ? '' : `(${hidden}척 숨김)`;
  syncFilterInputs();
}
$('#panel-filter').addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.dom) {
    if (t.checked) state.filter.dom.add(t.dataset.dom);
    else state.filter.dom.delete(t.dataset.dom);
  } else if (t.dataset.type === 'ALL') {
    state.filter.types = new Set(t.checked ? TYPES.map((x) => x[0]) : []);
  } else if (t.dataset.type) {
    if (t.checked) state.filter.types.add(t.dataset.type);
    else state.filter.types.delete(t.dataset.type);
  } else if (t.id === 'fSkOnly') {
    state.filter.skOnly = t.checked;
  } else if (t.id === 'fShipyard') {
    state.filter.shipyard = t.checked;
    renderFilterPanel();
  }
  syncFilterInputs();
  renderVessels();
  if (state.panel === 'live') renderLivePanel();
});

// 지도 설정
$('#panel-layers').addEventListener('change', async (e) => {
  const t = e.target;
  if (t.name === 'colorBy') {
    state.colorBy = t.value;
    renderLegend();
    renderVessels();
    return;
  }
  const name = t.dataset.layer;
  if (!name) return;
  if (name === 'sk' || name === 'labels' || name === 'cog') {
    state.layers[name] = t.checked;
    if (name === 'sk') renderFacilities();
    else renderVessels();
    return;
  }
  if (!t.checked) {
    overlayLayers[name] && groups.overlay.removeLayer(overlayLayers[name]);
    return;
  }
  try {
    overlayLayers[name] ??= await buildOverlay(name);
    if (t.checked) groups.overlay.addLayer(overlayLayers[name]);
  } catch (err) {
    t.checked = false;
    toast(`레이어 로드 실패: ${err.message}`);
  }
});
function splitRings(points, idxKey = 'idx') {
  const rings = [];
  let cur = [];
  let prev = -Infinity;
  for (const p of points) {
    if (cur.length && p[idxKey] <= prev) {
      rings.push(cur);
      cur = [];
    }
    cur.push([p.lat, p.lng]);
    prev = p[idxKey];
  }
  if (cur.length) rings.push(cur);
  return rings;
}
function groupBy(list, keyFn) {
  const m = new Map();
  for (const x of list) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}
const textLabel = (lat, lng, text) =>
  L.marker([lat, lng], { icon: L.divIcon({ className: 'layer-label', html: esc(text), iconSize: [0, 0] }), interactive: false, keyboard: false });
async function buildOverlay(name) {
  const { data } = await api(`/layers/${name}`);
  const g = L.layerGroup();
  if (name === 'anchorage') {
    const polys = data.filter((d) => d.anchrgTp === 'POLYGON').sort((a, b) => a.seqNo - b.seqNo);
    for (const [key, pts] of groupBy(polys, (d) => `${d.anchrgNm}|${d.fcltyCd}`)) {
      for (const ring of splitRings(pts)) {
        L.polygon(ring, { color: '#7048e8', weight: 1.5, fillOpacity: 0.06 }).bindTooltip(`정박지 ${esc(key.split('|')[0])}`).addTo(g);
      }
    }
    for (const d of data.filter((x) => x.anchrgTp === 'CIRCLE' || x.anchrgTp === 'BUNKER_RING')) {
      L.circle([d.lat, d.lng], { radius: d.rad, color: d.anchrgTp === 'BUNKER_RING' ? '#e8590c' : '#7048e8', weight: 1.5, fillOpacity: 0.06 })
        .bindTooltip(`${esc(d.anchrgNm)}${d.rmrk ? ` · ${esc(d.rmrk)}` : ''}`)
        .addTo(g);
    }
    for (const d of data.filter((x) => x.anchrgTp === 'TEXT')) textLabel(d.lat, d.lng, d.anchrgNm).addTo(g);
  } else if (name === 'route') {
    const lines = data.filter((d) => d.ttlYn !== 'Y').sort((a, b) => a.seqNo - b.seqNo);
    for (const [nm, pts] of groupBy(lines, (d) => d.rtNm)) {
      for (const ring of splitRings(pts)) L.polygon(ring, { color: '#1c7ed6', weight: 1.5, dashArray: '6 4', fillOpacity: 0.04 }).bindTooltip(esc(nm)).addTo(g);
    }
    for (const d of data.filter((x) => x.ttlYn === 'Y')) textLabel(d.lat, d.lng, d.rtNm).addTo(g);
  } else if (name === 'reporting') {
    for (const [nm, pts] of groupBy([...data].sort((a, b) => a.seqNo - b.seqNo), (d) => d.rprtLnNm)) {
      const ll = pts.map((p) => [p.lat, p.lng]);
      L.polyline(ll, { color: '#c2255c', weight: 2 }).bindTooltip(esc(nm)).addTo(g);
      textLabel(ll[0][0], ll[0][1], nm).addTo(g);
    }
  } else if (name === 'pilot') {
    for (const d of data) {
      L.circle([d.lat, d.lng], { radius: d.mileRad * 1852, color: '#2f9e44', weight: 1.5, fillOpacity: 0.05 })
        .bindTooltip(`${esc(d.areaNm)}<br>${esc(d.areaExpln ?? '')}`)
        .addTo(g);
      textLabel(d.lat, d.lng, d.areaNm).addTo(g);
    }
  }
  return g;
}

// 기상
const WIND_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const windDir = (deg) => (deg == null ? null : WIND_16[Math.round(Number(deg) / 22.5) % 16]);
const SKY = { 1: '맑음', 3: '구름많음', 4: '흐림' };
const PTY = { 0: '없음', 1: '비', 2: '비/눈', 3: '눈', 4: '소나기' };
function pcpText(p) {
  if (p == null || p === '-' || p === '강수없음' || p === 0 || p === '0') return '0';
  const n = parseFloat(String(p));
  if (!Number.isFinite(n)) return String(p);
  if (n < 1) return '1.0 미만';
  if (n < 30) return String(n);
  if (n < 50) return '30.0~50.0';
  return '50.0 이상';
}
function landIssued(fcstDate) {
  // fcstDate - 9h 를 발표시각으로 표시
  if (!fcstDate) return '-';
  const d = new Date(fcstDate.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return fcstDate;
  d.setHours(d.getHours() - 9);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
async function renderWeatherPanel() {
  const el = $('#panel-weather');
  if (!el.innerHTML) el.innerHTML = '<div class="empty">기상 정보를 불러오는 중…</div>';
  let w;
  try {
    w = await cachedApi('weather', '/weather', 5 * 60_000);
  } catch (err) {
    el.innerHTML = `<div class="err">기상 정보 조회 실패: ${esc(err.message)}</div>`;
    return;
  }
  const s = w.sea ?? {};
  const a = w.air ?? {};
  const wave = w.wave ?? {};
  const waveAt = wave.observedAt ? `${wave.observedAt.slice(0, 4)}-${wave.observedAt.slice(4, 6)}-${wave.observedAt.slice(6, 8)} ${wave.observedAt.slice(8, 10)}:00` : null;
  const landBlock = (area) => {
    const f = w.land.find((x) => x.areas.includes(area));
    return `<div class="metric-sec"><h3>육상기상[${esc(area)}] ${srcLine([['출처', w.sources.land.org], ['제공시각', f ? landIssued(f.fcstDate) : null], ['업데이트 주기', w.sources.land.interval]])}</h3>
      ${metrics([['하늘상태', f ? SKY[f.sky] ?? '-' : null], ['강수확률', f?.pop, '%'], ['강수형태', f ? PTY[f.pty] ?? '-' : null], ['강수량', f ? pcpText(f.pcp) : null, 'mm']], 4)}</div>`;
  };
  el.innerHTML = `
    <div class="metric-sec"><h3>해양기상 ${srcLine([['출처', w.sources.sea.org], ['관측소', s.station], ['제공시각', s.observedAt], ['업데이트 주기', w.sources.sea.interval]])}</h3>
      ${metrics([['풍향', windDir(s.windDir)], ['풍속', s.windSpeed, 'm/s'], ['최대순간풍속', s.gust, 'm/s'], ['기온', s.airTemp, '℃'], ['기압', s.pressure, 'hPa'], ['수온', s.waterTemp, '℃'], ['조위', s.tide, 'cm'], ['염분', s.salinity, 'psu']], 8)}</div>
    <div class="metric-sec"><h3>대기오염 ${srcLine([['출처', w.sources.air.org], ['측정소', a.station], ['제공시각', a.observedAt], ['업데이트 주기', w.sources.air.interval]])}</h3>
      ${metrics([['아황산가스', a.so2, 'ppm'], ['오존', a.o3, 'ppm'], ['이산화질소', a.no2, 'ppm'], ['미세먼지', a.pm10, '㎍/㎥'], ['미세먼지 24시', a.pm10_24h, '㎍/㎥'], ['초미세먼지', a.pm25, '㎍/㎥'], ['초미세먼지 24시간', a.pm25_24h, '㎍/㎥'], ['통합대기환경', a.khai]], 8)}</div>
    <div class="two-col">${landBlock('울산본항')}${landBlock('울산신항')}</div>
    <div class="two-col">${landBlock('온산항')}
      <div class="metric-sec"><h3>파고 ${srcLine([['출처', w.sources.wave.org], ['관측소', wave.station], ['제공시각', waveAt], ['업데이트 주기', w.sources.wave.interval]])}</h3>
      ${metrics([['유의파고', wave.significant, 'm'], ['최대파고', wave.max, 'm'], ['평균파고', wave.average, 'm'], ['파주기', wave.period, 'sec']], 4)}</div></div>
    ${w.stale ? '<div class="err">업스트림 응답 실패 — 직전 값 표시 중</div>' : ''}`;
}

// 해운
async function renderShippingPanel() {
  const el = $('#panel-shipping');
  if (!el.innerHTML) el.innerHTML = '<div class="empty">해운 정보를 불러오는 중…</div>';
  let d;
  try {
    d = await cachedApi('shipping', '/shipping', 30 * 60_000);
  } catch (err) {
    el.innerHTML = `<div class="err">해운 정보 조회 실패: ${esc(err.message)}</div>`;
    return;
  }
  const f = d.latestFreight ?? {};
  const o = d.oil;
  const oilCell = (k, p) => [k, p?.price, '', p ? fmtTime(p.at) : '-'];
  const history = d.freight
    .slice()
    .reverse()
    .map((x) => `<tr><td>${esc(x.year)}</td><td>${dash(x.scfi)}</td><td>${dash(x.ccfi)}</td><td>${dash(x.bdi)}</td></tr>`)
    .join('');
  el.innerHTML = `
    <div class="two-col">
      <div class="metric-sec"><h3>해상운임지수 ${srcLine([['출처', d.sources.freight.org], ['기준', f.year]])}</h3>
        ${metrics([['상하이운임지수', f.scfi, '', '(SCFI)'], ['중국컨테이너운임지수', f.ccfi, '', '(CCFI)'], ['발틱운임지수', f.bdi, '', '(BDI)']], 3)}</div>
      <div class="metric-sec"><h3>국제유가 ${srcLine([['출처', d.sources.oil.org], ['통화', d.sources.oil.currency]])}</h3>
        ${metrics([oilCell('WTI', o.wti), oilCell('Brent', o.brent), oilCell('Dubai', o.dubai)], 3)}</div>
    </div>
    <details><summary style="cursor:pointer;font-size:12.5px;margin:4px 0 8px">해상운임지수 연도별 보기</summary>
      <table class="dtable"><thead><tr><th>연도</th><th>SCFI</th><th>CCFI</th><th>BDI</th></tr></thead><tbody>${history}</tbody></table></details>`;
}

// 접안시설
function renderBerthPanel() {
  const el = $('#panel-berth');
  el.innerHTML = `<h3>SK 접안시설 ${srcLine([['출처', SOURCE], ['취급', '유류·케미칼·가스']])}</h3>
    <div class="berth-list">${state.facilities
      .map((f) => {
        const s = f.specs[0] ?? {};
        return `<div class="berth-item" data-fac="${esc(f.id)}">
          <div class="top"><span>${esc(f.label)}</span><span>${f.alongside.length ? `<span class="badge occ">접안 ${f.alongside.length}</span>` : '<span class="badge free">비어있음</span>'}${f.scheduled.length ? ` <span class="badge">예정 ${f.scheduled.length}</span>` : ''}${f.approx ? ' <span class="badge approx">위치 근사</span>' : ''}</span></div>
          <div class="meta">${esc(s.operator ?? '-')} · ${dash(s.capacity)} DWT · 수심 ${dash(s.depth, 'm')} · ${dash(s.cargo)}</div></div>`;
      })
      .join('')}</div>`;
}
$('#panel-berth').addEventListener('click', (e) => {
  const id = e.target.closest('[data-fac]')?.dataset.fac;
  if (id) focusFacility(id);
});

// 해무
async function renderFogPanel() {
  const el = $('#panel-fog');
  if (!el.innerHTML) el.innerHTML = '<div class="empty">해무 예측 정보를 불러오는 중…</div>';
  let d;
  try {
    d = await cachedApi('seafog', '/seafog', 10 * 60_000);
  } catch (err) {
    el.innerHTML = `<div class="err">해무 예측 조회 실패: ${esc(err.message)}</div>`;
    return;
  }
  const now = new Date();
  const issued = `${String(now.getFullYear()).slice(-2)}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:00`;
  const rows = d.forecasts.length
    ? d.forecasts
        .map((f) => `<tr><td>${esc(f.label)}</td><td>${esc(String(f.at ?? '').slice(11, 19) || '-')}</td><td>${FOG_STATUS(Number(f.probability))}</td><td><b>${dash(f.probability, '%')}</b></td></tr>`)
        .join('')
    : '<tr><td colspan="4">예측 자료 없음</td></tr>';
  el.innerHTML = `<h3>해무 발생 예측 정보 ${srcLine([['출처', d.sourceOrg.org], ['지점', d.station], ['제공시각', issued], ['업데이트 주기', d.sourceOrg.interval]])}</h3>
    <table class="dtable"><thead><tr><th>예측시간</th><th>시간</th><th>날씨</th><th>발생확률</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// 혼잡도
/** KST 기준 YYYYMMDD (offsetDays 일 뒤) — 혼잡 예보·스냅샷 파일명이 KST 날짜 기준 */
function ymdKst(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }).replaceAll('-', '');
}
function renderCongestionPanel() {
  const el = $('#panel-congestion');
  if (el.dataset.ready) return;
  const kstHour = Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul', hour: 'numeric', hourCycle: 'h23' }));
  const today = ymdKst(0);
  const tomorrow = ymdKst(1);
  const nextHour = clamp(kstHour + 1, 1, 23);
  const hours = Array.from({ length: 23 }, (_, i) => i + 1)
    .map((h) => `<option value="${String(h).padStart(2, '0')}00" ${h === nextHour ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`)
    .join('');
  el.innerHTML = `<h3>해양교통 혼잡 예보 ${srcLine([['격자', '4단계(1분 30초) · 약 2.3 × 2.8km'], ['업데이트', '매일 04~05시']])}</h3>
    <div class="congestion-form">
      <label>날짜 <select id="cgDate"><option value="${today}">${today}</option><option value="${tomorrow}">${tomorrow}</option></select></label>
      <label>시간대 <select id="cgTime">${hours}</select></label>
      <button id="cgRun">혼잡도 조회</button><button id="cgClear" style="background:#556275">지우기</button>
    </div>
    <div id="cgResult" class="empty">날짜·시간대를 고르고 조회하세요.</div>
    <div class="c-legend">${Object.entries(CONGESTION_COLOR).map(([k, c]) => `<span><i class="swatch" style="background:${c}"></i> ${k}</span>`).join('')}</div>`;
  el.dataset.ready = '1';
  $('#cgRun').addEventListener('click', runCongestion);
  $('#cgClear').addEventListener('click', () => {
    groups.congestion.clearLayers();
    $('#cgResult').textContent = '지웠습니다.';
  });
}
async function runCongestion() {
  const date = $('#cgDate').value;
  const time = $('#cgTime').value;
  $('#cgResult').textContent = '조회 중…';
  try {
    const d = await api(`/congestion?date=${date}&time=${time}`);
    groups.congestion.clearLayers();
    const half = 0.0125;
    const counts = {};
    for (const c of d.cells) {
      counts[c.level] = (counts[c.level] ?? 0) + 1;
      L.rectangle([[c.lat - half, c.lng - half], [c.lat + half, c.lng + half]], {
        color: CONGESTION_COLOR[c.level] ?? '#868e96', weight: 0.6, fillOpacity: c.level === '낮음' || c.level === '매우낮음' ? 0.12 : 0.35,
      })
        .bindTooltip(`혼잡지수 ${esc(c.index)} · <b>${esc(c.level)}</b><br>예상 파고 ${esc(c.wave)} m · 풍속 ${esc(c.wind)} m/s`)
        .addTo(groups.congestion);
    }
    const top = [...d.cells].sort((a, b) => b.index - a.index).slice(0, 5);
    $('#cgResult').innerHTML = d.cells.length
      ? `<div style="font-size:12.5px;margin-bottom:6px">격자 ${d.cells.length}개 · ${Object.entries(counts).map(([k, n]) => `${esc(k)} ${n}`).join(' · ')}</div>
         <table class="dtable"><thead><tr><th>격자</th><th>혼잡지수</th><th>단계</th><th>파고</th><th>풍속</th></tr></thead><tbody>${top
           .map((c) => `<tr class="click" data-lat="${c.lat}" data-lng="${c.lng}"><td>${esc(c.id)}</td><td>${esc(c.index)}</td><td>${esc(c.level)}</td><td>${esc(c.wave)} m</td><td>${esc(c.wind)} m/s</td></tr>`)
           .join('')}</tbody></table>`
      : '해당 시간대 예보 자료가 없습니다.';
  } catch (err) {
    $('#cgResult').innerHTML = `<span class="err">조회 실패: ${esc(err.message)}</span>`;
  }
}
$('#panel-congestion').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-lat]');
  if (tr) map.flyTo([Number(tr.dataset.lat), Number(tr.dataset.lng)], 13, { duration: 0.5 });
});

// 라이브맵
function renderLivePanel() {
  const vs = visibleVessels();
  const toUlsan = vs.filter((v) => v.toUlsan).length;
  const counts = {};
  for (const v of vs) counts[v.navStatus] = (counts[v.navStatus] ?? 0) + 1;
  const known = new Set(NAV_STATUS.map((n) => n[0]));
  const other = vs.filter((v) => !known.has(v.navStatus)).length;
  $('#panel-live').innerHTML = `<h3>AIS 라이브맵 ${srcLine([['출처', SOURCE], ['업데이트', '5초'], ['기준', state.fetchedAt ? fmtTime(Date.parse(state.fetchedAt)) : '-']])}</h3>
    <div class="live-head">${metrics([['전체', vs.length], ['울산행', toUlsan], ['그 외', vs.length - toUlsan], ['SK 시설 접안', vs.filter((v) => v.skFacility).length]], 4)}</div>
    <div class="live-grid">${NAV_STATUS.map(([code, en, kr]) => metrics([[en, counts[code] ?? 0, '', kr]], 1)).join('')}${metrics([['Other', other, '', '기타']], 1)}</div>`;
}

// ── 화면 전환 (SK 부두 현황 / 선박 목록) ─────────────────────────────────────
function cargoDot(cargo) {
  return `<i class="dot" style="background:${CARGO[cargo]?.color ?? CARGO.unknown.color}"></i>`;
}
function renderBerthBoard() {
  const el = $('#view-berths');
  const alongside = state.facilities.reduce((n, f) => n + f.alongside.length, 0);
  const busy = state.facilities.filter((f) => f.alongside.length).length;
  const sched = state.facilities.reduce((n, f) => n + f.scheduled.length, 0);
  const vesselIds = new Set(state.vessels.map((v) => v.mmsi));
  el.innerHTML = `
    <div class="view-head">
      <div><h2>SK 부두 현황</h2><p>SK1~8부두 · SK2·3부이 — 유류·케미칼·가스 전용. 접안 = 시뮬레이션 위치, 예정 = 선석 배정·묘박 대기·입항 예정 (모두 가상). 기준 ${state.fetchedAt ? fmtTime(Date.parse(state.fetchedAt)) : '-'}</p></div>
      <div class="kpis">
        <div class="kpi"><b>${state.facilities.length}</b><span>시설</span></div>
        <div class="kpi"><b>${busy}/${state.facilities.length}</b><span>사용 중 시설</span></div>
        <div class="kpi"><b>${alongside}</b><span>접안 선박</span></div>
        <div class="kpi"><b>${sched}</b><span>배정·대기·예정</span></div>
      </div>
    </div>
    <div class="board">${state.facilities
      .map((f) => {
        const s = f.specs[0] ?? {};
        const operators = [...new Set(f.specs.map((x) => x.operator).filter(Boolean))].join(', ');
        const multi = f.specs.length > 1
          ? `<div class="bsec" style="padding-top:0"><div class="none">※ 등록 ${f.specs.length}건: ${f.specs.map((x) => `${esc(x.operator ?? '-')} ${dash(x.length, 'm')}/${dash(x.berths)}선석/${dash(x.capacity)}DWT`).join(' · ')}</div></div>`
          : '';
        const along = f.alongside.length
          ? f.alongside
              .map((v) => `<div class="vrow" data-vid="${esc(v.id)}">${cargoDot(v.cargo)}<span class="nm">${esc(v.name)}${v.nameKr ? ` <small>${esc(v.nameKr)}</small>` : ''}</span><span class="sub">${esc(v.facilityName ?? '근접 추정')} · ${esc(v.typeKr)}</span></div>`)
              .join('')
          : '<div class="none">접안 선박 없음</div>';
        const plan = f.scheduled.length
          ? f.scheduled
              .map((p) => {
                const live = p.mmsi && vesselIds.has(p.mmsi) ? state.vessels.find((v) => v.mmsi === p.mmsi) : null;
                return `<div class="vrow plan${live ? ' has-ais' : ''}" ${live ? `data-vid="${esc(live.id)}"` : ''}><span class="badge">${esc(p.stage)}</span><span class="nm">${esc(p.name)}${p.nameKr && p.nameKr !== p.name ? ` <small>${esc(p.nameKr)}</small>` : ''}</span><span class="sub">${esc(p.period ?? p.arrival ?? '-')}<br>${esc(p.status ?? '')}${p.location ? ` · 현재 ${esc(p.location)}` : ''}</span></div>`;
              })
              .join('')
          : '<div class="none">예정 없음</div>';
        return `<article class="bcard" id="board-${esc(f.id)}">
          <div class="bcard-head"><div><h3>${esc(f.label)} ${f.approx ? '<span class="badge approx">위치 근사</span>' : ''}</h3><small>${esc(operators || '-')} · ${esc(f.port)} · ${f.kind === 'buoy' ? '원유부이(SPM)' : '부두'}</small></div>
            <button data-fac="${esc(f.id)}">지도에서 보기</button></div>
          <dl class="specs">
            <div><dt>안벽/기수</dt><dd>${dash(s.length, /\d$/.test(s.length ?? '') ? 'm' : '')}</dd></div>
            <div><dt>수심</dt><dd>${dash(s.depth, 'm')}</dd></div>
            <div><dt>접안능력(DWT)</dt><dd>${dash(s.capacity)}</dd></div>
            <div><dt>선석</dt><dd>${dash(s.berths)}</dd></div>
            <div><dt>취급화물</dt><dd>${dash(s.cargo)}</dd></div>
          </dl>${multi}
          <div class="bsec"><h4><span>접안 중 (AIS)</span><span>${f.alongside.length}척</span></h4>${along}</div>
          <div class="bsec"><h4><span>배정·묘박 대기·입항 예정</span><span>${f.scheduled.length}건</span></h4>${plan}</div>
        </article>`;
      })
      .join('')}</div>`;
  if (state.boardFocus) {
    $(`#board-${CSS.escape(state.boardFocus)}`)?.scrollIntoView({ block: 'start' });
    state.boardFocus = null;
  }
}
$('#view-berths').addEventListener('click', (e) => {
  const fac = e.target.closest('button[data-fac]')?.dataset.fac;
  if (fac) return focusFacility(fac);
  const vid = e.target.closest('[data-vid]')?.dataset.vid;
  if (vid) selectVessel(vid, { fly: true });
});

const tableState = { q: '', cargo: '', skOnly: false, toUlsan: false, sort: 'sk', asc: true };
const COLS = [
  ['name', '선박명', (v) => v.name],
  ['type', '선종', (v) => v.typeKr],
  ['flag', '국적', (v) => v.flag ?? ''],
  ['domestic', '내외항', (v) => v.domestic],
  ['nav', '항행상태', (v) => v.navStatusKr],
  ['sk', 'SK 시설', (v) => (v.skFacility ? `0${v.skFacility}` : '1')],
  ['facility', '위치시설', (v) => v.facilityName ?? ''],
  ['dest', '목적지', (v) => v.destination ?? ''],
  ['eta', 'ETA', (v) => String(v.eta ?? '')],
  ['sog', '속력(kn)', (v) => v.sog],
  ['len', '길이(m)', (v) => v.length ?? 0],
  ['gt', '총톤수', (v) => v.grossTon ?? 0],
  ['port', '진행', (v) => v.port?.status ?? ''],
  ['upd', 'AIS 갱신', (v) => v.updated ?? ''],
];
function renderVesselTable() {
  const el = $('#view-vessels');
  if (!el.dataset.ready) {
    el.innerHTML = `<div class="view-head"><div><h2>입항·접안 선박</h2><p>울산항 해역 AIS 중 유류·케미칼·가스 운반선 (조선소 시운전·계선 선박 ${state.filter.shipyard ? '포함' : '제외'})</p></div><div class="kpis" id="vtKpis"></div></div>
      <div class="tbl-tools">
        <input type="search" id="vtQ" placeholder="선박명·MMSI·호출부호">
        <select id="vtCargo"><option value="">전체 화물군</option>${Object.entries(CARGO).map(([k, c]) => `<option value="${k}">${c.kr}</option>`).join('')}</select>
        <label><input type="checkbox" id="vtSk"> SK 시설 접안만</label>
        <label><input type="checkbox" id="vtUlsan"> 울산행만</label>
      </div>
      <div class="vtable-wrap"><table class="vtable"><thead><tr>${COLS.map(([k, t]) => `<th data-sort="${k}">${t}</th>`).join('')}</tr></thead><tbody></tbody></table></div>`;
    el.dataset.ready = '1';
    $('#vtQ').addEventListener('input', (e) => ((tableState.q = e.target.value), renderVesselRows()));
    $('#vtCargo').addEventListener('change', (e) => ((tableState.cargo = e.target.value), renderVesselRows()));
    $('#vtSk').addEventListener('change', (e) => ((tableState.skOnly = e.target.checked), renderVesselRows()));
    $('#vtUlsan').addEventListener('change', (e) => ((tableState.toUlsan = e.target.checked), renderVesselRows()));
    $('.vtable thead', el).addEventListener('click', (e) => {
      const k = e.target.closest('th')?.dataset.sort;
      if (!k) return;
      tableState.asc = tableState.sort === k ? !tableState.asc : true;
      tableState.sort = k;
      renderVesselRows();
    });
    $('.vtable tbody', el).addEventListener('click', (e) => {
      const vid = e.target.closest('tr[data-vid]')?.dataset.vid;
      if (vid) selectVessel(vid, { fly: true });
    });
  }
  renderVesselRows();
}
function renderVesselRows() {
  const q = tableState.q.trim().toLowerCase();
  const col = COLS.find((c) => c[0] === tableState.sort) ?? COLS[0];
  const rows = shipPool()
    .filter((v) => (!tableState.cargo || v.cargo === tableState.cargo) && (!tableState.skOnly || v.skFacility) && (!tableState.toUlsan || v.toUlsan))
    .filter((v) => !q || [v.name, v.nameKr, v.mmsi, v.callSign].some((x) => x && String(x).toLowerCase().includes(q)))
    .sort((a, b) => {
      const x = col[2](a);
      const y = col[2](b);
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ko');
      return tableState.asc ? r : -r;
    });
  $$('#view-vessels th').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === tableState.sort);
    th.classList.toggle('asc', th.dataset.sort === tableState.sort && tableState.asc);
  });
  const fac = (id) => state.facilities.find((f) => f.id === id);
  $('#view-vessels tbody').innerHTML = rows.length
    ? rows
        .map(
          (v) => `<tr data-vid="${esc(v.id)}">
      <td><b>${esc(v.name)}</b>${v.nameKr ? ` <small>${esc(v.nameKr)}</small>` : ''}</td>
      <td><span class="chip" style="background:${CARGO[v.cargo].color}">${esc(CARGO[v.cargo].kr)}</span> ${esc(v.typeKr)}</td>
      <td>${dash(v.flag)}</td><td>${v.domestic === 'in' ? '내항' : v.domestic === 'out' ? '외항' : '-'}</td>
      <td>${esc(v.navStatusKr)}</td>
      <td>${v.skFacility ? `<span class="chip sk">${esc(fac(v.skFacility)?.label ?? v.skFacility)}</span>` : '-'}</td>
      <td>${dash(v.facilityName)}</td><td>${dash(v.destination)}</td><td>${fmtTime(v.eta)}</td>
      <td class="mono">${v.sog.toFixed(1)}</td><td class="mono">${dash(v.length)}</td><td class="mono">${v.grossTon ? v.grossTon.toLocaleString() : '-'}</td>
      <td>${dash(v.port?.status)}</td><td class="mono">${fmtTime(v.updated)}</td></tr>`,
        )
        .join('')
    : `<tr><td colspan="${COLS.length}" style="text-align:center;color:#8a94a3;padding:20px">조건에 맞는 선박이 없습니다</td></tr>`;
  $('#vtKpis').innerHTML = `
    <div class="kpi"><b>${rows.length}</b><span>표시</span></div>
    ${['oil', 'chemical', 'gas'].map((c) => `<div class="kpi"><b>${rows.filter((v) => v.cargo === c).length}</b><span>${CARGO[c].kr}</span></div>`).join('')}
    <div class="kpi"><b>${rows.filter((v) => v.skFacility).length}</b><span>SK 접안</span></div>`;
}

function route() {
  const view = (location.hash.replace(/^#\/?/, '') || 'map').split('?')[0];
  $$('.gnb-nav a').forEach((a) => a.classList.toggle('on', a.dataset.view === view));
  $('#view-berths').classList.toggle('hidden', view !== 'berths');
  $('#view-vessels').classList.toggle('hidden', view !== 'vessels');
  if (view === 'berths') renderBerthBoard();
  if (view === 'vessels') renderVesselTable();
  if (view === 'map') setTimeout(() => map.invalidateSize(), 0);
}
window.addEventListener('hashchange', route);

// ── 데이터 갱신 ───────────────────────────────────────────────────────────
let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  $('#btnRefresh').classList.add('spin');
  try {
    const [vr, fr] = await Promise.all([api('/vessels'), api('/facilities')]);
    state.vessels = vr.vessels;
    state.routeMmsi = vr.routeMmsi ? new Set(vr.routeMmsi) : null;
    state.fetchedAt = vr.fetchedAt;
    state.stale = vr.stale || fr.stale;
    state.facilities = fr.facilities;
    renderFacilities();
    renderVessels();
    $('#searchCount').textContent = `${shipPool().length}척`;
    $('#updatedAt').textContent = `${fmtTime(Date.parse(vr.fetchedAt)).slice(11)} 기준 (가상)`;
    $('#updatedAt').style.color = state.stale ? '#d9480f' : '';
    if (state.selected) {
      const v = state.vessels.find((x) => x.id === state.selected);
      if (v) renderCard(v, state.cache[`detail:${v.mmsi}`]);
    }
    if (state.panel && state.panel !== 'congestion' && state.panel !== 'layers') PANEL_RENDER[state.panel]();
    const view = location.hash.replace(/^#\/?/, '');
    if (view === 'berths') renderBerthBoard();
    if (view === 'vessels') renderVesselTable();
  } catch (err) {
    toast(`선박 정보 갱신 실패: ${err.message}`);
    $('#updatedAt').textContent = '갱신 실패';
  } finally {
    refreshing = false;
    $('#btnRefresh').classList.remove('spin');
  }
}
$('#btnRefresh').addEventListener('click', () => {
  state.cache = Object.fromEntries(Object.entries(state.cache).filter(([k]) => k.startsWith('detail:')));
  refresh();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.target.closest('input')) closeCard();
});

renderLegend();
route();
refresh();
setInterval(refresh, REFRESH_MS);
