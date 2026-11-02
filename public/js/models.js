// 절차적 선박 모델. 선체는 횡단면(만곡부 반경·선수 플레어·선미 트랜섬)을 길이 방향으로 이어 만든다.
// 로컬 좌표: 선수 = -Z, 우현 = +X, 위 = +Y, 원점 = 선체 중앙 용골(y=0). 물 위에 띄울 때 y = -흘수.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const tmpColor = new THREE.Color();
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 정점 색을 입힌 비인덱스 지오메트리 */
function paint(geom, color) {
  const g = geom.index ? geom.toNonIndexed() : geom;
  if (g.attributes.uv) g.deleteAttribute('uv');
  if (g.attributes.uv1) g.deleteAttribute('uv1');
  tmpColor.set(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = tmpColor.r;
    arr[i * 3 + 1] = tmpColor.g;
    arr[i * 3 + 2] = tmpColor.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const e = new THREE.Euler();
function place(geom, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  e.set(rx, ry, rz);
  q.setFromEuler(e);
  m4.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy, sz));
  geom.applyMatrix4(m4);
  return geom;
}

const box = (w, h, d, color, x, y, z, rx, ry, rz) => paint(place(new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz), color);
/** 축 방향 원기둥. axis: 'y'(수직) | 'z'(선수미) | 'x'(좌우) */
function cyl(r1, r2, h, color, x, y, z, axis = 'y', seg = 14) {
  const g = new THREE.CylinderGeometry(r1, r2, h, seg);
  const rx = axis === 'z' ? Math.PI / 2 : 0;
  const rz = axis === 'x' ? Math.PI / 2 : 0;
  return paint(place(g, x, y, z, rx, 0, rz), color);
}
const sphere = (r, color, x, y, z, sx = 1, sy = 1, sz = 1) => paint(place(new THREE.SphereGeometry(r, 18, 12), x, y, z, 0, 0, 0, sx, sy, sz), color);

/** 두 점을 잇는 막대(배관·붐) */
function rod(a, b, r, color, seg = 8) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  g.translate(0, len / 2, 0);
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  g.applyQuaternion(quat);
  g.translate(a.x, a.y, a.z);
  return paint(g, color);
}

// ── 선체 ─────────────────────────────────────────────────────────────────────

/**
 * o: { L, B, D, T(만재흘수 = 선저도료 경계), fwdBody, aftBody, rake, overhang, sheerBow, sheerStern,
 *      bottom, hull, deck, band?(현측 상단 띠 색), bandH? }
 */
export function buildHull(o) {
  const { L, B, D, T } = o;
  const halfB = B / 2;
  const r = Math.min(0.12 * D, 0.07 * B);
  const NS = 56;
  const ts = Array.from({ length: NS + 1 }, (_, i) => 0.5 - 0.5 * Math.cos((Math.PI * i) / NS));
  const deckH = (t) => D + o.sheerBow * smooth(0.78, 1, t) + o.sheerStern * smooth(0.18, 0, t);
  const hb = (t, y) => {
    const h = y / D;
    let s = 1;
    if (y < r) {
      const dy = r - y;
      s = (halfB - r + Math.sqrt(Math.max(0, r * r - dy * dy))) / halfB;
    }
    let f = 1;
    if (t > o.fwdBody) {
      const u = (t - o.fwdBody) / (1 - o.fwdBody);
      f = 1 - u ** (1.5 + 1.4 * Math.min(1, h));
    } else if (t < o.aftBody) {
      const u = (o.aftBody - t) / o.aftBody;
      const k = 0.97 - 0.72 * smooth(0.3, 0.95, h);
      f = 1 - u ** 1.6 * k;
    }
    return halfB * s * Math.max(0, f);
  };
  const zOf = (t, y) => {
    const h = y / D;
    let x = (t - 0.5) * L;
    x += o.rake * L * smooth(0.9, 1, t) * (h - 0.35);
    x -= o.overhang * L * smooth(0.06, 0, t) * smooth(0.45, 1, h);
    return -x;
  };

  const parts = [];
  /** 한 띠(높이 구간)의 우현·좌현 외판 */
  const band = (yLevels, color, withBottom) => {
    const pos = [];
    const sec = ts.map((t) => {
      const ys = yLevels(t);
      const pts = ys.map((y) => [hb(t, y), y, zOf(t, y)]);
      if (withBottom) pts.unshift([0, 0, zOf(t, 0)]);
      return pts;
    });
    for (let i = 0; i < NS; i++) {
      const s0 = sec[i];
      const s1 = sec[i + 1];
      for (let j = 0; j < s0.length - 1; j++) {
        const A = s0[j];
        const Bq = s1[j];
        const C = s1[j + 1];
        const Dq = s0[j + 1];
        for (const side of [1, -1]) {
          const P = (p) => [p[0] * side, p[1], p[2]];
          const tri = side === 1 ? [A, Bq, C, A, C, Dq] : [A, C, Bq, A, Dq, C];
          for (const p of tri) pos.push(...P(p));
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const merged = mergeVerticesForNormals(g);
    parts.push(paint(merged, color));
  };
  const nLow = 7;
  band((t) => {
    const ys = [0, r * 0.25, r * 0.6, r];
    for (let k = 1; k <= nLow; k++) ys.push(r + ((T - r) * k) / nLow);
    return ys;
  }, o.bottom, true);
  const bandH = o.bandH ?? 0;
  band((t) => {
    const top = deckH(t) - bandH;
    return [T, T + (top - T) * 0.25, T + (top - T) * 0.5, T + (top - T) * 0.75, top];
  }, o.hull, false);
  if (bandH) band((t) => [deckH(t) - bandH, deckH(t)], o.band, false);

  // 갑판
  {
    const pos = [];
    for (let i = 0; i < NS; i++) {
      const t0 = ts[i];
      const t1 = ts[i + 1];
      const y0 = deckH(t0);
      const y1 = deckH(t1);
      const w0 = hb(t0, y0);
      const w1 = hb(t1, y1);
      const z0 = zOf(t0, y0);
      const z1 = zOf(t1, y1);
      const A = [-w0, y0, z0];
      const Bq = [w0, y0, z0];
      const C = [w1, y1, z1];
      const Dq = [-w1, y1, z1];
      pos.push(...A, ...Bq, ...C, ...A, ...C, ...Dq);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    parts.push(paint(g, o.deck));
  }
  // 트랜섬(선미 마감)
  {
    const t = 0;
    const top = deckH(t);
    const ys = [0, r * 0.6, r, T * 0.5, T, (T + top) / 2, top];
    const star = ys.map((y) => [hb(t, y), y, zOf(t, y)]);
    const ring = [...star, ...star.slice().reverse().map((p) => [-p[0], p[1], p[2]])];
    const c = [0, top * 0.55, zOf(t, top * 0.55)];
    const pos = [];
    for (let k = 0; k < ring.length - 1; k++) pos.push(...c, ...ring[k], ...ring[k + 1]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    parts.push(paint(g, o.hull));
  }
  return { parts, deckH, hb, zOf, r };
}

/** 같은 위치 정점을 합쳐 부드러운 법선을 계산한 뒤 다시 비인덱스로 */
function mergeVerticesForNormals(g) {
  const pos = g.attributes.position.array;
  const map = new Map();
  const index = [];
  const verts = [];
  for (let i = 0; i < pos.length; i += 3) {
    const key = `${pos[i].toFixed(3)},${pos[i + 1].toFixed(3)},${pos[i + 2].toFixed(3)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = verts.length / 3;
      map.set(key, id);
      verts.push(pos[i], pos[i + 1], pos[i + 2]);
    }
    index.push(id);
  }
  const ig = new THREE.BufferGeometry();
  ig.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  ig.setIndex(index);
  ig.computeVertexNormals();
  return ig.toNonIndexed();
}

// ── 공용 재질 ─────────────────────────────────────────────────────────────────

export const MATERIALS = {
  body: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.08 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x1b2633, roughness: 0.15, metalness: 0.6, emissive: 0xffd9a0, emissiveIntensity: 0 }),
  bronze: new THREE.MeshStandardMaterial({ color: 0xb08d57, roughness: 0.35, metalness: 0.85 }),
};

const C = {
  bottom: '#8f2a22',
  white: '#eeede7',
  grey: '#9aa0a4',
  dark: '#2a2d30',
  pipe: '#a9adae',
  pipeY: '#c9a43a',
  orange: '#e8641e',
  black: '#1b1c1d',
  lpgTank: '#d8dcdc',
};

// ── 선박 ─────────────────────────────────────────────────────────────────────

/**
 * 선박 3D 모델.
 * 반환: { root(Object3D, 흘수·자세는 호출자가), pickable(Mesh[]), rudder, propeller, radar[], lights(로컬 위치), anchors }
 */
export function buildShip(spec, cls) {
  const L = spec.loa;
  const B = spec.beam;
  const D = spec.depth;
  const T = spec.draftLaden;
  const [hullColor, deckColor, funnelColor, bandColor] = spec.livery;
  const kind = cls.kind;
  const big = L > 200;
  const o = {
    L, B, D, T,
    fwdBody: kind === 'lpg' || kind === 'chemical' ? 0.7 : big ? 0.78 : 0.73,
    aftBody: big ? 0.2 : 0.24,
    rake: 0.012,
    overhang: 0.012,
    sheerBow: Math.max(1.6, 0.012 * L),
    sheerStern: 0.4,
    bottom: C.bottom,
    hull: hullColor,
    deck: deckColor,
    bandH: 0,
  };
  const hull = buildHull(o);
  const parts = [...hull.parts];
  const glass = [];
  const { deckH, hb } = hull;
  const zAt = (t) => -(t - 0.5) * L;
  const deckAt = (t) => deckH(t);

  // 구상선수
  parts.push(sphere(1, C.bottom, 0, T * 0.42, -L / 2 + 0.018 * L, 0.11 * B, 0.3 * T, 0.036 * L));

  // 거주구·선교
  const decks = L > 250 ? 7 : L > 180 ? 6 : L > 110 ? 5 : 4;
  const tierH = 2.85;
  const accFront = zAt(0.165);
  const accLen = Math.max(12, 0.075 * L);
  const accW = B * (L > 200 ? 0.66 : 0.78);
  const base = deckAt(0.12);
  const accZ = accFront + accLen / 2;
  for (let k = 0; k < decks; k++) {
    const shrink = k === decks - 1 ? 0.92 : 1 - k * 0.02;
    const w = accW * shrink;
    const len = accLen * (k === decks - 1 ? 0.8 : 1);
    const y = base + tierH * k + tierH / 2;
    const z = accZ + (accLen - len) / 2;
    parts.push(box(w, tierH, len, C.white, 0, y, z));
    // 창문 띠(앞면·옆면)
    glass.push(place(new THREE.BoxGeometry(w * 0.86, 0.9, 0.15), 0, y + 0.2, z - len / 2 - 0.05));
    glass.push(place(new THREE.BoxGeometry(0.15, 0.8, len * 0.8), w / 2 + 0.05, y + 0.2, z));
    glass.push(place(new THREE.BoxGeometry(0.15, 0.8, len * 0.8), -w / 2 - 0.05, y + 0.2, z));
  }
  const bridgeY = base + tierH * (decks - 1);
  const bridgeTop = base + tierH * decks;
  // 선교 날개
  parts.push(box(B + 1.5, 0.5, 3.2, C.white, 0, bridgeY + 0.25, accFront + 1.6));
  parts.push(box(B + 1.5, 1.2, 0.2, C.white, 0, bridgeY + 1.1, accFront + 0.1));
  glass.push(place(new THREE.BoxGeometry(accW * 0.86, 1.4, 0.2), 0, bridgeY + 1.9, accFront + accLen * 0.1 - 0.1));
  // 레이더 마스트
  const mastBaseZ = accZ;
  const mastTop = bridgeTop + 9;
  parts.push(cyl(0.35, 0.45, mastTop - bridgeTop, C.white, 0, (mastTop + bridgeTop) / 2, mastBaseZ));
  parts.push(box(6, 0.3, 1.2, C.white, 0, bridgeTop + 4.5, mastBaseZ));
  parts.push(box(3.5, 0.25, 0.8, C.white, 0, mastTop - 1.5, mastBaseZ));
  // 연돌
  const funZ = accZ + accLen / 2 + 0.03 * L;
  const funH = bridgeTop + 3 - base;
  const funW = Math.max(3, 0.17 * B);
  const funL = Math.max(4, 0.05 * L);
  parts.push(box(funW, funH, funL, funnelColor, 0, base + funH / 2, funZ, -0.05, 0, 0));
  parts.push(box(funW * 1.02, funH * 0.14, funL * 1.02, bandColor, 0, base + funH * 0.62, funZ - funH * 0.62 * 0.05));
  parts.push(box(funW * 1.03, 1.2, funL * 1.03, C.black, 0, base + funH - 0.4, funZ - funH * 0.05));
  // 기관실 케이싱·선미 갑판
  parts.push(box(accW * 0.8, 3, (L / 2 - funZ) * 0.6, C.white, 0, base + 1.5, funZ + funL));
  // 자유낙하식 구명정
  parts.push(paint(place(new THREE.CapsuleGeometry(1.6, Math.max(5, 0.025 * L), 6, 10), 0, base + 5, L / 2 - 4, Math.PI / 2 + 0.55, 0, 0), C.orange));
  // 앞 마스트
  const foreT = 0.965;
  const foreY = deckAt(foreT);
  parts.push(cyl(0.3, 0.4, 12, C.dark, 0, foreY + 6, zAt(foreT)));
  // 선수루 장비
  parts.push(box(B * 0.35, 1.6, 3, C.dark, 0, foreY + 0.8, zAt(0.94)));
  parts.push(box(B * 0.3, 1.2, 2.5, C.dark, 0, deckAt(0.04) + 0.6, zAt(0.04)));

  // 화물 구역
  const cargoFrom = 0.2;
  const cargoTo = 0.9;
  const zFrom = zAt(cargoFrom);
  const zTo = zAt(cargoTo);
  const cargoLen = zFrom - zTo;
  const cargoMid = (zFrom + zTo) / 2;
  const dk = deckAt(0.5);
  if (kind === 'crude' || kind === 'product' || kind === 'chemical') {
    // 캣워크
    parts.push(box(1.4, 0.25, cargoLen + 8, C.grey, 0, dk + 2.2, cargoMid));
    for (let z = zTo; z <= zFrom; z += 12) parts.push(box(0.25, 2.2, 0.25, C.grey, 0, dk + 1.1, z));
    // 화물 배관
    const nPipes = kind === 'chemical' ? 8 : kind === 'product' ? 5 : 3;
    for (let i = 0; i < nPipes; i++) {
      const x = (i - (nPipes - 1) / 2) * (B * 0.045) + (i % 2 ? 0.2 : -0.2);
      const rr = kind === 'crude' ? 0.45 : 0.28;
      parts.push(cyl(rr, rr, cargoLen, i % 3 === 2 ? C.pipeY : C.pipe, x + 2.2, dk + 0.8, cargoMid, 'z', 8));
    }
    // 매니폴드
    for (let i = -2; i <= 2; i++) parts.push(cyl(0.35, 0.35, B * 0.86, C.pipe, 0, dk + 1.3, cargoMid + i * 1.6, 'x', 8));
    parts.push(box(B * 0.5, 0.2, 8, C.grey, 0, dk + 2.4, cargoMid));
    // 호스 크레인(좌우)
    for (const sx of [-1, 1]) {
      const px = sx * B * 0.32;
      parts.push(cyl(0.6, 0.7, 6, C.white, px, dk + 3, cargoMid + 6));
      parts.push(rod(new THREE.Vector3(px, dk + 6, cargoMid + 6), new THREE.Vector3(px + sx * 3, dk + 9, cargoMid - 8), 0.35, C.white));
    }
    // 탱크 해치·돔
    const nTanks = kind === 'chemical' ? 12 : 7;
    for (let i = 0; i < nTanks; i++) {
      const z = zTo + ((i + 0.5) * cargoLen) / nTanks;
      for (const sx of [-1, 1]) {
        parts.push(cyl(0.7, 0.7, 1.0, kind === 'chemical' ? C.white : C.grey, sx * B * 0.22, dk + 0.5, z, 'y', 10));
        if (kind === 'chemical') parts.push(cyl(0.18, 0.18, 4, C.white, sx * B * 0.12, dk + 2, z + 2, 'y', 6));
      }
    }
  } else if (kind === 'lpg') {
    const n = L > 100 ? 3 : 2;
    const tr = B * 0.33;
    const tl = (cargoLen - 6) / n - 2;
    for (let i = 0; i < n; i++) {
      const z = zTo + 3 + tl / 2 + i * (tl + 2);
      parts.push(cyl(tr, tr, tl, C.lpgTank, 0, dk + tr * 0.25, z, 'z', 24));
      parts.push(sphere(tr, C.lpgTank, 0, dk + tr * 0.25, z - tl / 2, 1, 1, 0.35));
      parts.push(sphere(tr, C.lpgTank, 0, dk + tr * 0.25, z + tl / 2, 1, 1, 0.35));
      parts.push(cyl(1.0, 1.0, 1.4, C.grey, 0, dk + tr * 1.25 + 0.5, z, 'y', 10));
    }
    parts.push(box(1.2, 0.25, cargoLen, C.grey, B * 0.36, dk + 2.2, cargoMid));
    parts.push(cyl(0.3, 0.3, cargoLen, C.pipeY, B * 0.36, dk + 1.2, cargoMid, 'z', 8));
    for (let i = -1; i <= 1; i++) parts.push(cyl(0.3, 0.3, B * 0.86, C.pipe, 0, dk + 1.0, cargoMid + i * 1.6, 'x', 8));
  } else if (kind === 'vlgc') {
    parts.push(box(B * 0.56, 1.8, cargoLen, deckColor, 0, dk + 0.9, cargoMid));
    for (let i = 0; i < 4; i++) {
      const z = zTo + ((i + 0.5) * cargoLen) / 4;
      parts.push(cyl(2.4, 2.4, 2.2, C.white, 0, dk + 2.9, z, 'y', 16));
    }
    parts.push(box(2, 0.3, cargoLen, C.grey, B * 0.18, dk + 3.6, cargoMid));
    for (let i = 0; i < 4; i++) parts.push(cyl(0.35, 0.35, cargoLen, i === 1 ? C.pipeY : C.pipe, B * 0.3 + i * 0.9, dk + 0.9, cargoMid, 'z', 8));
    for (let i = -2; i <= 2; i++) parts.push(cyl(0.4, 0.4, B * 0.86, C.pipe, 0, dk + 1.2, cargoMid + i * 1.8, 'x', 8));
  }

  const root = new THREE.Group();
  const body = new THREE.Mesh(mergeGeometries(parts), MATERIALS.body);
  body.castShadow = true;
  body.receiveShadow = true;
  root.add(body);
  const glassMesh = new THREE.Mesh(mergeGeometries(glass.map((g) => stripForMerge(g))), MATERIALS.glass);
  root.add(glassMesh);

  // 프로펠러·타
  const propR = 0.32 * T;
  const propY = Math.max(propR + 0.5, 0.45 * T);
  const propZ = L / 2 - 0.045 * L;
  const propeller = new THREE.Group();
  const blades = [];
  for (let i = 0; i < 4; i++) {
    blades.push(place(new THREE.BoxGeometry(propR * 0.55, propR * 1.0, 0.25), 0, propR * 0.5, 0, 0.35, 0, 0));
    blades[i].rotateZ((i * Math.PI) / 2);
  }
  blades.push(new THREE.CylinderGeometry(propR * 0.18, propR * 0.18, 1.4, 12).rotateX(Math.PI / 2));
  propeller.add(new THREE.Mesh(mergeGeometries(blades.map(stripForMerge)), MATERIALS.bronze));
  propeller.position.set(0, propY, propZ);
  root.add(propeller);
  const rudder = new THREE.Group();
  const rudderH = 0.62 * T;
  const rudderC = 0.022 * L;
  const rmesh = new THREE.Mesh(paint(place(new THREE.BoxGeometry(0.5, rudderH, rudderC), 0, rudderH / 2, rudderC / 2), C.bottom), MATERIALS.body);
  rudder.add(rmesh);
  rudder.position.set(0, propY - propR * 0.6, propZ + propR * 0.35 + 1.5);
  root.add(rudder);
  // 레이더 스캐너
  const radar = [];
  for (const [y, len] of [[bridgeTop + 5, 4.5], [mastTop - 1.2, 3.2]]) {
    const r1 = new THREE.Mesh(paint(new THREE.BoxGeometry(len, 0.3, 0.45), C.dark), MATERIALS.body);
    r1.position.set(0, y, mastBaseZ);
    root.add(r1);
    radar.push(r1);
  }

  const wingX = (B + 1.5) / 2;
  const lights = {
    mastFwd: new THREE.Vector3(0, foreY + 12.3, zAt(foreT)),
    mastAft: new THREE.Vector3(0, mastTop + 0.4, mastBaseZ),
    port: new THREE.Vector3(-wingX, bridgeY + 1.6, accFront + 1),
    stbd: new THREE.Vector3(wingX, bridgeY + 1.6, accFront + 1),
    stern: new THREE.Vector3(0, deckAt(0) + 2, L / 2 + 0.3),
    anchorFwd: new THREE.Vector3(0, foreY + 4, -L / 2 + 6),
    anchorAft: new THREE.Vector3(0, deckAt(0) + 5, L / 2 - 2),
    cargoRed: new THREE.Vector3(0, mastTop - 2.5, mastBaseZ),
    flood: [new THREE.Vector3(0, dk + 9, cargoMid), new THREE.Vector3(0, dk + 9, zAt(0.75)), new THREE.Vector3(0, dk + 9, zAt(0.3))],
  };
  const anchors = {
    bow: new THREE.Vector3(0, foreY - 1.5, -L / 2 + 4),
    stern: new THREE.Vector3(0, deckAt(0), L / 2 - 1),
    manifoldP: new THREE.Vector3(-B / 2, dk + 1.2, cargoMid),
    manifoldS: new THREE.Vector3(B / 2, dk + 1.2, cargoMid),
    fairleads: {
      bowP: new THREE.Vector3(-hb(0.92, deckAt(0.92)) + 0.3, deckAt(0.92), zAt(0.92)),
      bowS: new THREE.Vector3(hb(0.92, deckAt(0.92)) - 0.3, deckAt(0.92), zAt(0.92)),
      sternP: new THREE.Vector3(-hb(0.06, deckAt(0.06)) + 0.3, deckAt(0.06), zAt(0.06)),
      sternS: new THREE.Vector3(hb(0.06, deckAt(0.06)) - 0.3, deckAt(0.06), zAt(0.06)),
      springFP: new THREE.Vector3(-B / 2 + 0.3, dk, zAt(0.62)),
      springAP: new THREE.Vector3(-B / 2 + 0.3, dk, zAt(0.3)),
    },
    bridge: new THREE.Vector3(0, bridgeY + 2.4, accFront - 0.8),
    labelY: mastTop + 6,
  };
  return { root, pickable: [body, glassMesh], rudder, propeller, radar, lights, anchors };
}

/** mergeGeometries 는 속성 구성이 같아야 하므로 위치·법선만 남긴다 */
function stripForMerge(g) {
  const n = g.index ? g.toNonIndexed() : g;
  for (const key of Object.keys(n.attributes)) if (key !== 'position' && key !== 'normal') n.deleteAttribute(key);
  if (!n.attributes.normal) n.computeVertexNormals();
  return n;
}

// ── 예선 ─────────────────────────────────────────────────────────────────────

export function buildTug() {
  const L = 32;
  const B = 12;
  const D = 5.4;
  const T = 4.6;
  const hull = buildHull({
    L, B, D, T, fwdBody: 0.62, aftBody: 0.28, rake: 0.05, overhang: 0.02, sheerBow: 1.6, sheerStern: 0,
    bottom: C.bottom, hull: '#c63c1c', deck: '#5d6166', band: C.black, bandH: 0.9,
  });
  const parts = [...hull.parts];
  const glass = [];
  const dk = hull.deckH(0.5);
  parts.push(box(B * 0.62, 2.6, L * 0.36, C.white, 0, dk + 1.3, -L * 0.06));
  parts.push(box(B * 0.5, 2.4, L * 0.2, C.white, 0, dk + 3.8, -L * 0.1));
  glass.push(place(new THREE.BoxGeometry(B * 0.52, 1.2, L * 0.21), 0, dk + 4.2, -L * 0.1));
  parts.push(box(B * 0.5, 0.2, L * 0.22, C.white, 0, dk + 5.1, -L * 0.1));
  parts.push(cyl(0.18, 0.22, 5, C.dark, 0, dk + 7.6, -L * 0.08));
  for (const sx of [-1, 1]) parts.push(box(0.9, 3.4, 1.4, C.dark, sx * B * 0.18, dk + 3.6, L * 0.1));
  parts.push(box(B * 0.4, 1.4, 2.2, C.dark, 0, dk + 0.7, L * 0.22));
  parts.push(box(0.4, 2.6, 0.4, C.dark, B * 0.3, dk + 1.3, L * 0.38));
  parts.push(box(0.4, 2.6, 0.4, C.dark, -B * 0.3, dk + 1.3, L * 0.38));
  parts.push(box(B * 0.64, 0.4, 0.4, C.dark, 0, dk + 2.6, L * 0.38));
  // 선수 펜더
  parts.push(box(B * 0.7, 1.6, 1.4, C.black, 0, D + 0.6, -L / 2 + 1));
  const root = new THREE.Group();
  const body = new THREE.Mesh(mergeGeometries(parts), MATERIALS.body);
  body.castShadow = true;
  root.add(body);
  root.add(new THREE.Mesh(mergeGeometries(glass.map(stripForMerge)), MATERIALS.glass));
  const lights = {
    mastFwd: new THREE.Vector3(0, dk + 10.2, -L * 0.08),
    mastAft: new THREE.Vector3(0, dk + 9.2, -L * 0.08),
    port: new THREE.Vector3(-B * 0.27, dk + 4.6, -L * 0.18),
    stbd: new THREE.Vector3(B * 0.27, dk + 4.6, -L * 0.18),
    stern: new THREE.Vector3(0, dk + 2.8, L * 0.38),
    towing: new THREE.Vector3(0, dk + 3.4, L * 0.38),
  };
  const anchors = { bow: new THREE.Vector3(0, D + 1, -L / 2 + 1), stern: new THREE.Vector3(0, dk + 1.6, L * 0.3), bridge: new THREE.Vector3(0, dk + 4.6, -L * 0.1), labelY: dk + 13 };
  return { root, pickable: [body], lights, anchors, draft: T };
}
