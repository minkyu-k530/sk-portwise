// 항만 교통 시뮬레이션 (three.js 와 무관한 순수 로직 — 브라우저와 Node 양쪽에서 돈다)
//
// 선박 운동: 3자유도(전후·좌우·선회).
//  - 자력 항해: 1차 Nomoto 조종 모델(K = K'·U/L, T = T'·L/U) + 타각 속도 제한(2.5°/s) + PD 오토파일럿,
//    LOS(line-of-sight) 경로 추종, 감속 거리 기반 속력 계획, 앞 선박 추종.
//  - 예선 보조(접·이안, 선회, 부이 계류): 예선 마력·배수량으로 정한 가속도 한계 안에서 목표 자세로 이동.
//  - 묘박·부이 계류: 닻(부이) 기준 바람 방향으로 선수를 두고 흔들린다(sheer).
// 운항 절차: 외해 → 도선사 승선 → (선석 없으면 묘박 대기) → 예선 접선 → 접안 → 계류·로딩암 연결 → 하역
//           → 로딩암 분리 → 이안 → (선회) → 출항 → 외해 → 일정 시간 뒤 재입항.
import { ANCHORAGES, FACILITIES, FLEET, INITIAL, NODES, SHIP_CLASSES, TUG_BASE, TUG_LINKS, TUGS, WEATHER } from './data.js';

const PRIORITY = { berthing: 4, unberthing: 4, buoyMooring: 4, buoyLeave: 4, portOut: 3, portIn: 2, buoyIn: 2, seaIn: 1, toAnchor: 1 };

export const KN = 0.514444;
const D2R = Math.PI / 180;
const TWO_PI = Math.PI * 2;
const FENDER = 2.5; // 안벽~선측 간격(m)
const HAWSER = 70; // 부이~선수 계류삭 길이(m)

export const wrapPi = (a) => {
  const r = (a + Math.PI) % TWO_PI;
  return r < 0 ? r + Math.PI : r - Math.PI;
};
export const wrap2Pi = (a) => ((a % TWO_PI) + TWO_PI) % TWO_PI;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const fwdVec = (psi) => ({ x: Math.sin(psi), y: Math.cos(psi) });
export const stbdVec = (psi) => ({ x: Math.cos(psi), y: -Math.sin(psi) });
const bearing = (a, b) => Math.atan2(b.x - a.x, b.y - a.y);
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

export const PHASE_KR = {
  away: '항외',
  seaIn: '입항 항해',
  toAnchor: '묘박지로 이동',
  anchoring: '투묘',
  anchored: '묘박 대기',
  heaving: '양묘',
  portIn: '입항 (도선 중)',
  berthing: '접안 중',
  moored: '접안',
  unberthing: '이안 중',
  portOut: '출항',
  buoyIn: '부이 접근',
  buoyMooring: '부이 계류 작업',
  buoyMoored: '부이 계류',
  buoyLeave: '부이 이탈',
};
export const STAGE_KR = { mooring: '계류줄 작업', hoseOn: '로딩암 연결', cargo: '하역', hoseOff: '로딩암 분리', ready: '출항 준비 완료' };
const STAGE_MIN = { mooring: 20, hoseOn: 25, hoseOff: 25 };
const ASSISTED = new Set(['berthing', 'unberthing', 'buoyMooring', 'buoyLeave']);
const STATIONARY = new Set(['away', 'anchoring', 'anchored', 'heaving', 'moored', 'buoyMoored']);

/** AIS 항행상태 */
export function navStatus(ship) {
  if (['anchoring', 'anchored', 'heaving'].includes(ship.phase)) return { code: 1, kr: '정박(앵커링)' };
  if (ship.phase === 'moored' || ship.phase === 'buoyMoored') return { code: 5, kr: '정박(계류)' };
  if (ASSISTED.has(ship.phase)) return { code: 3, kr: '조종 제한' };
  return { code: 0, kr: '항해(동력)' };
}

export function windFrom(t) {
  const w = WEATHER;
  return (w.windFromDeg + w.windSwingDeg * Math.sin((TWO_PI * t) / (w.windPeriodH * 3600))) * D2R;
}

// ── 경로 ─────────────────────────────────────────────────────────────────────

/** lane 이 있는 노드는 진행 방향 오른쪽으로 그 거리만큼 비켜 통항 분리 */
function applyLanes(points) {
  return points.map((p, i) => {
    if (!p.lane) return p;
    const prev = points[i - 1];
    const next = points[i + 1];
    const normal = (a, b) => {
      const l = dist(a, b) || 1;
      return { x: (b.y - a.y) / l, y: -(b.x - a.x) / l };
    };
    const n1 = prev ? normal(prev, p) : null;
    const n2 = next ? normal(p, next) : null;
    let n = n1 && n2 ? { x: n1.x + n2.x, y: n1.y + n2.y } : n1 ?? n2;
    const l = Math.hypot(n.x, n.y) || 1;
    n = { x: n.x / l, y: n.y / l };
    const k = p.lane / Math.max(0.5, n1 ? n.x * n1.x + n.y * n1.y : 1);
    return { ...p, lane: 0, x: p.x + n.x * k, y: p.y + n.y * k };
  });
}

function makePath(points, { endSpeed = 0, vCap = Infinity } = {}) {
  const pts = applyLanes(points);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const lim = [];
  for (let i = 0; i < pts.length - 1; i++) lim.push(Math.min(vCap, (pts[i + 1].kn ?? 12) * KN));
  return { pts, cum, lim, total: cum.at(-1), endSpeed, seg: 0 };
}

const node = (id) => ({ ...NODES[id], id });

// ── 선박 ─────────────────────────────────────────────────────────────────────

class Ship {
  constructor(spec, index) {
    this.spec = spec;
    this.index = index;
    this.id = spec.id;
    this.name = spec.name;
    this.cls = SHIP_CLASSES[spec.cls];
    this.L = spec.loa;
    this.B = spec.beam;
    this.vService = this.cls.serviceKn * KN;
    this.tau = 120 * (this.L / 100) ** 1.5; // 속력 시정수(s)
    this.aPlan = (0.5 * this.vService) / this.tau; // 계획 감속도(m/s²)
    this.rMax = 0.5 * D2R * (100 / this.L) ** 0.6; // 예선 보조 선회율 한계
    this.x = 0;
    this.y = 0;
    this.psi = 0;
    this.u = 0;
    this.v = 0;
    this.r = 0;
    this.delta = 0;
    this.uCmd = 0;
    this.accelCmd = 0;
    this.vx = 0;
    this.vy = 0;
    this.phase = 'away';
    this.stage = null;
    this.stageEnd = 0;
    this.cargo = spec.op === 'discharge' ? 1 : 0;
    this.draftMax = spec.draftLaden;
    this.slot = null;
    this.spot = null;
    this.anchor = null;
    this.scope = 0;
    this.path = null;
    this.legs = null;
    this.legIdx = 0;
    this.tugsNeeded = 0;
    this.returnAt = 0;
    this.entry = spec.home.startsWith('SKB') || index % 2 === 0 ? 'SEA_E' : 'SEA_S';
    this.waitSince = null;
    this.berthedAt = null;
    this.sheerPhase = index * 1.7;
    this.avoidBias = 0;
    this.pathRemaining = Infinity;
  }

  get active() {
    return this.phase !== 'away';
  }

  get draft() {
    return this.spec.draftBallast + (this.draftMax - this.spec.draftBallast) * this.cargo;
  }

  /** 선미 트림(m): 공선일수록 선미가 깊다 */
  get trim() {
    return (1 - this.cargo) * 0.011 * this.L;
  }

  /** 배수량(kg): Cb 0.8 근사 */
  get displacement() {
    return this.L * 0.97 * this.B * this.draft * 0.8 * 1025;
  }

  get sog() {
    return Math.hypot(this.vx, this.vy);
  }

  get cog() {
    return wrap2Pi(Math.atan2(this.vx, this.vy));
  }

  get telegraph() {
    if (STATIONARY.has(this.phase)) return 'FWE';
    const ratio = this.uCmd / this.vService;
    if (this.accelCmd < -0.6 * ((0.8 * this.vService) / this.tau)) return this.u > 1 ? 'HALF ASTERN' : 'SLOW ASTERN';
    if (ASSISTED.has(this.phase)) return Math.abs(this.u) < 0.15 ? 'STOP' : this.u > 0 ? 'DEAD SLOW AHEAD' : 'DEAD SLOW ASTERN';
    if (ratio < 0.04) return 'STOP';
    if (ratio < 0.3) return 'DEAD SLOW AHEAD';
    if (ratio < 0.45) return 'SLOW AHEAD';
    if (ratio < 0.65) return 'HALF AHEAD';
    if (ratio < 0.85) return 'FULL AHEAD';
    return 'NAV FULL';
  }

  fits(slot) {
    const s = this.spec;
    const arrivalDraft = s.op === 'discharge' ? s.draftLaden : s.draftBallast;
    return s.loa <= slot.maxLoa && s.dwt <= slot.maxDwt * 1.05 && arrivalDraft <= slot.depth - 1;
  }

  tugCount() {
    if (this.slot?.facility.kind === 'buoy') return 1;
    if (this.L < 110) return 1;
    if (this.L < 200) return 2;
    return 3;
  }

  /** 예선 보조 시 횡방향 가속도 한계: 예선 마력(t) × 척수 / (배수량 × 부가질량) */
  get aLat() {
    const bollard = 62 * 9810 * Math.max(1, this.tugsNeeded);
    return clamp(bollard / (this.displacement * 1.8), 0.002, 0.03);
  }
}

class Tug {
  constructor(def, index) {
    this.id = def.id;
    this.name = def.name;
    this.bollardT = def.bollardT;
    this.L = 32;
    this.B = 12;
    const hdg = TUG_BASE.headingDeg * D2R;
    const along = fwdVec(hdg);
    const k = index - (TUGS.length - 1) / 2;
    this.home = { x: TUG_BASE.x + along.x * k * TUG_BASE.spacing, y: TUG_BASE.y + along.y * k * TUG_BASE.spacing, psi: hdg };
    this.x = this.home.x;
    this.y = this.home.y;
    this.psi = hdg;
    this.speed = 0;
    this.vx = 0;
    this.vy = 0;
    this.job = null;
    this.attached = false;
    this.thrust = 0;
    this.mode = 'idle';
    this.route = [];
    this.routeJob = null;
    this.routeAt = 0;
  }
}

// ── 시뮬레이션 ────────────────────────────────────────────────────────────────

export class Simulation {
  constructor() {
    this.t = 0;
    this.events = [];
    this.slots = new Map();
    this.facilities = FACILITIES.map((f) => ({ ...f, queue: [] }));
    for (const f of this.facilities) {
      f.slots = f.slots.map((def) => this.#buildSlot(f, def));
      for (const s of f.slots) this.slots.set(s.id, s);
    }
    this.anchorSpots = ANCHORAGES.flatMap((a) => a.spots.map((p, i) => ({ anchorage: a, index: i, x: p.x, y: p.y, occupant: null })));
    this.ships = FLEET.map((spec, i) => new Ship(spec, i));
    this.tugs = TUGS.map((d, i) => new Tug(d, i));
    this.tugRequests = [];
    /** 좁은 선회장(TB12 등) 점유: 구역 id → 선박. 한 번에 한 척만 선회·접근한다 */
    this.zoneLock = new Map();
    this.tugNodes = new Map([['BASE', { x: TUG_BASE.x, y: TUG_BASE.y }]]);
    for (const [a, b] of TUG_LINKS) for (const id of [a, b]) if (id !== 'BASE') this.tugNodes.set(id, { x: NODES[id].x, y: NODES[id].y });
    this.tugAdj = new Map([...this.tugNodes.keys()].map((id) => [id, []]));
    for (const [a, b] of TUG_LINKS) {
      const w = dist(this.tugNodes.get(a), this.tugNodes.get(b));
      this.tugAdj.get(a).push([b, w]);
      this.tugAdj.get(b).push([a, w]);
    }
    this.#applyInitial();
  }

  #buildSlot(facility, def) {
    const slot = { ...def, facility, depth: def.depth ?? facility.depth, occupant: null };
    if (facility.kind === 'buoy') {
      slot.buoy = facility.buoy;
      return slot;
    }
    const { a, b } = def.line;
    const len = dist(a, b);
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    slot.quay = { x: a.x + ux * def.s, y: a.y + uy * def.s };
    slot.heading = wrap2Pi(Math.atan2(a.x - b.x, a.y - b.y)); // 선수는 a 쪽
    slot.normal = stbdVec(slot.heading); // 좌현 계류 → 우현 쪽이 바다
    return slot;
  }

  log(ship, text) {
    this.events.push({ t: this.t, ship: ship?.id ?? null, name: ship?.name ?? null, text });
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
  }

  facility(id) {
    return this.facilities.find((f) => f.id === id);
  }

  // ── 선석 자세 ──
  berthPose(slot, ship, extra = 0) {
    const off = ship.B / 2 + FENDER + extra;
    return { x: slot.quay.x + slot.normal.x * off, y: slot.quay.y + slot.normal.y * off, psi: slot.heading };
  }

  abeamClear(slot, ship) {
    return slot.facility.kind === 'jetty' ? 130 : Math.max(1.5 * ship.B, 50);
  }

  rendezvousPose(slot, ship) {
    const f = slot.facility;
    const abeam = this.berthPose(slot, ship, this.abeamClear(slot, ship));
    if (f.rendezvous === 'behind') {
      const h = fwdVec(slot.heading);
      const back = 0.6 * ship.L + 100;
      return { x: abeam.x - h.x * back, y: abeam.y - h.y * back, psi: slot.heading };
    }
    if (f.rendezvous?.offset) {
      const d = f.rendezvous.offset;
      return { x: abeam.x + slot.normal.x * d, y: abeam.y + slot.normal.y * d, psi: slot.heading };
    }
    const n = NODES[f.rendezvous];
    return { x: n.x, y: n.y, psi: null };
  }

  swingPoint(slot, ship) {
    const f = slot.facility;
    if (typeof f.swing === 'string') return { x: NODES[f.swing].x, y: NODES[f.swing].y };
    if (f.swing.normal) return { x: slot.quay.x + slot.normal.x * f.swing.normal, y: slot.quay.y + slot.normal.y * f.swing.normal };
    const abeam = this.berthPose(slot, ship, this.abeamClear(slot, ship));
    return { x: f.swing.x, y: abeam.y };
  }

  buoyPose(slot, ship, psi = windFrom(this.t)) {
    const h = fwdVec(psi);
    const d = HAWSER + ship.L / 2;
    return { x: slot.buoy.x - h.x * d, y: slot.buoy.y - h.y * d, psi };
  }

  // ── 경로 계획 ──
  exitNodes(ship) {
    if (ship.spec.home.startsWith('SKB')) return [node('BUOY_OUT'), node('SEA_EN')];
    return ship.entry === 'SEA_S' ? [node('SEA_S')] : [node('OUT_E'), node('SEA_EO')];
  }

  /** 시설 입항 경로에서 현재 위치보다 북쪽(항 안쪽)의 첫 노드부터 */
  #inboundNodesFrom(f, pos) {
    const ids = f.inbound.filter((id) => id !== 'PILOT');
    const i = ids.findIndex((id) => NODES[id].y > pos.y);
    return (i < 0 ? [] : ids.slice(i)).map(node);
  }

  #portInPath(ship) {
    const slot = ship.slot;
    const f = slot.facility;
    const here = { x: ship.x, y: ship.y };
    const rv = this.rendezvousPose(slot, ship);
    const pts = [here, ...this.#inboundNodesFrom(f, here)];
    if (f.rendezvous === 'behind') {
      // 선석과 나란한 접근선에 일찍 올라타도록 앞쪽 계류선 훨씬 전에서 꺾는다
      const h = fwdVec(slot.heading);
      const pre = f.preY != null ? Math.max(2 * ship.L + 250, (rv.y - f.preY) / Math.max(0.2, h.y)) : 2 * ship.L + 250;
      pts.push({ x: rv.x - h.x * pre, y: rv.y - h.y * pre, kn: 5 });
    }
    if (pts.at(-1).id === f.rendezvous) pts.pop(); // TB12 는 아래에서 회합점으로 넣는다
    pts.push({ x: rv.x, y: rv.y, kn: 3 });
    return this.#path(pts, ship, { vCap: ship.vService * 0.8, endSpeed: 0 });
  }

  #anchorPath(ship, spot) {
    const w = fwdVec(windFrom(this.t));
    const back = ship.L + 500;
    const approach = { x: spot.x - w.x * back, y: spot.y - w.y * back, kn: 6 };
    const via = ship.y < -3000 && ship.x < 6000 ? spot.anchorage.via.map((p) => ({ ...p, kn: 9 })) : [];
    return this.#path([{ x: ship.x, y: ship.y }, ...via, approach, { x: spot.x, y: spot.y, kn: 3 }], ship, { vCap: ship.vService * 0.8 });
  }

  /** 통항 분리를 적용하고, 경로가 묘박·부이 계류 선박 가까이 지나면 비켜 가는 점을 넣는다 */
  #path(points, ship, opts) {
    ship.pathRemaining = Infinity;
    const pts = applyLanes(points);
    const obstacles = this.ships.filter((o) => o !== ship && ['anchoring', 'anchored', 'heaving', 'buoyMoored'].includes(o.phase));
    for (let pass = 0; pass < 6; pass++) {
      let inserted = false;
      for (let i = 0; i < pts.length - 1 && !inserted; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const abx = b.x - a.x;
        const aby = b.y - a.y;
        const len2 = abx * abx + aby * aby || 1;
        for (const o of obstacles) {
          const R = (o.L + ship.L) / 2 + 150;
          if (dist(a, o) < R || dist(b, o) < R) continue; // 출발·도착점 자체가 가까우면(제 묘박지 등) 그대로
          const t = clamp(((o.x - a.x) * abx + (o.y - a.y) * aby) / len2, 0, 1);
          const cx = a.x + abx * t;
          const cy = a.y + aby * t;
          const d = Math.hypot(cx - o.x, cy - o.y);
          if (d >= R) continue;
          let nx = cx - o.x;
          let ny = cy - o.y;
          if (d < 1) {
            nx = aby;
            ny = -abx;
          }
          const l = Math.hypot(nx, ny);
          pts.splice(i + 1, 0, { x: o.x + (nx / l) * (R + 40), y: o.y + (ny / l) * (R + 40), kn: b.kn });
          inserted = true;
          break;
        }
      }
      if (!inserted) break;
    }
    return makePath(pts, opts);
  }

  // ── 선석·묘박지 배정 ──
  #freeSlotFor(ship, f) {
    return f.slots.find((s) => !s.occupant && ship.fits(s)) ?? null;
  }

  #reserve(ship, slot) {
    slot.occupant = ship.id;
    ship.slot = slot;
    if (ship.spec.op === 'load') ship.draftMax = Math.min(ship.spec.draftLaden, slot.depth - 1);
  }

  #pickSpot(ship) {
    const order = [...ANCHORAGES].sort((a, b) => a.maxDwt - b.maxDwt);
    for (const a of order) {
      if (a.maxDwt < ship.spec.dwt) continue;
      const spot = this.anchorSpots.find((s) => s.anchorage === a && !s.occupant);
      if (spot) return spot;
    }
    return this.anchorSpots.find((s) => !s.occupant);
  }

  #enqueue(ship) {
    const f = this.facility(ship.spec.home);
    if (!f.queue.includes(ship.id)) f.queue.push(ship.id);
    ship.waitSince ??= this.t;
  }

  #serveQueue(f, arriving = null) {
    for (const id of [...f.queue]) {
      const ship = this.ships.find((s) => s.id === id);
      const slot = this.#freeSlotFor(ship, f);
      if (!slot) continue;
      f.queue.splice(f.queue.indexOf(id), 1);
      this.#reserve(ship, slot);
      if (ship !== arriving) this.log(ship, `${slot.id} 선석 배정 — 대기 ${fmtDur(this.t - (ship.waitSince ?? this.t))}`);
      if (ship.phase === 'anchored') this.#startHeaving(ship);
      else if (ship.phase === 'toAnchor') {
        this.#releaseSpot(ship);
        this.#proceedToBerth(ship);
      }
      // anchoring 중이면 투묘가 끝난 뒤 바로 양묘한다(#updateAnchor)
    }
  }

  /** 배정을 받은 선박의 다음 행선: 부이 / 외해 쪽이면 도선 구역 경유 / 항 가까이면 바로 입항 */
  #proceedToBerth(ship) {
    if (ship.slot.facility.kind === 'buoy') this.#startBuoyIn(ship);
    else if (ship.y < NODES.PILOT.y + 300 && dist(ship, NODES.PILOT) > 1500) this.#startSeaIn(ship);
    else this.#startPortIn(ship);
  }

  #releaseSpot(ship) {
    if (ship.spot) ship.spot.occupant = null;
    ship.spot = null;
  }

  // ── 예선 ──
  requestTugs(ship) {
    ship.tugsNeeded = ship.tugCount();
    if (!this.tugRequests.includes(ship)) this.tugRequests.push(ship);
  }

  releaseTugs(ship, why) {
    const mine = this.tugs.filter((t) => t.job?.ship === ship);
    for (const t of mine) {
      t.job = null;
      t.attached = false;
    }
    ship.tugsNeeded = 0;
    this.tugRequests = this.tugRequests.filter((s) => s !== ship);
    if (mine.length) this.log(ship, `예선 ${mine.length}척 해방${why ? ` (${why})` : ''}`);
  }

  tugsOf(ship) {
    return this.tugs.filter((t) => t.job?.ship === ship);
  }

  tugsReady(ship) {
    if (!ship.tugsNeeded) return false;
    const mine = this.tugsOf(ship);
    return mine.length >= ship.tugsNeeded && mine.every((t) => t.attached);
  }

  #assignTugs() {
    for (const ship of [...this.tugRequests]) {
      let have = this.tugsOf(ship).length;
      while (have < ship.tugsNeeded) {
        const free = this.tugs.filter((t) => !t.job);
        if (!free.length) break;
        free.sort((a, b) => dist(a, ship) - dist(b, ship));
        free[0].job = { ship, idx: have };
        have++;
      }
      if (have >= ship.tugsNeeded) {
        this.tugRequests = this.tugRequests.filter((s) => s !== ship);
        this.log(ship, `예선 ${have}척 배정 (${this.tugsOf(ship).map((t) => t.name).join(', ')})`);
      }
    }
  }

  tugMode(ship) {
    const buoyOps = ship.slot?.facility.kind === 'buoy';
    if (buoyOps) return 'stern';
    if (ASSISTED.has(ship.phase) || ship.phase === 'moored') return 'push';
    if (ship.phase === 'portIn' && ship.path && ship.pathRemaining < 0.6 * ship.L + 300) return 'push';
    return 'escort';
  }

  /** 예선 위치(선박 기준 전후·좌우 오프셋과 상대 선수각) */
  tugSlot(tug) {
    const ship = tug.job.ship;
    const i = tug.job.idx;
    const mode = this.tugMode(ship);
    let fwd = 0;
    let lat = 0;
    let rel = 0;
    if (mode === 'push') {
      fwd = [0.3, -0.3, 0][i] * ship.L;
      lat = ship.B / 2 + tug.B / 2 + 1.5;
      rel = -Math.PI / 2;
    } else if (mode === 'stern') {
      fwd = -(ship.L / 2 + 55 + i * 30);
      rel = Math.PI;
    } else {
      fwd = [ship.L / 2 + 45, -(ship.L / 2 + 45), 0][i];
      lat = i === 2 ? ship.B / 2 + 30 : 0;
    }
    const h = fwdVec(ship.psi);
    const s = stbdVec(ship.psi);
    return { x: ship.x + h.x * fwd + s.x * lat, y: ship.y + h.y * fwd + s.y * lat, psi: wrap2Pi(ship.psi + rel), mode };
  }

  /** 예선 경로: 가장 가까운 경로망 노드끼리 최단 경로(이미 지난 앞쪽 노드·목표 너머 노드는 뺀다) */
  #tugRoute(from, to) {
    const nearest = (p) => {
      let best = null;
      for (const [id, n] of this.tugNodes) if (!best || dist(p, n) < dist(p, this.tugNodes.get(best))) best = id;
      return best;
    };
    const start = nearest(from);
    const goal = nearest(to);
    const prev = new Map();
    const cost = new Map([[start, 0]]);
    const open = new Set([start]);
    while (open.size) {
      let cur = null;
      for (const id of open) if (cur === null || cost.get(id) < cost.get(cur)) cur = id;
      open.delete(cur);
      if (cur === goal) break;
      for (const [next, w] of this.tugAdj.get(cur)) {
        const c = cost.get(cur) + w;
        if (c < (cost.get(next) ?? Infinity)) {
          cost.set(next, c);
          prev.set(next, cur);
          open.add(next);
        }
      }
    }
    const ids = [goal];
    while (ids[0] !== start && prev.has(ids[0])) ids.unshift(prev.get(ids[0]));
    const pts = ids.map((id) => this.tugNodes.get(id));
    while (pts.length >= 2 && dist(from, pts[1]) < dist(pts[0], pts[1])) pts.shift();
    while (pts.length >= 2 && dist(to, pts.at(-2)) < dist(pts.at(-2), pts.at(-1))) pts.pop();
    // 노드가 하나만 남았는데 예선이 그 노드보다 목표에 가까우면 바로 간다(같은 노드 주위를 맴도는 것 방지)
    if (pts.length === 1 && dist(from, to) < dist(pts[0], to)) pts.shift();
    return pts;
  }

  #updateTug(tug, dt) {
    let target;
    let vRef = { x: 0, y: 0 };
    if (tug.job) {
      target = this.tugSlot(tug);
      vRef = { x: tug.job.ship.vx, y: tug.job.ship.vy };
      tug.mode = target.mode;
    } else {
      target = tug.home;
      tug.mode = 'idle';
    }
    if (tug.job !== tug.routeJob || this.t >= tug.routeAt) {
      tug.route = this.#tugRoute(tug, target);
      tug.routeJob = tug.job;
      tug.routeAt = this.t + 60;
    }
    while (tug.route.length && dist(tug, tug.route[0]) < 90) tug.route.shift();
    if (dist(tug, target) < 250) tug.route.length = 0;
    const via = tug.route[0];
    const aim = via ?? target;
    const dx = aim.x - tug.x;
    const dy = aim.y - tug.y;
    const d = Math.hypot(dx, dy);
    const vMax = 12 * KN;
    if (via || d > 45) {
      tug.attached = false;
      const course = Math.atan2(dx, dy);
      // 전방위 추진기: 방향이 크게 틀어져 있으면 제자리에서 먼저 돌고 나서 속력을 낸다
      const turnFactor = Math.max(0.05, Math.cos(Math.min(Math.PI / 2, Math.abs(wrapPi(course - tug.psi)))));
      const want = turnFactor * (via ? vMax : Math.min(vMax, Math.hypot(vRef.x, vRef.y) + Math.sqrt(2 * 0.12 * d)));
      tug.psi = wrap2Pi(tug.psi + clamp(wrapPi(course - tug.psi), -8 * D2R * dt, 8 * D2R * dt));
      tug.speed += clamp(want - tug.speed, -0.4 * dt, 0.3 * dt);
      const h = fwdVec(tug.psi);
      tug.vx = h.x * tug.speed;
      tug.vy = h.y * tug.speed;
    } else {
      // 근접: 전방위 추진(ASD)으로 위치 유지
      const k = 0.12;
      let wx = vRef.x + dx * k;
      let wy = vRef.y + dy * k;
      const m = Math.hypot(wx, wy);
      const cap = Math.hypot(vRef.x, vRef.y) + 2.5;
      if (m > cap) {
        wx *= cap / m;
        wy *= cap / m;
      }
      const acc = 0.5 * dt;
      tug.vx += clamp(wx - tug.vx, -acc, acc);
      tug.vy += clamp(wy - tug.vy, -acc, acc);
      tug.speed = Math.hypot(tug.vx, tug.vy);
      const wantPsi = d > 15 && tug.speed > 1.5 ? Math.atan2(tug.vx, tug.vy) : target.psi;
      tug.psi = wrap2Pi(tug.psi + clamp(wrapPi(wantPsi - tug.psi), -10 * D2R * dt, 10 * D2R * dt));
      if (tug.job) tug.attached = d < 4 && Math.abs(wrapPi(target.psi - tug.psi)) < 12 * D2R;
    }
    tug.x += tug.vx * dt;
    tug.y += tug.vy * dt;
    if (!tug.job && d < 2 && tug.speed < 0.2) {
      tug.vx = tug.vy = tug.speed = 0;
    }
    const ship = tug.job?.ship;
    tug.thrust = !tug.attached || !ship
      ? Math.min(1, tug.speed / vMax)
      : tug.mode === 'push'
        ? clamp(Math.abs(ship.v) / 0.12 + Math.abs(ship.r) / ship.rMax * 0.6, 0.15, 1)
        : clamp(Math.abs(ship.u) / 3, 0.2, 0.8);
  }

  // ── 단계 전환 ──
  #spawn(ship) {
    const entry = node(ship.entry);
    const f = this.facility(ship.spec.home);
    ship.cargo = ship.spec.op === 'discharge' ? 1 : 0;
    ship.draftMax = ship.spec.draftLaden;
    ship.x = entry.x;
    ship.y = entry.y;
    ship.psi = wrap2Pi(bearing(entry, f.kind === 'buoy' ? f.buoy : NODES.PILOT));
    ship.u = 0.8 * ship.vService;
    ship.v = ship.r = ship.delta = 0;
    this.log(ship, `입항 항해 시작 (${f.label} 행)`);
    this.#decide(ship);
  }

  /** 선석 배정된 선박: 도선사 승선구역까지 */
  #startSeaIn(ship) {
    ship.phase = 'seaIn';
    ship.path = this.#path([{ x: ship.x, y: ship.y }, node('PILOT')], ship, { vCap: ship.vService * 0.8, endSpeed: 8 * KN });
  }

  /** 입항 예정 선박: 선석이 비었으면 배정하고 들어가고, 아니면 대기열에 올리고 바로 묘박지로 간다 */
  #decide(ship) {
    const f = this.facility(ship.spec.home);
    this.#enqueue(ship);
    this.#serveQueue(f, ship);
    if (ship.slot) {
      ship.waitSince = null;
      if (f.kind === 'buoy') this.#startBuoyIn(ship);
      else this.#startSeaIn(ship);
      return;
    }
    const spot = this.#pickSpot(ship);
    spot.occupant = ship.id;
    ship.spot = spot;
    ship.phase = 'toAnchor';
    ship.path = this.#anchorPath(ship, spot);
    this.log(ship, `${f.label} 선석 없음 → ${spot.anchorage.label} 묘박 대기 예정 (대기열 ${f.queue.indexOf(ship.id) + 1}번째)`);
  }

  #startPortIn(ship) {
    ship.phase = 'portIn';
    ship.path = this.#portInPath(ship);
    ship.legs = null;
    this.log(ship, `도선사 승선 · ${ship.slot.id} 향해 입항`);
  }

  /** 부이 계류: 바람을 정면으로 받는 접근선(계류 위치 뒤 1.2 km)까지 자력, 이후 예선 보조 */
  #startBuoyIn(ship) {
    ship.phase = 'buoyIn';
    const pose = this.buoyPose(ship.slot, ship);
    ship.buoyTarget = pose;
    const h = fwdVec(pose.psi);
    const rv = { x: pose.x - h.x * 1200, y: pose.y - h.y * 1200, kn: 4 };
    const pre = { x: rv.x - h.x * (ship.L + 800), y: rv.y - h.y * (ship.L + 800), kn: 7 };
    ship.path = this.#path([{ x: ship.x, y: ship.y }, pre, rv], ship, { vCap: ship.vService * 0.8, endSpeed: 0 });
    this.log(ship, `${ship.slot.id} 부이 계류 승인 · 접근 시작`);
  }

  #startHeaving(ship) {
    ship.phase = 'heaving';
    this.log(ship, '양묘 시작');
  }

  #startBerthing(ship) {
    const slot = ship.slot;
    const abeam = this.berthPose(slot, ship, this.abeamClear(slot, ship));
    const berth = this.berthPose(slot, ship);
    const vLat = clamp(0.35 * Math.sqrt(100 / ship.L), 0.15, 0.3);
    ship.legs = [
      { ...abeam, vLong: 1.0, vLat, pass: false, label: '선석 정횡 정렬' },
      { ...berth, vLong: 0.3, vLat: Math.min(vLat, 0.2), pass: false, label: '횡이동 접안' },
    ];
    ship.legIdx = 0;
    ship.phase = 'berthing';
    ship.path = null;
    this.log(ship, `${slot.id} 접안 개시 (예선 ${ship.tugsNeeded}척 보조)`);
  }

  #startMoored(ship) {
    ship.phase = ship.slot.facility.kind === 'buoy' ? 'buoyMoored' : 'moored';
    ship.u = ship.v = ship.r = ship.delta = 0;
    ship.berthedAt = this.t;
    this.#setStage(ship, 'mooring');
    this.releaseTugs(ship, '계류 완료');
    this.log(ship, `${ship.slot.id} ${ship.phase === 'moored' ? '접안' : '부이 계류'} 완료`);
  }

  #setStage(ship, stage, durS) {
    ship.stage = stage;
    if (stage === 'cargo') {
      ship.stageStart = this.t;
      ship.stageEnd = this.t + (durS ?? ship.spec.opHours * 3600);
    } else if (stage === 'ready') {
      ship.stageEnd = this.t;
    } else {
      ship.stageEnd = this.t + (durS ?? STAGE_MIN[stage] * 60);
    }
  }

  #updateStages(ship, dt) {
    if (ship.stage === 'cargo') {
      const total = ship.stageEnd - ship.stageStart;
      const rate = dt / Math.max(1, total);
      ship.cargo = clamp(ship.cargo + (ship.spec.op === 'load' ? rate : -rate), 0, 1);
    }
    if (this.t < ship.stageEnd || ship.stage === 'ready') return;
    if (ship.stage === 'mooring') this.#setStage(ship, 'hoseOn');
    else if (ship.stage === 'hoseOn') {
      this.#setStage(ship, 'cargo');
      this.log(ship, `${ship.spec.op === 'load' ? '선적' : '양하'} 개시 — ${ship.spec.cargo}`);
    } else if (ship.stage === 'cargo') {
      ship.cargo = ship.spec.op === 'load' ? 1 : 0;
      this.#setStage(ship, 'hoseOff');
      this.log(ship, `${ship.spec.op === 'load' ? '선적' : '양하'} 완료 · 로딩암 분리`);
      this.requestTugs(ship);
    } else if (ship.stage === 'hoseOff') {
      this.#setStage(ship, 'ready');
      if (!ship.tugsNeeded) this.requestTugs(ship);
    }
  }

  #startUnberthing(ship) {
    const slot = ship.slot;
    if (slot.facility.kind === 'buoy') {
      const back = fwdVec(ship.psi);
      const p1 = { x: ship.x - back.x * 250, y: ship.y - back.y * 250, psi: ship.psi };
      const exit = this.exitNodes(ship)[0];
      ship.legs = [
        { ...p1, vLong: 0.6, vLat: 0.15, pass: true, label: '계류삭 해방 · 후진' },
        { ...p1, psi: wrap2Pi(bearing(p1, exit)), vLong: 0.3, vLat: 0.15, pass: false, label: '출항 방향 선회' },
      ];
      ship.legIdx = 0;
      ship.phase = 'buoyLeave';
      this.log(ship, `${slot.id} 부이 이탈 개시`);
      return;
    }
    const abeam = this.berthPose(slot, ship, this.abeamClear(slot, ship));
    const sw = this.swingPoint(slot, ship);
    const outbound = this.#outboundPoints(ship, sw);
    const exitPsi = wrap2Pi(bearing(sw, outbound[1]));
    const vLat = clamp(0.35 * Math.sqrt(100 / ship.L), 0.15, 0.3);
    ship.legs = [
      { ...abeam, vLong: 0.3, vLat, pass: true, label: '횡이동 이안' },
      { ...sw, psi: slot.heading, vLong: 0.8, vLat, pass: true, label: '선회장 이동' },
      { ...sw, psi: exitPsi, vLong: 0.3, vLat: 0.15, pass: false, label: '선회' },
    ];
    ship.legIdx = 0;
    ship.phase = 'unberthing';
    this.log(ship, `${slot.id} 이안 개시 (예선 ${ship.tugsNeeded}척 보조)`);
  }

  #outboundPoints(ship, from) {
    const f = ship.slot.facility;
    return applyLanes([{ x: from.x, y: from.y }, ...f.outbound.map(node), ...this.exitNodes(ship)]);
  }

  #startPortOut(ship) {
    const slot = ship.slot;
    let pts;
    if (slot?.facility.kind === 'buoy') pts = [{ x: ship.x, y: ship.y }, ...this.exitNodes(ship)];
    else if (slot) pts = [{ x: ship.x, y: ship.y }, ...slot.facility.outbound.map(node), ...this.exitNodes(ship)];
    else {
      const chain = ['CH4', 'CH3', 'CH2', 'CH1', 'CH0'].filter((id) => NODES[id].y < ship.y).map(node);
      pts = [{ x: ship.x, y: ship.y }, ...chain, ...this.exitNodes(ship)];
    }
    if (slot) {
      slot.occupant = null;
      this.releaseTugs(ship, '이안 완료');
      const f = slot.facility;
      ship.slot = null;
      this.#serveQueue(f);
    }
    ship.phase = 'portOut';
    ship.path = this.#path(pts, ship, { vCap: ship.vService * 0.85, endSpeed: 10 * KN });
  }

  #leave(ship) {
    ship.phase = 'away';
    ship.path = null;
    ship.returnAt = this.t + ship.spec.awayHours * 3600;
    ship.waitSince = null;
    ship.berthedAt = null;
    ship.vx = ship.vy = 0;
    this.log(ship, '관할 해역 이탈');
  }

  // ── 초기 상태 ──
  #applyInitial() {
    for (const init of INITIAL) {
      const ship = this.ships.find((s) => s.id === init.ship);
      const f = this.facility(ship.spec.home);
      if (init.entry) ship.entry = init.entry;
      if (init.state === 'away') {
        ship.phase = 'away';
        ship.returnAt = init.arriveInH * 3600;
      } else if (init.state === 'moored') {
        const slot = this.slots.get(init.slot);
        this.#reserve(ship, slot);
        if (slot.facility.kind === 'buoy') {
          const p = this.buoyPose(slot, ship);
          Object.assign(ship, { x: p.x, y: p.y, psi: p.psi, phase: 'buoyMoored', scope: HAWSER, anchor: { ...slot.buoy } });
        } else {
          const p = this.berthPose(slot, ship);
          Object.assign(ship, { x: p.x, y: p.y, psi: p.psi, phase: 'moored' });
        }
        ship.berthedAt = -3600 * ship.spec.opHours * init.progress - 3600;
        const p = init.progress;
        ship.cargo = ship.spec.op === 'load' ? p : 1 - p;
        if (init.phase === 'done') {
          this.#setStage(ship, 'hoseOff', init.departInMin * 60);
          this.requestTugs(ship);
        } else {
          ship.stage = 'cargo';
          ship.stageStart = -p * ship.spec.opHours * 3600;
          ship.stageEnd = (1 - p) * ship.spec.opHours * 3600;
        }
      } else if (init.state === 'anchored') {
        const a = ANCHORAGES.find((x) => x.id === init.anchorage);
        const spot = this.anchorSpots.find((s) => s.anchorage === a && s.index === init.spot);
        spot.occupant = ship.id;
        ship.spot = spot;
        ship.anchor = { x: spot.x, y: spot.y };
        ship.scope = this.#targetScope(ship);
        ship.psi = windFrom(0);
        ship.phase = 'anchored';
        ship.waitSince = -3600 * (3 + ship.index % 5);
        this.#placeOnAnchor(ship);
        if (!f.queue.includes(ship.id)) f.queue.push(ship.id);
      } else if (init.state === 'inbound') {
        Object.assign(ship, { x: init.at.x, y: init.at.y, psi: init.headingDeg * D2R, u: init.speedKn * KN });
        if (f.kind === 'buoy' || init.at.y < NODES.PILOT.y) this.#decide(ship);
        else {
          this.#reserve(ship, this.#freeSlotFor(ship, f));
          this.#startPortIn(ship);
        }
      } else if (init.state === 'outbound') {
        Object.assign(ship, { x: init.at.x, y: init.at.y, psi: init.headingDeg * D2R, u: init.speedKn * KN });
        ship.entry = init.exit;
        this.#startPortOut(ship);
      }
    }
    for (const f of this.facilities) this.#serveQueue(f);
    this.events = [];
    this.log(null, '시나리오 시작 — 모든 선박·일정은 가상 데이터');
  }

  #targetScope(ship) {
    return 110 + 0.35 * ship.L;
  }

  #placeOnAnchor(ship) {
    const h = fwdVec(ship.psi);
    const d = ship.scope + ship.L / 2;
    ship.x = ship.anchor.x - h.x * d;
    ship.y = ship.anchor.y - h.y * d;
  }

  // ── 운동 ──
  #integrate(ship, dt) {
    const h = fwdVec(ship.psi);
    const s = stbdVec(ship.psi);
    ship.x += (ship.u * h.x + ship.v * s.x) * dt;
    ship.y += (ship.u * h.y + ship.v * s.y) * dt;
    ship.psi = wrap2Pi(ship.psi + ship.r * dt);
  }

  #guide(ship) {
    const P = ship.path;
    const n = P.pts.length;
    let a;
    let b;
    let segLen;
    let along;
    for (;;) {
      a = P.pts[P.seg];
      b = P.pts[P.seg + 1];
      segLen = P.cum[P.seg + 1] - P.cum[P.seg] || 1;
      along = ((ship.x - a.x) * (b.x - a.x) + (ship.y - a.y) * (b.y - a.y)) / segLen;
      if (P.seg < n - 2) {
        const c = P.pts[P.seg + 2];
        const nextLen = P.cum[P.seg + 2] - P.cum[P.seg + 1];
        const turn = Math.abs(wrapPi(bearing(b, c) - bearing(a, b)));
        const accept = clamp(ship.L * (0.4 + 1.6 * Math.tan(Math.min(turn, 2.4) / 2)) + 20, 30, 0.45 * Math.min(segLen, nextLen));
        if (along > segLen - accept) {
          P.seg++;
          continue;
        }
      }
      break;
    }
    const ux = (b.x - a.x) / segLen;
    const uy = (b.y - a.y) / segLen;
    const e = (ship.x - a.x) * uy - (ship.y - a.y) * ux; // 경로 오른쪽 +
    const look = clamp(1.6 * ship.L, 120, 650);
    const chi = Math.atan2(ux, uy) - Math.atan2(e - ship.avoidBias, look);
    const s = P.cum[P.seg] + along;
    const remaining = P.total - s;
    let v = P.lim[P.seg];
    for (let k = P.seg + 1; k < n - 1; k++) v = Math.min(v, Math.sqrt(P.lim[k] ** 2 + 2 * ship.aPlan * Math.max(0, P.cum[k] - s)));
    v = Math.min(v, Math.sqrt(P.endSpeed ** 2 + 2 * ship.aPlan * Math.max(0, remaining)));
    ship.pathRemaining = remaining;
    return { chi, v, remaining };
  }

  /**
   * 교통 제약 속력. 같은 방향 앞 선박은 따라가고, 횡단·마주침은 우선순위가 낮은 쪽이 감속해 선미로 지나간다.
   * 우선순위: 예선 보조 중 > 출항 > 입항 > 외해 항해(같으면 먼저 등록된 선박 우선).
   */
  #trafficLimit(ship) {
    let lim = Infinity;
    const h = fwdVec(ship.psi);
    const s = stbdVec(ship.psi);
    const myP = PRIORITY[ship.phase] ?? 0;
    for (const o of this.ships) {
      if (o === ship || STATIONARY.has(o.phase)) continue;
      const oP = PRIORITY[o.phase] ?? 0;
      const iYield = oP > myP || (oP === myP && o.index < ship.index);
      const dx = o.x - ship.x;
      const dy = o.y - ship.y;
      const range = Math.hypot(dx, dy);
      if (range > 4000) continue;
      const cosRel = Math.cos(o.psi - ship.psi);
      const fwd = dx * h.x + dy * h.y;
      const lat = Math.abs(dx * s.x + dy * s.y);
      // 예선 보조로 선회 중인 선박은 선체 길이만큼을 폭으로 본다
      const oWidth = ASSISTED.has(o.phase) ? o.L : o.B;
      const inLane = fwd > 0 && lat < (ship.B + oWidth) / 2 + 45;
      if (inLane && (cosRel > 0.3 || iYield || o.sog < 0.3)) {
        const gap = fwd - (ship.L + o.L) / 2;
        let v = Math.sqrt(2 * ship.aPlan * Math.max(0, gap - 150));
        const along = o.u * cosRel;
        if (along > 0.3) v += along;
        lim = Math.min(lim, v);
      }
      const rvx = o.vx - h.x * ship.u;
      const rvy = o.vy - h.y * ship.u;
      const rv2 = rvx * rvx + rvy * rvy;
      if (rv2 < 0.01) continue;
      const tcpa = -(dx * rvx + dy * rvy) / rv2;
      if (tcpa <= 0 || tcpa > 900) continue;
      const dcpa = Math.hypot(dx + rvx * tcpa, dy + rvy * tcpa);
      const sin = Math.abs(Math.sin(o.psi - ship.psi));
      const need = (ship.B + o.B) / 2 + 50 + ((ship.L + o.L) / 2 + 30) * Math.min(1, sin * 1.5);
      if (dcpa >= need) continue;
      // 마주침: 서로 우현으로 비킨다
      if (cosRel < -0.7 && fwd > 0) ship.avoidBias = Math.max(ship.avoidBias, clamp(need - dcpa + 30, 0, 120));
      // 추월하는 쪽이 피하고 추월당하는 쪽은 침로·속력을 유지한다
      const overtaking = fwd > 0 && cosRel > 0.5;
      const beingOvertaken = fwd < 0 && cosRel > 0.5;
      if (!(iYield || overtaking) || beingOvertaken) continue;
      lim = Math.min(lim, range < (ship.L + o.L) / 2 + 250 ? 0 : Math.max(0.6, ship.u * 0.5));
    }
    return lim;
  }

  #zoneOf(ship) {
    const swing = ship.slot?.facility.swing;
    return typeof swing === 'string' ? swing : null;
  }

  #tryLock(zone, ship) {
    const holder = this.zoneLock.get(zone);
    if (holder && holder !== ship) return false;
    this.zoneLock.set(zone, ship);
    return true;
  }

  /** 접근선은 선석 정횡에 닿으면, 출항선은 선회장을 350 m 벗어나면 점유를 푼다 */
  #releaseZones() {
    for (const [zone, ship] of this.zoneLock) {
      const done = (ship.phase === 'berthing' && ship.legIdx >= 1)
        || ship.phase === 'moored'
        || ship.phase === 'away'
        || (ship.phase === 'portOut' && dist(ship, NODES[zone]) > 350);
      if (done) this.zoneLock.delete(zone);
    }
  }

  #sail(ship, dt, endSpeed, holdBack = 0) {
    if (endSpeed != null) ship.path.endSpeed = endSpeed;
    const g = this.#guide(ship);
    let vDes = Math.min(g.v, this.#trafficLimit(ship));
    if (holdBack) vDes = Math.min(vDes, Math.sqrt(2 * ship.aPlan * Math.max(0, g.remaining - holdBack)));
    ship.uCmd = vDes;
    const aAcc = (0.6 * ship.vService) / ship.tau;
    const aDec = (0.8 * ship.vService) / ship.tau;
    const du = clamp((vDes - ship.u) / 30, -aDec, aAcc);
    ship.accelCmd = du;
    ship.u = Math.max(0, ship.u + du * dt);
    // 타효는 선속에 비례한다. 저속에서는 전진 기관의 프로펠러 후류가 일부 보태고(정지 상태에서는 돌지 않는다),
    // 예선이 붙어 있으면 예선이 선수·선미를 밀고 끌어 침로를 잡아 준다.
    const tugHelp = ship.phase === 'portIn' && this.tugsReady(ship);
    const U = Math.max(Math.abs(ship.u), tugHelp ? 3 : 1.2);
    const [kp, tp] = ship.cls.nomoto;
    const eff = tugHelp ? 1 : Math.min(1, Math.abs(ship.u) / 1.5 + (ship.uCmd > 0.3 ? 0.35 : 0));
    const K = ((kp * U) / ship.L) * eff;
    const T = (tp * ship.L) / U;
    const err = wrapPi(g.chi - ship.psi);
    const Kp = 1.5;
    const Kd = K > 1e-5 ? Math.max(0, (2 * Math.sqrt(T * K * Kp) - 1) / K) : 0;
    const dCmd = clamp(Kp * err - Kd * ship.r, -35 * D2R, 35 * D2R);
    ship.delta += clamp(dCmd - ship.delta, -2.5 * D2R * dt, 2.5 * D2R * dt);
    ship.r += (dt * (K * ship.delta - ship.r)) / T;
    const vT = -0.12 * ship.r * ship.L * Math.min(1, ship.u / 2);
    ship.v += (vT - ship.v) * Math.min(1, dt / 30);
    ship.avoidBias = Math.max(0, ship.avoidBias - 0.4 * dt);
    this.#integrate(ship, dt);
    return g;
  }

  /** 예선 보조 이동: 남은 거리에 맞춘 감속 프로파일로 목표 자세까지 */
  #assist(ship, dt) {
    const leg = ship.legs[ship.legIdx];
    const h = fwdVec(ship.psi);
    const s = stbdVec(ship.psi);
    const dx = leg.x - ship.x;
    const dy = leg.y - ship.y;
    const ex = dx * h.x + dy * h.y;
    const ey = dx * s.x + dy * s.y;
    const epsi = wrapPi(leg.psi - ship.psi);
    const aL = ship.aPlan;
    const aT = ship.aLat;
    const aR = ship.rMax / 45;
    const prof = (e, vmax, a, k) => Math.sign(e) * Math.min(vmax, Math.sqrt(2 * a * Math.abs(e)) * 0.85, k * Math.abs(e) + 0.01);
    const ud = Math.abs(ex) < 0.3 ? 0 : prof(ex, leg.vLong, aL, 0.04);
    const vd = Math.abs(ey) < 0.2 ? 0 : prof(ey, leg.vLat, aT, 0.03);
    const rd = Math.abs(epsi) < 0.002 ? 0 : prof(epsi, ship.rMax, aR, 0.05);
    ship.u += clamp(ud - ship.u, -aL * 1.5 * dt, aL * 1.5 * dt);
    ship.v += clamp(vd - ship.v, -aT * dt, aT * dt);
    ship.r += clamp(rd - ship.r, -aR * dt, aR * dt);
    ship.uCmd = ud;
    ship.accelCmd = 0;
    ship.delta += clamp(0 - ship.delta, -2.5 * D2R * dt, 2.5 * D2R * dt);
    this.#integrate(ship, dt);
    const d = Math.hypot(dx, dy);
    const done = leg.pass
      ? d < 6 && Math.abs(epsi) < 3 * D2R
      : d < 0.8 && Math.abs(epsi) < 0.4 * D2R && Math.abs(ship.u) < 0.08 && Math.abs(ship.v) < 0.05;
    if (!done) return false;
    if (!leg.pass) {
      Object.assign(ship, { x: leg.x, y: leg.y, psi: leg.psi, u: 0, v: 0, r: 0 });
    }
    ship.legIdx++;
    return ship.legIdx >= ship.legs.length;
  }

  #updateAnchor(ship, dt) {
    const target = windFrom(this.t) + 12 * D2R * Math.sin((TWO_PI * this.t) / (700 + 2 * ship.L) + ship.sheerPhase);
    const rWant = clamp(wrapPi(target - ship.psi) / 240, -0.12 * D2R, 0.12 * D2R);
    ship.r += clamp(rWant - ship.r, -0.002 * dt, 0.002 * dt);
    ship.psi = wrap2Pi(ship.psi + ship.r * dt);
    ship.u = ship.v = 0;
    ship.delta = 0;
    ship.uCmd = 0;
    if (ship.phase === 'anchoring') {
      ship.scope = Math.min(this.#targetScope(ship), ship.scope + 0.25 * dt);
      if (ship.scope >= this.#targetScope(ship)) {
        ship.phase = 'anchored';
        this.log(ship, `${ship.spot.anchorage.label} 투묘 완료 · 대기`);
        if (ship.slot) this.#startHeaving(ship);
      }
    } else if (ship.phase === 'heaving') {
      ship.scope = Math.max(0, ship.scope - 0.15 * dt);
      if (ship.scope <= 0) {
        this.log(ship, '닻 감아올림 완료 (Anchor aweigh)');
        ship.anchor = null;
        this.#releaseSpot(ship);
        ship.waitSince = null;
        ship.u = 0.3;
        this.#proceedToBerth(ship);
        return;
      }
    }
    if (ship.phase === 'buoyMoored') ship.scope += (HAWSER - ship.scope) * Math.min(1, dt / 120);
    this.#placeOnAnchor(ship);
  }

  #updateShip(ship, dt) {
    const px = ship.x;
    const py = ship.y;
    switch (ship.phase) {
      case 'away':
        if (this.t >= ship.returnAt) this.#spawn(ship);
        return;
      case 'seaIn': {
        const g = this.#sail(ship, dt);
        if (g.remaining < 600) this.#startPortIn(ship);
        break;
      }
      case 'toAnchor': {
        const g = this.#sail(ship, dt);
        if (g.remaining < Math.max(15, 0.05 * ship.L) && ship.u < 0.4) {
          const h = fwdVec(ship.psi);
          ship.anchor = { x: ship.x + h.x * ship.L / 2, y: ship.y + h.y * ship.L / 2 };
          ship.scope = 0;
          ship.r = 0;
          ship.phase = 'anchoring';
          this.log(ship, `${ship.spot.anchorage.label} 투묘 (Let go anchor)`);
        }
        break;
      }
      case 'anchoring':
      case 'anchored':
      case 'heaving':
      case 'buoyMoored':
        this.#updateAnchor(ship, dt);
        if (ship.phase === 'buoyMoored') this.#mooredOps(ship, dt);
        break;
      case 'portIn':
      case 'buoyIn': {
        if (!ship.tugsNeeded && ship.pathRemaining < 4500) this.requestTugs(ship);
        const ready = this.tugsReady(ship);
        const zone = this.#zoneOf(ship);
        const hold = zone && ship.pathRemaining < 1300 && !this.#tryLock(zone, ship);
        const g = this.#sail(ship, dt, ready && !hold ? 0.8 : 0, hold ? 750 : 0);
        if (g.remaining < Math.max(12, 0.05 * ship.L) && ready) {
          if (ship.phase === 'portIn') this.#startBerthing(ship);
          else {
            const p = ship.buoyTarget;
            ship.legs = [{ ...p, vLong: 0.8, vLat: 0.12, pass: false, label: '부이 접근' }];
            ship.legIdx = 0;
            ship.phase = 'buoyMooring';
            ship.path = null;
            this.log(ship, `${ship.slot.id} 부이 픽업 접근`);
          }
        }
        break;
      }
      case 'berthing':
      case 'buoyMooring':
        if (this.#assist(ship, dt)) {
          if (ship.phase === 'buoyMooring') {
            ship.anchor = { ...ship.slot.buoy };
            ship.scope = dist(ship, ship.anchor) - ship.L / 2;
          }
          this.#startMoored(ship);
        }
        break;
      case 'moored':
        ship.u = ship.v = ship.r = 0;
        this.#mooredOps(ship, dt);
        break;
      case 'unberthing':
      case 'buoyLeave':
        if (this.#assist(ship, dt)) this.#startPortOut(ship);
        break;
      case 'portOut': {
        const g = this.#sail(ship, dt);
        if (g.remaining < 200) this.#leave(ship);
        break;
      }
      default:
        break;
    }
    if (dt > 0 && ship.phase !== 'away') {
      const k = Math.min(1, dt / 4);
      ship.vx += ((ship.x - px) / dt - ship.vx) * k;
      ship.vy += ((ship.y - py) / dt - ship.vy) * k;
    }
  }

  /** 이안 허가: 선회 지점 주변에 기동 중인 다른 선박이 없을 것(정지 대기선은 바로 옆이 아니면 무시) */
  #clearToDepart(ship) {
    if (ship.slot.facility.kind === 'buoy') return true;
    const sw = this.swingPoint(ship.slot, ship);
    return this.ships.every((o) => {
      if (o === ship || STATIONARY.has(o.phase)) return true;
      const d = dist(o, sw) - (ship.L + o.L) / 2;
      return o.sog < 0.3 && !ASSISTED.has(o.phase) ? d > 80 : d > 300;
    });
  }

  #mooredOps(ship, dt) {
    this.#updateStages(ship, dt);
    const zone = this.#zoneOf(ship);
    if (ship.stage === 'ready' && this.tugsReady(ship) && this.#clearToDepart(ship) && (!zone || this.#tryLock(zone, ship))) {
      this.#startUnberthing(ship);
      if (ship.phase === 'buoyLeave') {
        ship.anchor = null;
        ship.scope = 0;
      }
    }
  }

  /** dt(초)만큼 진행. 내부에서 0.5초 이하로 나눠 적분한다. */
  step(dtTotal) {
    const n = Math.max(1, Math.ceil(dtTotal / 0.5));
    const dt = dtTotal / n;
    for (let i = 0; i < n; i++) {
      this.t += dt;
      this.#assignTugs();
      for (const ship of this.ships) this.#updateShip(ship, dt);
      for (const tug of this.tugs) this.#updateTug(tug, dt);
      this.#releaseZones();
    }
  }

  /** 예상 도착(선석 접안) 시각: 남은 경로/현재 속력 기준 대략값 */
  etaOf(ship) {
    if (ship.phase === 'away') return ship.returnAt;
    if (!ship.path || !['seaIn', 'portIn', 'buoyIn'].includes(ship.phase)) return null;
    const v = Math.max(ship.u, 2);
    return this.t + ship.pathRemaining / v + 20 * 60;
  }
}

export function fmtDur(s) {
  const m = Math.round(s / 60);
  if (m < 60) return `${m}분`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}
