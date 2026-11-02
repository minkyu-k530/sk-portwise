// 진입점: 렌더러·카메라·시뮬레이션·세계·선단·UI 를 묶고 매 프레임 진행한다.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { KST_OFFSET_H, SCENARIO_START } from './data.js';
import { FleetView } from './fleet.js';
import { World, toWorld } from './scene.js';
import { Simulation } from './sim.js';
import { UI } from './ui.js';

const loading = document.getElementById('loading');
const setLoading = (t) => {
  loading.querySelector('p').textContent = t;
};

/** 시점: 자유 궤도 / 선박 따라가기 / 브리지(조타실) 1인칭 */
class CameraRig {
  constructor(camera, dom, fleet) {
    this.camera = camera;
    this.fleet = fleet;
    this.controls = new OrbitControls(camera, dom);
    Object.assign(this.controls, {
      enableDamping: true,
      dampingFactor: 0.08,
      maxPolarAngle: Math.PI / 2 - 0.03,
      minDistance: 25,
      maxDistance: 32000,
      screenSpacePanning: false,
      zoomToCursor: true,
    });
    this.mode = 'orbit';
    this.target = null;
    this.fly = null;
    this.look = { yaw: 0, pitch: -0.04 };
    let drag = null;
    dom.addEventListener('pointerdown', (e) => {
      if (this.mode === 'bridge') drag = { x: e.clientX, y: e.clientY, yaw: this.look.yaw, pitch: this.look.pitch };
    });
    window.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.look.yaw = drag.yaw - (e.clientX - drag.x) * 0.004;
      this.look.pitch = Math.max(-0.8, Math.min(0.5, drag.pitch - (e.clientY - drag.y) * 0.003));
    });
    window.addEventListener('pointerup', () => {
      drag = null;
    });
    dom.addEventListener('wheel', (e) => {
      if (this.mode !== 'bridge') return;
      this.camera.fov = Math.max(15, Math.min(75, this.camera.fov + e.deltaY * 0.02));
      this.camera.updateProjectionMatrix();
    }, { passive: true });
  }

  home() {
    this.release();
    this.flyTo(-700, 1200, new THREE.Vector3(1500, 1350, -(-1200)));
  }

  /** 지도 좌표(x 동, y 북)로 이동. camPos 를 주지 않으면 현재 시선 방향·거리를 유지 */
  flyTo(x, y, camPos) {
    if (this.mode === 'bridge') this.release();
    const target = toWorld(x, y, 0);
    const offset = camPos ? camPos.clone().sub(target) : this.camera.position.clone().sub(this.controls.target);
    if (!camPos && offset.length() > 4000) offset.setLength(4000);
    this.fly = {
      t: 0,
      fromT: this.controls.target.clone(),
      fromP: this.camera.position.clone(),
      toT: target,
      toP: camPos ?? target.clone().add(offset),
    };
  }

  flyToVessel(v) {
    const L = v.L ?? 32;
    const d = Math.max(220, L * 2.6);
    const back = new THREE.Vector3(Math.sin(v.psi + 2.4), 0, -Math.cos(v.psi + 2.4)).multiplyScalar(d);
    this.flyTo(v.x, v.y, toWorld(v.x, v.y, 0).add(back).setY(d * 0.45));
  }

  flyToFacility(f) {
    const p = f.kind === 'buoy' ? f.buoy : f.slots[0].quay;
    this.flyTo(p.x, p.y, toWorld(p.x + 700, p.y - 650, 520));
  }

  follow(v) {
    if (v.phase === 'away') return;
    this.release();
    this.mode = 'follow';
    this.target = v;
    this.prevPos = toWorld(v.x, v.y, 0);
    this.flyToVessel(v);
  }

  bridge(v) {
    if (v.phase === 'away') return;
    this.fly = null;
    this.mode = 'bridge';
    this.target = v;
    this.look = { yaw: 0, pitch: -0.04 };
    this.controls.enabled = false;
    this.camera.fov = 55;
    this.camera.near = 0.5;
    this.camera.updateProjectionMatrix();
  }

  release() {
    if (this.mode === 'bridge') {
      const v = this.target;
      this.camera.fov = 50;
      this.camera.near = 1.5;
      this.camera.updateProjectionMatrix();
      this.controls.enabled = true;
      const t = toWorld(v.x, v.y, 0);
      this.controls.target.copy(t);
      this.camera.position.copy(t).add(new THREE.Vector3(Math.sin(v.psi + 2.6) * v.L * 2.4, v.L * 1.1, -Math.cos(v.psi + 2.6) * v.L * 2.4));
    }
    this.mode = 'orbit';
    this.target = null;
  }

  update(dt) {
    const v = this.target;
    if (v && v.phase === 'away') this.release();
    if (this.mode === 'bridge' && this.target) {
      const tv = this.target;
      const view = this.fleet.view(tv);
      const pos = this.fleet.worldOf(tv, view.model.anchors.bridge);
      this.camera.position.copy(pos);
      const yaw = -tv.psi + this.look.yaw;
      const dir = new THREE.Vector3(-Math.sin(yaw) * Math.cos(this.look.pitch), Math.sin(this.look.pitch), -Math.cos(yaw) * Math.cos(this.look.pitch));
      // 선체 자세(횡동요·종동요)를 시선에도 반영
      const q = new THREE.Quaternion();
      view.motion.getWorldQuaternion(q);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      this.camera.up.copy(up);
      this.camera.lookAt(pos.clone().add(dir));
      this.controls.target.copy(pos.clone().add(dir.clone().multiplyScalar(400)).setY(0));
      return;
    }
    this.camera.up.set(0, 1, 0);
    if (this.fly) {
      this.fly.t = Math.min(1, this.fly.t + dt / 1.3);
      const k = this.fly.t < 0.5 ? 2 * this.fly.t * this.fly.t : 1 - (-2 * this.fly.t + 2) ** 2 / 2;
      this.controls.target.lerpVectors(this.fly.fromT, this.fly.toT, k);
      this.camera.position.lerpVectors(this.fly.fromP, this.fly.toP, k);
      if (this.fly.t >= 1) this.fly = null;
    }
    if (this.mode === 'follow' && v) {
      const now = toWorld(v.x, v.y, 0);
      const delta = now.clone().sub(this.prevPos);
      this.prevPos = now;
      if (this.fly) {
        this.fly.toT.add(delta);
        this.fly.toP.add(delta);
      } else {
        this.controls.target.add(delta);
        this.camera.position.add(delta);
      }
    }
    this.controls.update();
    if (this.camera.position.y < 4) this.camera.position.y = 4;
  }
}

async function main() {
  setLoading('해안선 데이터 불러오는 중…');
  const coast = await (await fetch('data/coastline.json')).json();

  const container = document.getElementById('viewport');
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.5;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  const labels = new CSS2DRenderer();
  labels.setSize(container.clientWidth, container.clientHeight);
  labels.domElement.className = 'labels';
  container.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 1.5, 160000);
  camera.position.set(1500, 1350, 1200);

  setLoading('시뮬레이션 준비 중…');
  const sim = new Simulation();
  const kstNow = new Date(Date.now() + KST_OFFSET_H * 3600_000);
  const startUtc = Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate(), SCENARIO_START.hour - KST_OFFSET_H, SCENARIO_START.minute);

  setLoading('항만 지형·시설 만드는 중…');
  const world = new World({ renderer, scene, camera, coast, sim });
  const fleet = new FleetView(scene, sim, world);
  const cam = new CameraRig(camera, renderer.domElement, fleet);
  cam.controls.target.set(-700, 0, -1200);
  cam.controls.update();
  const ui = new UI({ sim, fleet, world, startUtc, cam });
  fleet.onLabelClick = (v) => ui.select(v);

  // 클릭으로 선박 선택(드래그는 무시)
  const ray = new THREE.Raycaster();
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY };
  });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || cam.mode === 'bridge') return;
    const r = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const v = fleet.pick(ray);
    if (v) ui.select(v);
  });
  renderer.domElement.addEventListener('dblclick', () => {
    if (ui.selected) cam.follow(ui.selected);
  });

  window.addEventListener('resize', () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h);
    labels.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });

  // 첫 화면: 시뮬레이션 시간을 맞춘 뒤 셰이더를 미리 컴파일
  world.update(startUtc, 0, cam.controls.target);
  fleet.update(0, 0, camera, world.daylight);
  renderer.compile(scene, camera);
  loading.classList.add('done');
  setTimeout(() => loading.remove(), 600);

  let last = performance.now();
  let fpsT = 0;
  let frames = 0;
  renderer.setAnimationLoop((now) => {
    const dtReal = Math.min(0.1, (now - last) / 1000);
    last = now;
    const dtSim = ui.paused ? 0 : Math.min(dtReal * ui.speed, 40);
    if (dtSim > 0) sim.step(dtSim);
    fleet.timeScale = ui.paused ? 0 : ui.speed;
    fleet.hideLabelOf = cam.mode === 'bridge' ? cam.target : null;
    world.update(startUtc + sim.t * 1000, sim.t, cam.controls.target);
    cam.update(dtReal);
    fleet.update(sim.t, dtReal, camera, world.daylight);
    ui.update(sim.t, now);
    renderer.render(scene, camera);
    labels.render(scene, camera);
    frames++;
    fpsT += dtReal;
    if (fpsT > 1) {
      document.getElementById('fps').textContent = `${Math.round(frames / fpsT)} fps`;
      frames = 0;
      fpsT = 0;
    }
  });
}

main().catch((err) => {
  console.error(err);
  loading.classList.add('error');
  setLoading(`불러오지 못했습니다: ${err.message}`);
});
