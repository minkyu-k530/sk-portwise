// 목업 시나리오 검증: 시뮬레이션을 헤드리스로 돌려 좌초(육지 침범)·선박 간 충돌·정체를 찾는다.
//   node scripts/check-scenario.js [시간=72] [--log]
// 위반이 있으면 종료 코드 1.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PHASE_KR, Simulation, fwdVec, stbdVec } from '../public/js/sim.js';

const hours = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 72);
const showLog = process.argv.includes('--log');
const coast = JSON.parse(await readFile(fileURLToPath(new URL('../public/data/coastline.json', import.meta.url)), 'utf8'));

function inPoly(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const onLand = (x, y) => coast.land.some((r) => inPoly(x, y, r));

/** 선체 외곽 점(선수·선미·양현), margin 만큼 안쪽 */
function hullPoints(o, margin) {
  const h = fwdVec(o.psi);
  const s = stbdVec(o.psi);
  const pts = [];
  const hl = o.L / 2 - margin;
  const hb = o.B / 2 - margin;
  for (const f of [-1, -0.5, 0, 0.5, 0.85]) for (const l of [-1, 1]) pts.push([f * hl, l * hb * (f > 0.6 ? 0.6 : 1)]);
  pts.push([hl, 0]);
  return pts.map(([f, l]) => ({ x: o.x + h.x * f + s.x * l, y: o.y + h.y * f + s.y * l }));
}

function corners(o, pad = 0) {
  const h = fwdVec(o.psi);
  const s = stbdVec(o.psi);
  const a = o.L / 2 + pad;
  const b = o.B / 2 + pad;
  return [[a, b], [a, -b], [-a, -b], [-a, b]].map(([f, l]) => ({ x: o.x + h.x * f + s.x * l, y: o.y + h.y * f + s.y * l }));
}

function overlap(p, q) {
  for (const poly of [p, q]) {
    for (let i = 0; i < 4; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % 4];
      const nx = b.y - a.y;
      const ny = a.x - b.x;
      const proj = (pts) => pts.map((v) => v.x * nx + v.y * ny);
      const pa = proj(p);
      const pb = proj(q);
      if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false;
    }
  }
  return true;
}

const sim = new Simulation();
const problems = new Map();
const report = (key, msg) => {
  if (!problems.has(key)) problems.set(key, { msg, count: 0, first: sim.t });
  problems.get(key).count++;
};
const phaseSince = new Map();
const LIMIT_H = { seaIn: 2, portIn: 3, toAnchor: 3, berthing: 1.5, unberthing: 1.5, buoyIn: 2.5, buoyMooring: 1.5, buoyLeave: 1.5, portOut: 3, heaving: 1, anchoring: 1 };
const hhmm = (t) => {
  const m = Math.floor(t / 60) + 7 * 60 + 30;
  return `D+${Math.floor(m / 1440)} ${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

const STEP = 2;
const started = performance.now();
let berthings = 0;
for (let t = 0; t < hours * 3600; t += STEP) {
  sim.step(STEP);
  const active = sim.ships.filter((s) => s.active);
  for (const s of active) {
    const prev = phaseSince.get(s.id);
    if (!prev || prev.phase !== s.phase) {
      if (s.phase === 'moored' || s.phase === 'buoyMoored') berthings++;
      phaseSince.set(s.id, { phase: s.phase, t: sim.t });
    } else if (LIMIT_H[s.phase] && sim.t - prev.t > LIMIT_H[s.phase] * 3600) {
      report(`stuck:${s.id}:${s.phase}`, `${s.name} ${PHASE_KR[s.phase]} 상태로 ${LIMIT_H[s.phase]}시간 초과 (${Math.round(s.x)},${Math.round(s.y)})`);
    }
    if (Math.floor(sim.t) % 10 < STEP) {
      const margin = s.phase === 'moored' ? 2 : 0.5;
      const hit = hullPoints(s, margin).find((p) => onLand(p.x, p.y));
      if (hit) report(`ground:${s.id}:${s.phase}`, `${s.name} 육지 침범 [${PHASE_KR[s.phase]}] @ ${Math.round(hit.x)},${Math.round(hit.y)}`);
    }
  }
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) > (a.L + b.L) / 2 + 20) continue;
      if (overlap(corners(a, 3), corners(b, 3))) {
        report(`collide:${[a.id, b.id].sort().join('-')}`, `${a.name}[${PHASE_KR[a.phase]}] ↔ ${b.name}[${PHASE_KR[b.phase]}] 근접/충돌 @ ${Math.round(a.x)},${Math.round(a.y)}`);
      }
    }
  }
  for (const tug of sim.tugs) {
    if (Math.floor(sim.t) % 10 < STEP && onLand(tug.x, tug.y)) report(`tug:${tug.id}`, `${tug.name} 육지 침범 @ ${Math.round(tug.x)},${Math.round(tug.y)}`);
  }
}

if (showLog) for (const e of sim.events) console.log(hhmm(e.t), e.name ?? '-', e.text);
const queues = sim.facilities.filter((f) => f.queue.length).map((f) => `${f.id}:${f.queue.length}`).join(' ') || '없음';
console.log(`\n${hours}시간 시뮬레이션 (${((performance.now() - started) / 1000).toFixed(1)}s) — 접안·계류 ${berthings}회, 종료 시 대기열 ${queues}`);
for (const s of sim.ships) console.log(`  ${s.name.padEnd(18)} ${PHASE_KR[s.phase].padEnd(10)} ${s.slot?.id ?? s.spot?.anchorage.id ?? ''}`);
if (problems.size) {
  console.log(`\n문제 ${problems.size}건:`);
  for (const { msg, count, first } of problems.values()) console.log(`  [${hhmm(first)}] ${msg} ×${count}`);
  process.exitCode = 1;
} else {
  console.log('\n문제 없음');
}
