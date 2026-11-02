// 정적 세계: 하늘·태양·바다·육지(OSM 해안선)·정유 탱크단지·부두 시설·부이·항로표지, 그리고 시간에 따른 조명.
import * as THREE from 'three';
import { Water } from 'three/addons/objects/Water.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ANCHORAGES, NODES } from './data.js';
import { ORIGIN } from './geo.js';

const D2R = Math.PI / 180;
export const toWorld = (x, y, h = 0) => new THREE.Vector3(x, h, -y);
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 결정적 난수(시드 고정) */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 태양 고도·방위(라디안). 방위는 진북 기준 시계방향 */
export function sunPosition(utcMs, lat = ORIGIN.lat, lng = ORIGIN.lng) {
  const d = utcMs / 86400000 - 10957.5;
  const g = (357.529 + 0.98560028 * d) * D2R;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R;
  const eps = (23.439 - 0.00000036 * d) * D2R;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(eps) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const H = ((gmst * 15 + lng) * D2R - ra);
  const phi = lat * D2R;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(H));
  return { alt, az: (az + 2 * Math.PI) % (2 * Math.PI) };
}

/** 바다 표면 노멀맵: 주기 경계가 맞는 정수 파수 사인 합으로 만든 타일 */
function waterNormalTexture(size = 256) {
  const rand = rng(7);
  const waves = Array.from({ length: 28 }, () => {
    const kx = Math.round((rand() - 0.5) * 18);
    const ky = Math.round((rand() - 0.5) * 18);
    const k = Math.hypot(kx, ky) || 1;
    return { kx, ky, a: 1 / (k ** 1.15), p: rand() * Math.PI * 2 };
  });
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (const w of waves) v += w.a * Math.sin((2 * Math.PI * (w.kx * x + w.ky * y)) / size + w.p);
      h[y * size + x] = v;
    }
  }
  const data = new Uint8Array(size * size * 4);
  const s = 2.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hx = h[y * size + ((x + 1) % size)] - h[y * size + ((x - 1 + size) % size)];
      const hy = h[((y + 1) % size) * size + x] - h[((y - 1 + size) % size) * size + x];
      const n = new THREE.Vector3(-hx * s, -hy * s, 1).normalize();
      const i = (y * size + x) * 4;
      data[i] = (n.x * 0.5 + 0.5) * 255;
      data[i + 1] = (n.y * 0.5 + 0.5) * 255;
      data[i + 2] = (n.z * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** 육지 표면 텍스처(산업단지·녹지가 섞인 회녹색) */
function landTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#7d8278';
  g.fillRect(0, 0, 512, 512);
  const rand = rng(11);
  for (let i = 0; i < 2600; i++) {
    const x = rand() * 512;
    const y = rand() * 512;
    const r = 3 + rand() * 22;
    const tone = rand();
    g.fillStyle = tone < 0.35 ? `rgba(88,104,80,${0.25 + rand() * 0.3})` : tone < 0.7 ? `rgba(150,150,145,${0.2 + rand() * 0.25})` : `rgba(105,100,92,${0.2 + rand() * 0.25})`;
    if (rand() < 0.5) g.fillRect(x, y, r * 2, r);
    else {
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.strokeStyle = 'rgba(60,60,58,0.35)';
  g.lineWidth = 2;
  for (let i = 0; i < 14; i++) {
    g.beginPath();
    const v = rand() * 512;
    if (i % 2) {
      g.moveTo(0, v);
      g.lineTo(512, v + (rand() - 0.5) * 30);
    } else {
      g.moveTo(v, 0);
      g.lineTo(v + (rand() - 0.5) * 30, 512);
    }
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** 해안선 래스터(25 m 격자): 육지 여부·해안까지 거리. 탱크·건물 배치와 미니맵에 쓴다 */
export class LandMask {
  constructor(coast, cell = 25) {
    const [x0, y0, x1, y1] = coast.rect;
    this.x0 = x0;
    this.y0 = y0;
    this.cell = cell;
    this.w = Math.ceil((x1 - x0) / cell);
    this.h = Math.ceil((y1 - y0) / cell);
    const c = document.createElement('canvas');
    c.width = this.w;
    c.height = this.h;
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, this.w, this.h);
    g.fillStyle = '#fff';
    for (const ring of coast.land) {
      g.beginPath();
      ring.forEach(([x, y], i) => {
        const px = (x - x0) / cell;
        const py = (y1 - y) / cell;
        if (i) g.lineTo(px, py);
        else g.moveTo(px, py);
      });
      g.closePath();
      g.fill();
    }
    const img = g.getImageData(0, 0, this.w, this.h).data;
    this.land = new Uint8Array(this.w * this.h);
    for (let i = 0; i < this.land.length; i++) this.land[i] = img[i * 4] > 127 ? 1 : 0;
    this.y1 = y1;
    // 해안까지 거리(셀, 체스판 거리 근사)
    const INF = 1e9;
    const d = new Float32Array(this.w * this.h).fill(INF);
    for (let i = 0; i < d.length; i++) if (!this.land[i]) d[i] = 0;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = y * this.w + x;
        if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 1);
        if (y > 0) d[i] = Math.min(d[i], d[i - this.w] + 1);
        if (x > 0 && y > 0) d[i] = Math.min(d[i], d[i - this.w - 1] + 1.414);
        if (x < this.w - 1 && y > 0) d[i] = Math.min(d[i], d[i - this.w + 1] + 1.414);
      }
    }
    for (let y = this.h - 1; y >= 0; y--) {
      for (let x = this.w - 1; x >= 0; x--) {
        const i = y * this.w + x;
        if (x < this.w - 1) d[i] = Math.min(d[i], d[i + 1] + 1);
        if (y < this.h - 1) d[i] = Math.min(d[i], d[i + this.w] + 1);
        if (x < this.w - 1 && y < this.h - 1) d[i] = Math.min(d[i], d[i + this.w + 1] + 1.414);
        if (x > 0 && y < this.h - 1) d[i] = Math.min(d[i], d[i + this.w - 1] + 1.414);
      }
    }
    this.dist = d;
    this.canvas = c;
  }

  #idx(x, y) {
    const cx = Math.floor((x - this.x0) / this.cell);
    const cy = Math.floor((this.y1 - y) / this.cell);
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return -1;
    return cy * this.w + cx;
  }

  isLand(x, y) {
    const i = this.#idx(x, y);
    return i >= 0 && this.land[i] === 1;
  }

  /** 해안까지 거리(m). 바다면 0 */
  inland(x, y) {
    const i = this.#idx(x, y);
    return i < 0 ? 0 : this.dist[i] * this.cell;
  }
}

export class World {
  constructor({ renderer, scene, camera, coast, sim }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.sim = sim;
    this.mask = new LandMask(coast);
    this.coast = coast;
    this.envDirty = true;
    this.lastSunKey = '';
    this.blinkers = [];
    this.nightLights = [];
    this.flares = [];
    this.daylight = 1;

    this.#lights();
    this.#sky();
    this.#water();
    this.#land();
    this.#hills();
    this.#refinery();
    this.#city();
    this.#terminals();
    this.#buoys();
    this.#navAids();
    this.#overlay();
    this.#stars();
  }

  #lights() {
    this.hemi = new THREE.HemisphereLight(0xcfe3ff, 0x4a4f45, 0.9);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -700;
    sc.right = 700;
    sc.top = 700;
    sc.bottom = -700;
    sc.near = 100;
    sc.far = 9000;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target);
  }

  #sky() {
    this.sky = new Sky();
    this.sky.scale.setScalar(150000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 7;
    u.rayleigh.value = 1.6;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.82;
    this.scene.add(this.sky);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envScene = new THREE.Scene();
    this.envSky = new Sky();
    this.envSky.scale.setScalar(1000);
    Object.assign(this.envSky.material.uniforms.turbidity, { value: 7 });
    this.envScene.add(this.envSky);
    this.scene.fog = new THREE.FogExp2(0xbfd0dc, 0.000045);
  }

  #water() {
    const geo = new THREE.PlaneGeometry(120000, 120000);
    this.water = new Water(geo, {
      textureWidth: 1024,
      textureHeight: 1024,
      waterNormals: waterNormalTexture(),
      sunDirection: new THREE.Vector3(0, 1, 0),
      sunColor: 0xffffff,
      waterColor: 0x0d3442,
      distortionScale: 2.2,
      fog: true,
      alpha: 1,
    });
    this.water.rotation.x = -Math.PI / 2;
    this.water.material.uniforms.size.value = 3.2;
    this.scene.add(this.water);
  }

  #land() {
    const [X0, Y0, X1, Y1] = this.coast.rect;
    const FAR = 40000;
    const top = landTexture();
    top.repeat.set(1 / 420, 1 / 420);
    const topMat = new THREE.MeshStandardMaterial({ map: top, roughness: 0.95, metalness: 0 });
    const sideMat = new THREE.MeshStandardMaterial({ color: 0x8c8a84, roughness: 0.9 });
    const geoms = [];
    for (const ring of this.coast.land) {
      // 영역 경계에 걸친 육지는 바깥으로 넓혀 수평선까지 이어지게 한다
      const pts = ring.map(([x, y]) => {
        let px = x;
        let py = y;
        if (Math.abs(x - X0) < 0.3) px = X0 - FAR;
        if (Math.abs(x - X1) < 0.3) px = X1 + FAR;
        if (Math.abs(y - Y0) < 0.3) py = Y0 - FAR;
        if (Math.abs(y - Y1) < 0.3) py = Y1 + FAR;
        return new THREE.Vector2(px, py);
      });
      const shape = new THREE.Shape(pts);
      const g = new THREE.ExtrudeGeometry(shape, { depth: 4, bevelEnabled: false, curveSegments: 1 });
      g.rotateX(-Math.PI / 2);
      geoms.push(g);
    }
    const merged = mergeGeometries(geoms, true);
    // 그룹(윗면/옆면)별 재질: ExtrudeGeometry 그룹 0=면, 1=옆
    merged.clearGroups();
    let start = 0;
    for (const g of geoms) {
      for (const grp of g.groups) merged.addGroup(start + grp.start, grp.count, grp.materialIndex);
      start += g.index ? g.index.count : g.attributes.position.count;
    }
    this.land = new THREE.Mesh(merged, [topMat, sideMat]);
    this.land.receiveShadow = true;
    this.scene.add(this.land);
  }

  #hills() {
    const rand = rng(23);
    const mat = new THREE.MeshStandardMaterial({ color: 0x55634c, roughness: 1, flatShading: true });
    const spots = [
      [-14000, 12000, 6000, 520], [-5000, 15000, 5000, 380], [3500, 16000, 4500, 300], [-17000, 2000, 6500, 610],
      [-15500, -9000, 5500, 470], [-9000, -15000, 5000, 330], [9000, 14000, 4000, 260], [-24000, 16000, 9000, 820],
    ];
    const geoms = [];
    for (const [x, y, r, h] of spots) {
      const g = new THREE.SphereGeometry(1, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2);
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const k = 0.75 + rand() * 0.5;
        pos.setXYZ(i, pos.getX(i) * r * (0.9 + rand() * 0.2), pos.getY(i) * h * k, pos.getZ(i) * r * (0.9 + rand() * 0.2));
      }
      g.computeVertexNormals();
      g.translate(x, 2, -y);
      geoms.push(g);
    }
    const mesh = new THREE.Mesh(mergeGeometries(geoms), mat);
    this.scene.add(mesh);
  }

  /** SK 울산CLX를 떠올리게 하는 탱크단지·공정구역·플레어 스택(가상 배치) */
  #refinery() {
    const rand = rng(31);
    const tanks = [];
    const spheres = [];
    const columns = [];
    const blocks = [];
    const noise = (x, y) => Math.sin(x * 0.0021 + 1.3) * Math.cos(y * 0.0017 - 0.4) + 0.5 * Math.sin((x + y) * 0.0043);
    const ok = (x, y, r) => this.mask.isLand(x, y) && this.mask.inland(x, y) > r + 90;
    for (let y = -1400; y < 3200; y += 105) {
      for (let x = -6000; x < -1450; x += 105) {
        const px = x + (rand() - 0.5) * 30;
        const py = y + (rand() - 0.5) * 30;
        const n = noise(px, py);
        if (n > 0.05) {
          const big = n > 0.75;
          const r = big ? 34 + rand() * 10 : 14 + rand() * 12;
          if (!ok(px, py, r)) continue;
          tanks.push({ x: px, y: py, r, h: big ? 20 + rand() * 4 : 12 + rand() * 6 });
        } else if (n < -0.55 && ok(px, py, 40)) {
          blocks.push({ x: px, y: py, w: 40 + rand() * 50, d: 30 + rand() * 40, h: 8 + rand() * 18 });
          if (rand() < 0.6) columns.push({ x: px + (rand() - 0.5) * 30, y: py + (rand() - 0.5) * 30, r: 2 + rand() * 2.5, h: 35 + rand() * 45 });
        }
      }
    }
    // SK가스 LPG 구형 저장탱크(SK1·2부두 배후)
    for (let i = 0; i < 9; i++) {
      const px = -3560 + (i % 3) * 48 + (rand() - 0.5) * 6;
      const py = 3280 + Math.floor(i / 3) * 48;
      if (this.mask.isLand(px, py)) spheres.push({ x: px, y: py, r: 15 });
    }
    const shellGeo = new THREE.CylinderGeometry(1, 1, 1, 28, 1, true);
    shellGeo.translate(0, 0.5, 0);
    const roofGeo = new THREE.CylinderGeometry(1, 1, 0.04, 28);
    const shell = new THREE.InstancedMesh(shellGeo, new THREE.MeshStandardMaterial({ color: 0xe9ebe8, roughness: 0.55, metalness: 0.2 }), tanks.length);
    const roof = new THREE.InstancedMesh(roofGeo, new THREE.MeshStandardMaterial({ color: 0xa7aca8, roughness: 0.7, metalness: 0.3 }), tanks.length);
    const mtx = new THREE.Matrix4();
    tanks.forEach((t, i) => {
      mtx.compose(toWorld(t.x, t.y, 4), new THREE.Quaternion(), new THREE.Vector3(t.r, t.h, t.r));
      shell.setMatrixAt(i, mtx);
      mtx.compose(toWorld(t.x, t.y, 4 + t.h - 0.6), new THREE.Quaternion(), new THREE.Vector3(t.r * 0.98, 1, t.r * 0.98));
      roof.setMatrixAt(i, mtx);
    });
    shell.castShadow = roof.receiveShadow = true;
    this.scene.add(shell, roof);

    const sphGeo = new THREE.SphereGeometry(1, 24, 16);
    const sph = new THREE.InstancedMesh(sphGeo, new THREE.MeshStandardMaterial({ color: 0xf1f1ec, roughness: 0.4, metalness: 0.3 }), spheres.length);
    spheres.forEach((s, i) => {
      mtx.compose(toWorld(s.x, s.y, 4 + s.r + 4), new THREE.Quaternion(), new THREE.Vector3(s.r, s.r, s.r));
      sph.setMatrixAt(i, mtx);
    });
    sph.castShadow = true;
    this.scene.add(sph);

    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    boxGeo.translate(0, 0.5, 0);
    const blk = new THREE.InstancedMesh(boxGeo, new THREE.MeshStandardMaterial({ color: 0x9a9d98, roughness: 0.8, metalness: 0.25 }), blocks.length);
    blocks.forEach((b, i) => {
      mtx.compose(toWorld(b.x, b.y, 4), new THREE.Quaternion(), new THREE.Vector3(b.w, b.h, b.d));
      blk.setMatrixAt(i, mtx);
    });
    blk.castShadow = true;
    this.scene.add(blk);
    const colGeo = new THREE.CylinderGeometry(1, 1, 1, 12);
    colGeo.translate(0, 0.5, 0);
    const col = new THREE.InstancedMesh(colGeo, new THREE.MeshStandardMaterial({ color: 0xc9ccc6, roughness: 0.5, metalness: 0.5 }), columns.length);
    columns.forEach((c, i) => {
      mtx.compose(toWorld(c.x, c.y, 4), new THREE.Quaternion(), new THREE.Vector3(c.r, c.h, c.r));
      col.setMatrixAt(i, mtx);
    });
    col.castShadow = true;
    this.scene.add(col);

    // 플레어 스택(적백 도장) + 불꽃
    const stackSpots = [[-3300, 900], [-4200, 1900], [-2400, 200], [-5200, -300]].filter(([x, y]) => this.mask.isLand(x, y));
    for (const [x, y] of stackSpots) {
      const h = 110;
      const g = [];
      for (let k = 0; k < 7; k++) {
        const seg = new THREE.CylinderGeometry(2.2, 2.6, h / 7, 12);
        seg.translate(0, h / 14 + (k * h) / 7, 0);
        const c = new THREE.Color(k % 2 ? 0xffffff : 0xc8321e);
        const arr = new Float32Array(seg.attributes.position.count * 3);
        for (let i = 0; i < arr.length; i += 3) c.toArray(arr, i);
        seg.setAttribute('color', new THREE.BufferAttribute(arr, 3));
        g.push(seg);
      }
      const mesh = new THREE.Mesh(mergeGeometries(g), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }));
      mesh.position.copy(toWorld(x, y, 4));
      mesh.castShadow = true;
      this.scene.add(mesh);
      const flame = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('#ffb347'), color: 0xffa040, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      flame.position.copy(toWorld(x, y, 4 + h + 8));
      flame.scale.set(26, 34, 1);
      this.scene.add(flame);
      this.flares.push(flame);
    }

    // 야간 조명(공장·부두)
    const lightPts = [];
    for (const t of tanks) if (rand() < 0.5) lightPts.push(t.x + t.r, t.y, 4 + t.h + 1);
    for (const b of blocks) for (let k = 0; k < 6; k++) lightPts.push(b.x + (rand() - 0.5) * b.w, b.y + (rand() - 0.5) * b.d, 4 + rand() * b.h);
    for (const c of columns) for (let k = 0; k < 4; k++) lightPts.push(c.x, c.y, 4 + (c.h * (k + 1)) / 5);
    this.#addNightLights(lightPts, 0xffc47a, 3.4);
  }

  /** 도시·기타 산업 지역: 저층 건물 군집 */
  #city() {
    const rand = rng(41);
    const items = [];
    const [X0, Y0, X1, Y1] = this.coast.rect;
    for (let i = 0; i < 9000 && items.length < 2600; i++) {
      const x = X0 + rand() * (X1 - X0);
      const y = Y0 + rand() * (Y1 - Y0);
      if (x < -1450 && x > -6000 && y > -1400 && y < 3200) continue; // 정유단지
      if (!this.mask.isLand(x, y) || this.mask.inland(x, y) < 60) continue;
      const tall = rand() < 0.08;
      items.push({ x, y, w: 14 + rand() * 30, d: 12 + rand() * 30, h: tall ? 30 + rand() * 50 : 6 + rand() * 14, rot: rand() * Math.PI, c: rand() });
    }
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.85 }), items.length);
    const mtx = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();
    const palette = [0xb9b6ad, 0xd8d5cc, 0x9aa3a8, 0x7f8f9c, 0xc4b59d, 0x8d9a86];
    const lights = [];
    items.forEach((b, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.rot);
      mtx.compose(toWorld(b.x, b.y, 4), q, new THREE.Vector3(b.w, b.h, b.d));
      mesh.setMatrixAt(i, mtx);
      mesh.setColorAt(i, col.set(palette[Math.floor(b.c * palette.length)]));
      if (b.c < 0.5) lights.push(b.x, b.y, 4 + b.h * 0.6);
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.#addNightLights(lights, 0xffe2b0, 2.6);
  }

  #addNightLights(flat, color, size) {
    const pos = [];
    for (let i = 0; i < flat.length; i += 3) pos.push(flat[i], flat[i + 2], -flat[i + 1]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ color, size, map: glowTexture('#ffffff'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, sizeAttenuation: false });
    const p = new THREE.Points(g, m);
    this.scene.add(p);
    this.nightLights.push(p);
  }

  /** 부두 시설: 해상 돌핀부두(SK6~8) 플랫폼·돌핀·잔교, 안벽 부두(SK1~5) 펜더·계선주, 선석별 로딩암 */
  #terminals() {
    const concrete = '#a9a79f';
    const parts = [];
    const add = (g, color) => parts.push(colorize(g, color));
    this.arms = [];
    const berthLights = [];
    for (const f of this.sim.facilities) {
      if (f.kind === 'buoy') continue;
      for (const slot of f.slots) {
        const h = { x: Math.sin(slot.heading), y: Math.cos(slot.heading) };
        const n = slot.normal;
        const at = (along, off) => ({ x: slot.quay.x + h.x * along + n.x * off, y: slot.quay.y + h.y * along + n.y * off });
        const yaw = -slot.heading;
        const boxAt = (p, w, hgt, d, color, base = 0) => {
          const g = new THREE.BoxGeometry(w, hgt, d);
          g.rotateY(yaw);
          g.translate(p.x, base + hgt / 2, -p.y);
          add(g, color);
        };
        const span = slot.maxLoa;
        if (f.kind === 'jetty') {
          // 하역 플랫폼
          boxAt(at(0, -14), 26, 3, 46, concrete, 5);
          for (const a of [-0.3, 0.3]) boxAt(at(a * span, -4), 10, 7, 10, concrete, 0);
          for (const a of [-0.62, 0.62]) boxAt(at(a * span, -10), 9, 6, 9, concrete, 0);
          // 돌핀 연결 보도
          for (const a of [-0.62, -0.3, 0.3, 0.62]) {
            const p0 = at(Math.sign(a) * 23, -12);
            const p1 = at(a * span, -6);
            const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
            const g = new THREE.BoxGeometry(1.6, 1.2, len);
            g.rotateY(-Math.atan2(p1.x - p0.x, p1.y - p0.y));
            g.translate((p0.x + p1.x) / 2, 7.5, -(p0.y + p1.y) / 2);
            add(g, '#7c7f80');
          }
          // 펜더 패널
          for (const a of [-0.3, 0.3]) boxAt(at(a * span, 1.2), 4, 4, 2, '#18191a', 1.5);
          // 잔교: 플랫폼에서 해안까지
          const start = at(0, -27);
          let end = start;
          for (let d = 0; d < 1200; d += 10) {
            end = { x: start.x - n.x * d, y: start.y - n.y * d };
            if (this.mask.isLand(end.x, end.y)) break;
          }
          const len = Math.hypot(end.x - start.x, end.y - start.y) + 20;
          const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
          const g = new THREE.BoxGeometry(len, 1.2, 9);
          g.rotateY(yaw);
          g.translate(mid.x, 6, -mid.y);
          add(g, concrete);
          const pipe = new THREE.CylinderGeometry(0.6, 0.6, len, 8);
          pipe.rotateZ(Math.PI / 2);
          pipe.rotateY(yaw);
          pipe.translate(mid.x, 7.3, -mid.y);
          add(pipe, '#c8c9c4');
          for (let k = -len / 2; k < len / 2; k += 30) {
            const pile = new THREE.CylinderGeometry(0.7, 0.7, 8, 8);
            pile.translate(mid.x + n.x * k, 2, -(mid.y + n.y * k));
            add(pile, '#6c6c68');
          }
        } else {
          // 안벽: 펜더·계선주
          for (let a = -span / 2; a <= span / 2; a += 18) boxAt(at(a, 0.6), 2.5, 3, 1.2, '#18191a', 1.2);
          for (let a = -span / 2 - 10; a <= span / 2 + 10; a += 26) {
            const p = at(a, -3);
            const g = new THREE.CylinderGeometry(0.5, 0.6, 1, 8);
            g.translate(p.x, 4.5, -p.y);
            add(g, '#2b2b2b');
          }
        }
        // 부두 조명등(야간)
        for (let a = -0.5; a <= 0.5; a += 0.25) {
          const p = at(a * span, f.kind === 'jetty' ? -12 : -8);
          berthLights.push(p.x, p.y, f.kind === 'jetty' ? 22 : 18);
        }
        // 로딩암 2기
        for (const k of [-1, 1]) {
          const base = at(k * 8, -6);
          const baseY = f.kind === 'jetty' ? 8 : 4;
          this.arms.push(new LoadingArm(this.scene, base, baseY, slot, k));
        }
      }
    }
    this.#addNightLights(berthLights, 0xfff0d0, 4.5);
    const mesh = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  /** SPM(부이 계류 설비): 노란 부체 + 회전 턴테이블 */
  #buoys() {
    this.spm = new Map();
    for (const f of this.sim.facilities) {
      if (f.kind !== 'buoy') continue;
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(6, 6.5, 4.5, 24), new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.6 }));
      body.position.y = 0.6;
      const skirt = new THREE.Mesh(new THREE.CylinderGeometry(7.2, 7.2, 1, 24), new THREE.MeshStandardMaterial({ color: 0x1d1d1d, roughness: 0.8 }));
      skirt.position.y = 0.4;
      const turret = new THREE.Mesh(new THREE.CylinderGeometry(3, 3.4, 2.4, 16), new THREE.MeshStandardMaterial({ color: 0xc8321e, roughness: 0.6 }));
      turret.position.y = 4;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 9), new THREE.MeshStandardMaterial({ color: 0xc8321e }));
      arm.position.set(0, 4.5, 4);
      const head = new THREE.Group();
      head.add(turret, arm);
      g.add(body, skirt, head);
      g.position.copy(toWorld(f.buoy.x, f.buoy.y));
      this.scene.add(g);
      this.spm.set(f.id, { group: g, head });
      this.#blinker(toWorld(f.buoy.x, f.buoy.y, 6.5), 0xffd040, 4, 0);
    }
  }

  /** 제1항로 측면표지(IALA B: 입항 기준 우측 홍색, 좌측 녹색)와 묘박지 부표 */
  #navAids() {
    const ids = ['CH0', 'CH1', 'CH2', 'CH3', 'CH4'];
    const pts = ids.map((id) => NODES[id]);
    const red = new THREE.MeshStandardMaterial({ color: 0xc8261e, roughness: 0.6 });
    const green = new THREE.MeshStandardMaterial({ color: 0x1f7a3a, roughness: 0.6 });
    const nun = new THREE.ConeGeometry(1.4, 3.2, 12);
    nun.translate(0, 3.4, 0);
    const can = new THREE.CylinderGeometry(1.2, 1.2, 3, 12);
    can.translate(0, 3.2, 0);
    const float = new THREE.CylinderGeometry(1.6, 1.8, 1.8, 12);
    float.translate(0, 0.6, 0);
    let k = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      for (let s = 200; s < len; s += 650) {
        for (const side of [1, -1]) {
          const x = a.x + ux * s + uy * 175 * side;
          const y = a.y + uy * s - ux * 175 * side;
          const g = new THREE.Group();
          const mat = side === 1 ? red : green;
          g.add(new THREE.Mesh(float, mat), new THREE.Mesh(side === 1 ? nun : can, mat));
          g.position.copy(toWorld(x, y));
          this.scene.add(g);
          this.#blinker(toWorld(x, y, 6), side === 1 ? 0xff3b30 : 0x34ff6a, 4, (k++ % 5) * 0.37);
        }
      }
    }
  }

  #blinker(pos, color, periodS, phase) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('#ffffff'), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, sizeAttenuation: false }));
    s.position.copy(pos);
    s.scale.set(0.012, 0.012, 1);
    this.scene.add(s);
    this.blinkers.push({ s, periodS, phase });
  }

  /** 해도 오버레이: 통항 분리 차선·묘박 위치·도선 구역 */
  #overlay() {
    const g = new THREE.Group();
    const lineMat = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 60, gapSize: 50, transparent: true, opacity: 0.55, depthWrite: false });
    const chain = ['PILOT', 'CH0', 'CH1', 'CH2', 'CH3', 'CH4', 'IN1', 'IN2', 'IN3', 'IN4', 'TB12'].map((id) => toWorld(NODES[id].x, NODES[id].y, 0.6));
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(chain), lineMat);
    line.computeLineDistances();
    g.add(line);
    const ringMat = new THREE.LineBasicMaterial({ color: 0xffd25a, transparent: true, opacity: 0.6, depthWrite: false });
    for (const a of ANCHORAGES) {
      for (const p of a.spots) {
        const pts = [];
        for (let i = 0; i <= 48; i++) {
          const t = (i / 48) * Math.PI * 2;
          pts.push(toWorld(p.x + Math.cos(t) * 260, p.y + Math.sin(t) * 260, 0.6));
        }
        g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), ringMat));
      }
    }
    const pilot = [];
    for (let i = 0; i <= 64; i++) {
      const t = (i / 64) * Math.PI * 2;
      pilot.push(toWorld(NODES.PILOT.x + Math.cos(t) * 600, NODES.PILOT.y + Math.sin(t) * 600, 0.6));
    }
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pilot), new THREE.LineBasicMaterial({ color: 0x7fd3ff, transparent: true, opacity: 0.7 })));
    g.visible = false;
    this.overlay = g;
    this.scene.add(g);
  }

  #stars() {
    const rand = rng(5);
    const pos = [];
    for (let i = 0; i < 1500; i++) {
      const az = rand() * Math.PI * 2;
      const el = Math.asin(rand() * 0.98 + 0.02);
      const r = 90000;
      pos.push(Math.cos(el) * Math.sin(az) * r, Math.sin(el) * r, -Math.cos(el) * Math.cos(az) * r);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
    this.scene.add(this.stars);
  }

  /** 시계(UTC ms)·카메라 목표에 맞춰 태양·하늘·조명·안개·야간 조명을 갱신 */
  update(utcMs, simT, target) {
    const { alt, az } = sunPosition(utcMs);
    const dir = new THREE.Vector3(Math.cos(alt) * Math.sin(az), Math.sin(alt), -Math.cos(alt) * Math.cos(az));
    const day = smooth(-0.1, 0.12, alt);
    this.daylight = day;
    this.sunAlt = alt;
    this.sky.material.uniforms.sunPosition.value.copy(dir);
    this.water.material.uniforms.sunDirection.value.copy(dir.clone().setY(Math.max(dir.y, 0.02)).normalize());
    this.water.material.uniforms.time.value = simT / 1.6;
    const low = 1 - smooth(0.02, 0.35, alt);
    const sunColor = new THREE.Color().setRGB(1, 1 - 0.35 * low, 1 - 0.6 * low);
    this.sun.color.copy(sunColor);
    this.sun.intensity = 3.2 * smooth(-0.02, 0.15, alt);
    this.sun.castShadow = alt > 0.03;
    this.sun.position.copy(target).addScaledVector(dir, 4000);
    this.sun.target.position.copy(target);
    this.water.material.uniforms.sunColor.value.copy(sunColor).multiplyScalar(smooth(-0.02, 0.1, alt));
    this.hemi.intensity = 0.32 + 0.8 * day;
    this.hemi.color.setRGB(0.45 + 0.37 * day, 0.55 + 0.34 * day, 0.85 + 0.15 * day);
    const fog = new THREE.Color().setRGB(0.04 + 0.7 * day, 0.06 + 0.74 * day, 0.1 + 0.76 * day);
    if (low > 0.2 && day > 0.2) fog.lerp(new THREE.Color(0.95, 0.78, 0.62), 0.35 * low);
    this.scene.fog.color.copy(fog);
    this.water.material.uniforms.waterColor.value.setRGB(0.008 + 0.042 * day, 0.03 + 0.17 * day, 0.045 + 0.225 * day);
    this.renderer.toneMappingExposure = 1.25 - 0.75 * day;
    this.stars.material.opacity = (1 - smooth(-0.2, -0.04, alt)) * 0.9;
    const night = 1 - smooth(-0.06, 0.06, alt);
    for (const p of this.nightLights) p.material.opacity = night * 0.95;
    for (const b of this.blinkers) {
      const ph = ((simT / b.periodS + b.phase) % 1 + 1) % 1;
      b.s.material.opacity = (ph < 0.18 ? 1 : 0) * (0.25 + 0.75 * night);
    }
    for (const f of this.flares) {
      const flick = 0.85 + 0.15 * Math.sin(simT * 7.3 + f.id) * Math.sin(simT * 3.1);
      f.scale.set(24 * flick, 34 * flick, 1);
      f.material.opacity = 0.75 + 0.25 * night;
    }
    // 환경맵(반사)은 태양이 0.5° 이상 움직였을 때만 다시 굽는다
    const key = `${Math.round(alt / (0.5 * D2R))}:${Math.round(az / (2 * D2R))}`;
    if (key !== this.lastSunKey) {
      this.lastSunKey = key;
      this.envSky.material.uniforms.sunPosition.value.copy(dir);
      if (this.envRT) this.envRT.dispose();
      this.envRT = this.pmrem.fromScene(this.envScene, 0, 1, 2000);
      this.scene.environment = this.envRT.texture;
      this.scene.environmentIntensity = 0.25 + 0.75 * day;
    }
  }

  setOverlay(on) {
    this.overlay.visible = on;
  }
}

/** 마린 로딩암: 라이저 + 내측 암 + 외측 암. 하역 중이면 선박 매니폴드로 뻗고, 아니면 접어 둔다 */
class LoadingArm {
  constructor(scene, base, baseY, slot, k) {
    this.slot = slot;
    this.k = k;
    this.base = toWorld(base.x, base.y, baseY);
    const mat = new THREE.MeshStandardMaterial({ color: 0xd9d9d2, roughness: 0.5, metalness: 0.4 });
    const pipe = new THREE.MeshStandardMaterial({ color: 0x6c7072, roughness: 0.6, metalness: 0.5 });
    this.riserH = 13;
    this.a1 = 11;
    this.a2 = 13;
    this.riser = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, this.riserH, 10), mat);
    this.riser.position.copy(this.base).add(new THREE.Vector3(0, this.riserH / 2, 0));
    this.inner = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 1, 8), pipe);
    this.outer = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1, 8), pipe);
    this.cw = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 1.6), new THREE.MeshStandardMaterial({ color: 0x2b2b2b }));
    for (const m of [this.riser, this.inner, this.outer, this.cw]) {
      m.castShadow = true;
      scene.add(m);
    }
    this.extend = 0;
    this.target = null;
  }

  /** target: 연결할 매니폴드 월드 좌표(없으면 접는다). dt: 실제 경과 시간 */
  update(target, dt) {
    const top = this.base.clone().add(new THREE.Vector3(0, this.riserH, 0));
    const want = target ? 1 : 0;
    this.extend += Math.sign(want - this.extend) * Math.min(Math.abs(want - this.extend), dt * 0.25);
    if (target) this.target = target.clone();
    const stow = top.clone().add(new THREE.Vector3(0, -this.riserH * 0.85, 0)).add(new THREE.Vector3(Math.sin(-this.slot.heading) * 2, 0, 0));
    const goal = this.target ? stow.clone().lerp(this.target, this.extend) : stow;
    // 2절 링크 역기구학: 위쪽으로 꺾이는 팔꿈치
    const d = goal.clone().sub(top);
    const len = Math.min(d.length(), this.a1 + this.a2 - 0.01);
    const dirN = d.clone().normalize();
    const a = (this.a1 * this.a1 - this.a2 * this.a2 + len * len) / (2 * len);
    const hgt = Math.sqrt(Math.max(0, this.a1 * this.a1 - a * a));
    const side = new THREE.Vector3(0, 1, 0).sub(dirN.clone().multiplyScalar(dirN.y)).normalize();
    const elbow = top.clone().addScaledVector(dirN, a).addScaledVector(side, hgt);
    const end = top.clone().addScaledVector(dirN, len);
    setRod(this.inner, top, elbow);
    setRod(this.outer, elbow, end);
    this.cw.position.copy(top).addScaledVector(elbow.clone().sub(top).normalize(), -2.5);
  }
}

function setRod(mesh, a, b) {
  const d = b.clone().sub(a);
  const len = d.length();
  mesh.position.copy(a).addScaledVector(d, 0.5);
  mesh.scale.set(1, Math.max(0.01, len), 1);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
}

function colorize(g, color) {
  const geo = g.index ? g.toNonIndexed() : g;
  for (const key of Object.keys(geo.attributes)) if (key !== 'position' && key !== 'normal') geo.deleteAttribute(key);
  const c = new THREE.Color(color);
  const arr = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i < arr.length; i += 3) c.toArray(arr, i);
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

const glowCache = new Map();
/** 방사형 발광 스프라이트 텍스처 */
export function glowTexture(color = '#ffffff') {
  if (glowCache.has(color)) return glowCache.get(color);
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, color);
  grad.addColorStop(0.18, color);
  grad.addColorStop(0.45, 'rgba(255,255,255,0.25)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  glowCache.set(color, tex);
  return tex;
}
