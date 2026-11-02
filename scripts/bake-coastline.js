// 개발용 1회성 도구: OpenStreetMap 해안선(natural=coastline)을 받아 시뮬레이션 영역으로 자른 육지 폴리곤을
// public/data/coastline.json 으로 굽는다. 앱은 실행 중에 이 파일만 읽고 외부를 호출하지 않는다.
// 데이터 © OpenStreetMap contributors (ODbL).
//
//   node scripts/bake-coastline.js                 # Overpass 에서 받기
//   node scripts/bake-coastline.js raw.json        # 이미 받은 Overpass JSON 사용
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BOUNDS, toLocal } from '../public/js/geo.js';

const OUT = fileURLToPath(new URL('../public/data/coastline.json', import.meta.url));
const TOLERANCE_M = 2;

async function loadRaw(path) {
  if (path) return JSON.parse(await readFile(path, 'utf8'));
  const { south, west, north, east } = BOUNDS;
  const query = `[out:json][timeout:90];way["natural"="coastline"](${south},${west},${north},${east});out geom;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'sk-portwise coastline bake' },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) throw new Error(`overpass ${res.status}`);
  return res.json();
}

/** 끝점 노드 id 로 way 를 이어 붙여 체인(열린 선 또는 닫힌 고리)을 만든다. 육지는 진행 방향 왼쪽. */
function mergeWays(ways) {
  const chains = ways.map((w) => ({ ids: [...w.nodes], pts: w.geometry.map((g) => toLocal(g.lat, g.lon)) }));
  let merged = true;
  while (merged) {
    merged = false;
    for (const a of chains) {
      if (a.ids[0] === a.ids.at(-1)) continue;
      const b = chains.find((c) => c !== a && c.ids[0] === a.ids.at(-1));
      if (!b) continue;
      a.ids.push(...b.ids.slice(1));
      a.pts.push(...b.pts.slice(1));
      chains.splice(chains.indexOf(b), 1);
      merged = true;
      break;
    }
  }
  return chains;
}

// 영역 사각형(로컬 미터)
const { x: X0, y: Y0 } = toLocal(BOUNDS.south, BOUNDS.west);
const { x: X1, y: Y1 } = toLocal(BOUNDS.north, BOUNDS.east);
const inside = (p) => p.x >= X0 && p.x <= X1 && p.y >= Y0 && p.y <= Y1;
const PERIMETER = 2 * (X1 - X0) + 2 * (Y1 - Y0);

/** 사각형 둘레 위치(남서 모서리 0 에서 반시계 방향) */
function perimeterT(p) {
  const eps = 1e-6;
  if (Math.abs(p.y - Y0) < eps) return p.x - X0;
  if (Math.abs(p.x - X1) < eps) return X1 - X0 + (p.y - Y0);
  if (Math.abs(p.y - Y1) < eps) return X1 - X0 + (Y1 - Y0) + (X1 - p.x);
  return 2 * (X1 - X0) + (Y1 - Y0) + (Y1 - p.y);
}

/** 선분 a→b 와 사각형의 교차 구간 [t0,t1] (Liang–Barsky), 없으면 null */
function clipSegment(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [[-dx, a.x - X0], [dx, X1 - a.x], [-dy, a.y - Y0], [dy, Y1 - a.y]]) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** 체인을 사각형으로 잘라 사각형 경계에서 들어와 경계로 나가는 조각들로 나눈다. */
function clipChain(pts) {
  const pieces = [];
  let cur = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const c = clipSegment(a, b);
    if (!c) continue;
    const [t0, t1] = c;
    if (!cur) cur = [t0 > 0 ? lerp(a, b, t0) : a];
    if (t0 > 0 && cur.length > 1) throw new Error('chain re-entered without exit');
    if (t1 < 1) {
      cur.push(lerp(a, b, t1));
      pieces.push(cur);
      cur = null;
    } else {
      cur.push(b);
    }
  }
  if (cur) pieces.push(cur);
  return pieces;
}

/** 열린 조각들을 사각형 경계를 따라 반시계로 이어 육지 폴리곤을 만든다. */
function closeAlongBoundary(pieces) {
  const corners = [
    { t: 0, p: { x: X0, y: Y0 } },
    { t: X1 - X0, p: { x: X1, y: Y0 } },
    { t: X1 - X0 + (Y1 - Y0), p: { x: X1, y: Y1 } },
    { t: 2 * (X1 - X0) + (Y1 - Y0), p: { x: X0, y: Y1 } },
  ];
  const open = pieces.map((pts) => ({ pts, s: perimeterT(pts[0]), e: perimeterT(pts.at(-1)), used: false }));
  const rings = [];
  for (const first of open) {
    if (first.used) continue;
    const ring = [];
    let piece = first;
    for (;;) {
      piece.used = true;
      ring.push(...piece.pts);
      const from = piece.e;
      const dist = (s) => (s - from + PERIMETER) % PERIMETER;
      const next = open.filter((o) => !o.used || o === first).sort((a, b) => dist(a.s) - dist(b.s))[0];
      const gap = dist(next.s);
      for (const c of [...corners].sort((a, b) => dist(a.t) - dist(b.t))) {
        if (dist(c.t) > 0 && dist(c.t) < gap) ring.push(c.p);
      }
      if (next === first) break;
      piece = next;
    }
    rings.push(ring);
  }
  return rings;
}

function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const a = pts[i];
    const b = pts[j];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    let max = 0;
    let idx = -1;
    for (let k = i + 1; k < j; k++) {
      const p = pts[k];
      const d = Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len;
      if (d > max) {
        max = d;
        idx = k;
      }
    }
    if (max > tol) {
      keep[idx] = 1;
      stack.push([i, idx], [idx, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

/** 닫힌 고리: 시작점에서 가장 먼 점으로 둘로 나눠 각각 단순화한다(시작=끝이면 기준선이 0 길이가 되므로). */
function simplifyRing(ring, tol) {
  const o = ring[0];
  let k = 1;
  ring.forEach((p, i) => {
    if (Math.hypot(p.x - o.x, p.y - o.y) > Math.hypot(ring[k].x - o.x, ring[k].y - o.y)) k = i;
  });
  const a = simplify(ring.slice(0, k + 1), tol);
  const b = simplify([...ring.slice(k), o], tol);
  return [...a, ...b.slice(1, -1)];
}

const area = (ring) => ring.reduce((s, p, i) => {
  const q = ring[(i + 1) % ring.length];
  return s + p.x * q.y - q.x * p.y;
}, 0) / 2;

const raw = await loadRaw(process.argv[2]);
const chains = mergeWays(raw.elements.filter((e) => e.type === 'way'));
const rings = [];
const pieces = [];
for (const c of chains) {
  const closed = c.ids[0] === c.ids.at(-1);
  if (closed && c.pts.every(inside)) {
    rings.push(c.pts.slice(0, -1));
  } else if (closed) {
    // 고리가 영역 안에서 시작하면 잘린 첫·끝 조각이 끊기므로 영역 밖 점에서 시작하도록 돌린다
    const ring = c.pts.slice(0, -1);
    const k = ring.findIndex((p) => !inside(p));
    const rotated = [...ring.slice(k), ...ring.slice(0, k)];
    pieces.push(...clipChain([...rotated, rotated[0]]));
  } else {
    pieces.push(...clipChain(c.pts));
  }
}
const onBoundary = (p) => [p.x - X0, p.x - X1, p.y - Y0, p.y - Y1].some((d) => Math.abs(d) < 1e-6);
for (const p of pieces) {
  if (!onBoundary(p[0]) || !onBoundary(p.at(-1))) {
    throw new Error('open coastline piece does not touch the boundary (incomplete data?)');
  }
}
rings.push(...closeAlongBoundary(pieces));

const land = rings
  .map((r) => simplifyRing(r, TOLERANCE_M))
  .filter((r) => r.length >= 3 && area(r) > 50)
  .map((r) => r.map((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]));

await writeFile(OUT, `${JSON.stringify({
  attribution: '© OpenStreetMap contributors (ODbL)',
  bounds: BOUNDS,
  rect: [X0, Y0, X1, Y1].map((v) => Math.round(v * 10) / 10),
  land,
})}\n`);
console.log(`land polygons: ${land.length}, vertices: ${land.reduce((s, r) => s + r.length, 0)} → ${OUT}`);
