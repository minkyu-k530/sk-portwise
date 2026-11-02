// 항적 거품(선미 난류·켈빈파·예선 추진류)과 계류줄·예인줄 같은 동적 선 묶음.
import * as THREE from 'three';

const WAKE_VERT = /* glsl */ `
  attribute float aAlpha;
  attribute float aSide;
  varying float vAlpha;
  varying float vSide;
  varying vec3 vWorld;
  varying float vFogDepth;
  void main() {
    vAlpha = aAlpha;
    vSide = aSide;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mv = viewMatrix * wp;
    vFogDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const WAKE_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  uniform vec3 fogColor;
  uniform float fogDensity;
  varying float vAlpha;
  varying float vSide;
  varying vec3 vWorld;
  varying float vFogDepth;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  void main() {
    vec2 p = vWorld.xz * 0.18;
    float n = noise(p + uTime * 0.05) * 0.6 + noise(p * 2.7 - uTime * 0.08) * 0.4;
    float edge = 1.0 - smoothstep(0.55, 1.0, abs(vSide));
    float a = vAlpha * edge * smoothstep(0.25, 0.75, n + vAlpha * 0.35);
    if (a < 0.01) discard;
    float fog = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    gl_FragColor = vec4(mix(uColor, fogColor, fog), a * (1.0 - fog));
  }
`;

/** 점 목록으로 이뤄진 리본들. 각 점은 생성 위치·횡방향·폭 증가율·표류 속도·수명을 가진다(시뮬레이션 시간 기준). */
export class WakeSystem {
  constructor(scene, maxQuads = 24000) {
    this.trails = new Map();
    this.maxQuads = maxQuads;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(maxQuads * 4 * 3);
    this.alpha = new Float32Array(maxQuads * 4);
    this.side = new Float32Array(maxQuads * 4);
    const index = new Uint32Array(maxQuads * 6);
    for (let i = 0; i < maxQuads; i++) {
      const v = i * 4;
      index.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], i * 6);
    }
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSide', new THREE.BufferAttribute(this.side, 1).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      vertexShader: WAKE_VERT,
      fragmentShader: WAKE_FRAG,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(0xf4f8f8) },
        fogColor: { value: new THREE.Color() },
        fogDensity: { value: 0 },
      },
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
    this.geometry = g;
  }

  /**
   * key 리본에 점 추가. p: {x, y(북), nx, ny(횡방향 단위벡터), w(초기 폭), dw(폭 증가 m/s), vx, vy(표류 m/s), a(불투명도), life(s)}
   * 간격(spacing m) 또는 시간(minDt s)이 지났을 때만 추가한다.
   */
  emit(key, t, p, spacing, minDt = 2) {
    let tr = this.trails.get(key);
    if (!tr) {
      tr = { pts: [] };
      this.trails.set(key, tr);
    }
    const last = tr.pts.at(-1);
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < spacing && t - last.t < minDt) return;
    tr.pts.push({ ...p, t });
    if (tr.pts.length > 160) tr.pts.shift();
  }

  /** 리본 끊기(정박·계류로 멈췄다 다시 출발할 때 이전 리본과 잇지 않게) */
  cut(key) {
    const tr = this.trails.get(key);
    if (tr?.pts.length) {
      this.trails.set(`${key}:${tr.pts.at(-1).t}`, tr);
      this.trails.set(key, { pts: [] });
    }
  }

  update(t, fog) {
    let q = 0;
    const P = this.pos;
    const A = this.alpha;
    const S = this.side;
    for (const [key, tr] of this.trails) {
      while (tr.pts.length && t - tr.pts[0].t > tr.pts[0].life) tr.pts.shift();
      if (!tr.pts.length) {
        if (key.includes(':')) this.trails.delete(key);
        continue;
      }
      for (let i = 0; i < tr.pts.length - 1 && q < this.maxQuads; i++) {
        const a = tr.pts[i];
        const b = tr.pts[i + 1];
        for (const [k, p] of [[0, a], [2, b]]) {
          const age = Math.max(0, t - p.t);
          const cx = p.x + p.vx * age;
          const cy = p.y + p.vy * age;
          const hw = (p.w + p.dw * age) / 2;
          const fade = Math.max(0, 1 - age / p.life) ** 1.4 * p.a;
          const v = q * 4 + k;
          P.set([cx - p.nx * hw, 0.25, -(cy - p.ny * hw)], v * 3);
          P.set([cx + p.nx * hw, 0.25, -(cy + p.ny * hw)], (v + 1) * 3);
          A[v] = A[v + 1] = fade;
          S[v] = -1;
          S[v + 1] = 1;
        }
        q++;
      }
    }
    this.geometry.setDrawRange(0, q * 6);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
    this.geometry.attributes.aSide.needsUpdate = true;
    this.material.uniforms.uTime.value = t;
    if (fog) {
      this.material.uniforms.fogColor.value.copy(fog.color);
      this.material.uniforms.fogDensity.value = fog.density;
    }
  }
}

/** 매 프레임 다시 채우는 선분 묶음(계류줄·예인줄·닻줄·부이 계류삭) */
export class LineSystem {
  constructor(scene, max = 4000) {
    this.max = max;
    this.pos = new Float32Array(max * 2 * 3);
    this.col = new Float32Array(max * 2 * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }));
    this.lines.frustumCulled = false;
    scene.add(this.lines);
    this.n = 0;
    this.color = new THREE.Color();
  }

  begin() {
    this.n = 0;
  }

  /** 늘어진 줄: a→b 를 sag(m) 만큼 처지게 여러 토막으로 */
  rope(a, b, color, sag = 0, segs = 8) {
    this.color.set(color);
    let prev = a;
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const p = new THREE.Vector3().lerpVectors(a, b, t);
      p.y -= sag * 4 * t * (1 - t);
      this.#seg(prev, p);
      prev = p;
    }
  }

  #seg(a, b) {
    if (this.n >= this.max) return;
    const i = this.n * 6;
    this.pos[i] = a.x;
    this.pos[i + 1] = a.y;
    this.pos[i + 2] = a.z;
    this.pos[i + 3] = b.x;
    this.pos[i + 4] = b.y;
    this.pos[i + 5] = b.z;
    this.color.toArray(this.col, i);
    this.color.toArray(this.col, i + 3);
    this.n++;
  }

  end() {
    const g = this.lines.geometry;
    g.setDrawRange(0, this.n * 2);
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
  }
}
