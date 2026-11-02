// 시뮬레이션 선박·예선을 3D 모델로 그린다: 자세(흘수·트림·횡동요·종동요), 프로펠러·타·레이더,
// 항해등·정박등·하역등, 이름표, 항적, 계류줄·예인줄·닻줄, 부이 호스, 로딩암 연결.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { WEATHER } from './data.js';
import { LineSystem, WakeSystem } from './effects.js';
import { MATERIALS, buildShip, buildTug } from './models.js';
import { glowTexture, toWorld } from './scene.js';
import { PHASE_KR, STAGE_KR, fwdVec, navStatus, stbdVec, wrapPi } from './sim.js';

const D2R = Math.PI / 180;
const SECTOR = 112.5 * D2R;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function lightSprite(color, size = 0.011) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture('#ffffff'), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, sizeAttenuation: false, fog: false,
  }));
  s.scale.set(size, size, 1);
  s.renderOrder = 5;
  return s;
}

export class FleetView {
  constructor(scene, sim, world) {
    this.scene = scene;
    this.sim = sim;
    this.world = world;
    this.views = new Map();
    this.pickables = [];
    this.wakes = new WakeSystem(scene);
    this.lines = new LineSystem(scene);
    this.labelsOn = true;
    this.hoses = new Map();
    for (const ship of sim.ships) this.#addVessel(ship, buildShip(ship.spec, ship.cls), false);
    for (const tug of sim.tugs) this.#addVessel(tug, buildTug(), true);
    this.selRing = new THREE.Mesh(
      new THREE.RingGeometry(0.92, 1, 64),
      new THREE.MeshBasicMaterial({ color: 0x5fd4ff, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.selRing.rotation.x = -Math.PI / 2;
    this.selRing.visible = false;
    this.selRing.renderOrder = 3;
    scene.add(this.selRing);
    this.selected = null;
    this.hoseMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.7 });
    this.floatMat = new THREE.MeshStandardMaterial({ color: 0xf07a22, roughness: 0.6 });
  }

  #addVessel(v, model, isTug) {
    const root = new THREE.Group();
    const motion = new THREE.Group();
    root.add(motion);
    motion.add(model.root);
    this.scene.add(root);
    for (const m of model.pickable) {
      m.userData.vessel = v;
      this.pickables.push(m);
    }
    const L = model.lights;
    const sp = {};
    const add = (name, color, size) => {
      if (!L[name]) return;
      const s = lightSprite(color, size);
      s.position.copy(L[name]);
      model.root.add(s);
      sp[name] = s;
    };
    add('mastFwd', 0xfff4e0);
    add('mastAft', 0xfff4e0);
    add('port', 0xff2a1a);
    add('stbd', 0x2aff5a);
    add('stern', 0xfff4e0);
    add('anchorFwd', 0xfff4e0);
    add('anchorAft', 0xfff4e0);
    add('cargoRed', 0xff2a1a);
    add('towing', 0xffc400);
    sp.flood = (L.flood ?? []).map((p) => {
      const s = lightSprite(0xffd28a, 0.02);
      s.position.copy(p);
      model.root.add(s);
      return s;
    });
    const el = document.createElement('div');
    el.className = isTug ? 'vlabel tug' : 'vlabel';
    el.innerHTML = `<b>${v.name}</b><span></span>`;
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.onLabelClick?.(v);
    });
    const label = new CSS2DObject(el);
    label.position.set(0, model.anchors.labelY, 0);
    root.add(label);
    this.views.set(v.id, {
      v, model, root, motion, sprites: sp, label, labelSpan: el.querySelector('span'), el, isTug,
      draft: isTug ? model.draft : null, phaseSeed: Math.random() * 100, lastPhase: null,
    });
  }

  setLabels(on) {
    this.labelsOn = on;
  }

  select(v) {
    this.selected = v;
    for (const view of this.views.values()) view.el.classList.toggle('sel', view.v === v);
  }

  /** 레이캐스트로 선박/예선 고르기 */
  pick(raycaster) {
    const hit = raycaster.intersectObjects(this.pickables, false).find((h) => h.object.parent?.parent?.parent?.visible !== false);
    return hit?.object.userData.vessel ?? null;
  }

  view(v) {
    return this.views.get(v.id);
  }

  /** 선박 로컬 기준점(모델 좌표)을 월드 좌표로 */
  worldOf(v, local) {
    const view = this.views.get(v.id);
    view.model.root.updateWorldMatrix(true, false);
    return view.model.root.localToWorld(local.clone());
  }

  update(simT, dtReal, camera, daylight) {
    const night = clamp((0.6 - daylight) / 0.45, 0, 1);
    MATERIALS.glass.emissiveIntensity = night * 1.4;
    // 야간: 갑판등·거주구 조명에 비친 정도로 선체를 아주 약하게 밝힌다
    MATERIALS.body.emissive.setRGB(0.05, 0.045, 0.035).multiplyScalar(night);
    this.lines.begin();
    for (const view of this.views.values()) this.#updateVessel(view, simT, dtReal, camera, night);
    this.#updateLines();
    this.#updateHoses(simT);
    this.#updateArms(dtReal);
    this.lines.end();
    this.wakes.update(simT, this.scene.fog);
    if (this.selected && this.selected.phase !== 'away') {
      const view = this.views.get(this.selected.id);
      const r = (view.v.L ?? 32) * 0.62 + 12;
      this.selRing.visible = true;
      this.selRing.position.set(view.root.position.x, 0.6, view.root.position.z);
      this.selRing.scale.set(r, r, 1);
      this.selRing.material.opacity = 0.55 + 0.3 * Math.sin(performance.now() / 300);
    } else {
      this.selRing.visible = false;
    }
  }

  #updateVessel(view, simT, dtReal, camera, night) {
    const { v, model, root, motion, sprites, isTug } = view;
    const away = !isTug && v.phase === 'away';
    root.visible = !away;
    if (away) {
      if (view.lastPhase !== 'away') {
        this.wakes.cut(v.id);
        this.wakes.cut(`${v.id}:p`);
        this.wakes.cut(`${v.id}:s`);
      }
      view.lastPhase = 'away';
      view.label.visible = false;
      return;
    }
    view.lastPhase = v.phase;
    root.position.set(v.x, 0, -v.y);
    root.rotation.y = -v.psi;

    // 흘수·트림(선미가 깊으면 선수가 들린다)
    const draft = isTug ? view.draft : v.draft;
    const trim = isTug ? 0.3 : v.trim;
    const { L, B } = v;
    model.root.position.y = -draft;
    // 파랑 운동: 외해 노출도에 비례(항내는 잔물결 정도). 횡동요 주기 ≈ 0.8·B/√GM, GM ≈ 0.08·B
    const exposure = clamp((-v.y - 300) / 3200, 0, 1);
    const moored = !isTug && (v.phase === 'moored' || v.phase === 'buoyMoored');
    const amp = WEATHER.swellM * (0.12 + exposure) * (moored ? 0.35 : 1);
    const tRoll = 2.83 * Math.sqrt(B);
    const tPitch = 0.55 * Math.sqrt(L) + 3;
    const s = view.phaseSeed;
    const roll = amp * 2.4 * D2R * (100 / L) ** 0.8 * Math.sin((2 * Math.PI * simT) / tRoll + s);
    const pitch = amp * 1.1 * D2R * (100 / L) * Math.sin((2 * Math.PI * simT) / tPitch + s * 1.7);
    const heave = amp * 0.3 * Math.sin((2 * Math.PI * simT) / 7.5 + s * 0.6);
    const heel = isTug ? clamp((v.speed ?? 0) * this.#yawRate(view, v.psi, simT) * 3, -0.12, 0.12) : clamp(v.u * v.r * 2.5, -0.03, 0.03);
    motion.rotation.set(Math.atan2(trim, L) + pitch, 0, roll + heel, 'YXZ');
    motion.position.y = heave;

    // 프로펠러·타·레이더
    if (!isTug) {
      const turning = ['anchored', 'moored', 'buoyMoored', 'anchoring', 'heaving'].includes(v.phase) ? 0 : clamp(v.uCmd / v.vService, -0.6, 1);
      const astern = v.telegraph.includes('ASTERN') ? -0.5 : 1;
      model.propeller.rotation.z += dtReal * turning * astern * 9;
      model.rudder.rotation.y = v.delta;
      for (const r of model.radar) r.rotation.y += dtReal * 2.4;
    }

    // 등화
    const vx = camera.position.x - root.position.x;
    const vz = camera.position.z - root.position.z;
    const rel = wrapPi(Math.atan2(vx, -vz) - v.psi);
    const st = isTug ? { code: v.job ? 0 : 5 } : navStatus(v);
    const underway = st.code === 0 || st.code === 3 || (isTug && v.speed > 0.3);
    const anchored = st.code === 1;
    const moor = st.code === 5;
    const set = (name, on) => {
      const sprite = sprites[name];
      if (sprite) sprite.material.opacity = on ? night : 0;
      if (sprite) sprite.visible = on && night > 0.01;
    };
    set('mastFwd', underway && Math.abs(rel) <= SECTOR);
    set('mastAft', underway && Math.abs(rel) <= SECTOR && (isTug ? v.mode === 'escort' || v.mode === 'stern' : L >= 50));
    set('port', underway && rel <= 0 && rel >= -SECTOR);
    set('stbd', underway && rel >= 0 && rel <= SECTOR);
    set('stern', underway && Math.abs(rel) >= SECTOR);
    set('towing', isTug && (v.mode === 'escort' || v.mode === 'stern') && v.attached && Math.abs(rel) >= SECTOR);
    set('anchorFwd', anchored);
    set('anchorAft', anchored && L >= 50);
    set('cargoRed', moor || (anchored && false));
    for (const f of sprites.flood ?? []) {
      f.visible = (moor || anchored) && night > 0.01;
      f.material.opacity = night * 0.8;
    }

    // 이름표
    const dist = camera.position.distanceTo(root.position);
    const showLabel = this.labelsOn && this.hideLabelOf !== v && (dist < (isTug ? 2500 : 12000) || this.selected === v);
    view.label.visible = showLabel;
    if (showLabel) {
      view.el.style.opacity = this.selected === v ? 1 : clamp(1.4 - dist / (isTug ? 2500 : 12000), 0.25, 1);
      const status = isTug ? (v.job ? `${v.attached ? '' : '→ '}${v.job.ship.name} ${v.mode === 'push' ? '접·이안 보조' : v.mode === 'stern' ? '선미 견제' : '호송'}` : '대기')
        : `${PHASE_KR[v.phase]}${v.stage && (v.phase === 'moored' || v.phase === 'buoyMoored') ? ` · ${STAGE_KR[v.stage]}` : ''} · ${(v.sog / 0.514444).toFixed(1)}kn`;
      if (view.lastStatus !== status) {
        view.labelSpan.textContent = status;
        view.lastStatus = status;
      }
    }

    // 항적
    const sog = isTug ? v.speed : v.sog;
    const h = fwdVec(v.psi);
    const sv = stbdVec(v.psi);
    if (sog > 0.4) {
      const a = clamp(sog / 5, 0.1, 0.85);
      this.wakes.emit(v.id, simT, {
        x: v.x - h.x * L * 0.48, y: v.y - h.y * L * 0.48, nx: sv.x, ny: sv.y,
        w: B * 0.7, dw: isTug ? 0.8 : 0.35, vx: 0, vy: 0, a, life: isTug ? 70 : 150 + L * 0.4,
      }, Math.max(4, L / 12), 3);
      if (!isTug || sog > 2) {
        const bow = { x: v.x + h.x * L * 0.45, y: v.y + h.y * L * 0.45 };
        for (const side of [-1, 1]) {
          this.wakes.emit(`${v.id}:${side < 0 ? 'p' : 's'}`, simT, {
            x: bow.x + sv.x * side * B * 0.5, y: bow.y + sv.y * side * B * 0.5, nx: sv.x, ny: sv.y,
            w: 2.5 + L * 0.01, dw: 0.5, vx: sv.x * side * sog * 0.33, vy: sv.y * side * sog * 0.33, a: clamp(sog / 6, 0.05, 0.6), life: 75,
          }, Math.max(4, L / 14), 3);
        }
      }
    } else if (view.wasMoving) {
      this.wakes.cut(v.id);
      this.wakes.cut(`${v.id}:p`);
      this.wakes.cut(`${v.id}:s`);
    }
    view.wasMoving = sog > 0.4;
    if (isTug && v.thrust > 0.3 && v.attached) {
      this.wakes.emit(`${v.id}:wash`, simT, {
        x: v.x - h.x * 14, y: v.y - h.y * 14, nx: sv.x, ny: sv.y,
        w: 5, dw: 1.3, vx: -h.x * 2.4 * v.thrust, vy: -h.y * 2.4 * v.thrust, a: 0.65 * v.thrust, life: 22,
      }, Infinity, 0.8);
    }
  }

  #yawRate(view, psi, t) {
    const prev = view.prevPsi ?? psi;
    const pt = view.prevT ?? t;
    view.prevPsi = psi;
    view.prevT = t;
    const dt = t - pt;
    return dt > 0 ? wrapPi(psi - prev) / dt : 0;
  }

  #updateLines() {
    const rope = '#e7dcb4';
    for (const ship of this.sim.ships) {
      const view = this.views.get(ship.id);
      if (ship.phase === 'away') continue;
      const A = view.model.anchors;
      if (ship.phase === 'moored' && ship.slot?.quay) {
        const slot = ship.slot;
        const h = fwdVec(slot.heading);
        const n = slot.normal;
        const jetty = slot.facility.kind === 'jetty';
        const quay = (along, off) => toWorld(slot.quay.x + h.x * along + n.x * off, slot.quay.y + h.y * along + n.y * off, jetty ? 6.5 : 4.6);
        const span = jetty ? slot.maxLoa : ship.L;
        const F = A.fairleads;
        const pairs = [
          [F.bowP, quay(span * (jetty ? 0.62 : 0.5) + 15, jetty ? -10 : -4)],
          [F.bowP, quay(span * (jetty ? 0.3 : 0.38), jetty ? -4 : -3)],
          [F.springFP, quay(-ship.L * 0.05, jetty ? -4 : -3)],
          [F.springAP, quay(ship.L * 0.05, jetty ? -4 : -3)],
          [F.sternP, quay(-span * (jetty ? 0.3 : 0.38), jetty ? -4 : -3)],
          [F.sternP, quay(-span * (jetty ? 0.62 : 0.5) - 15, jetty ? -10 : -4)],
        ];
        for (const [local, q] of pairs) this.lines.rope(this.worldOf(ship, local), q, rope, 1.5);
      }
      if (['anchoring', 'anchored', 'heaving'].includes(ship.phase) && ship.anchor) {
        const bow = this.worldOf(ship, A.bow);
        const anc = toWorld(ship.anchor.x, ship.anchor.y, 0);
        const into = bow.clone().lerp(anc, 0.18);
        into.y = 0;
        this.lines.rope(bow, into, '#3a3a3a', 0, 1);
      }
      if (ship.phase === 'buoyMoored' && ship.anchor) {
        const bow = this.worldOf(ship, A.bow);
        this.lines.rope(bow, toWorld(ship.anchor.x, ship.anchor.y, 4.5), '#ff9a3c', 1.2);
      }
    }
    for (const tug of this.sim.tugs) {
      if (!tug.job || !tug.attached || tug.mode === 'push') continue;
      const ship = tug.job.ship;
      const sA = this.views.get(ship.id).model.anchors;
      const tA = this.views.get(tug.id).model.anchors;
      const ahead = tug.mode === 'escort' && tug.job.idx === 0;
      const from = this.worldOf(tug, ahead ? tA.stern : tA.bow);
      const to = this.worldOf(ship, ahead ? sA.bow : sA.stern);
      if (tug.job.idx === 2) continue;
      this.lines.rope(from, to, '#f2f2f2', 2.5, 10);
    }
  }

  /** 부이 계류 중 해상 호스(부이 → 선박 매니폴드) */
  #updateHoses(simT) {
    for (const f of this.sim.facilities) {
      if (f.kind !== 'buoy') continue;
      const slot = f.slots[0];
      const ship = slot.occupant ? this.sim.ships.find((s) => s.id === slot.occupant) : null;
      let hose = this.hoses.get(f.id);
      const connected = ship && ship.phase === 'buoyMoored' && ['hoseOn', 'cargo', 'hoseOff'].includes(ship.stage);
      const spm = this.world.spm.get(f.id);
      if (ship && ship.anchor) spm.head.rotation.y = Math.atan2(-(ship.x - f.buoy.x), -(-ship.y + f.buoy.y)) + Math.PI;
      if (!connected) {
        if (hose) hose.visible = false;
        continue;
      }
      const view = this.views.get(ship.id);
      const end = this.worldOf(ship, view.model.anchors.manifoldP);
      const key = `${end.x.toFixed(0)},${end.z.toFixed(0)}`;
      if (hose && hose.userData.key === key) {
        hose.visible = true;
        continue;
      }
      const start = toWorld(f.buoy.x, f.buoy.y, 1.2);
      const side = this.worldOf(ship, new THREE.Vector3(-ship.B / 2 - 25, 0, view.model.anchors.manifoldP.z));
      side.y = 0.4;
      const mid = start.clone().lerp(side, 0.5);
      mid.y = 0.4;
      const curve = new THREE.CatmullRomCurve3([start, mid, side, new THREE.Vector3(end.x, end.y - 2, end.z), end]);
      const geo = new THREE.TubeGeometry(curve, 60, 0.45, 6, false);
      if (!hose) {
        hose = new THREE.Mesh(geo, this.floatMat);
        this.scene.add(hose);
        this.hoses.set(f.id, hose);
      } else {
        hose.geometry.dispose();
        hose.geometry = geo;
      }
      hose.userData.key = key;
      hose.visible = true;
    }
  }

  /** 하역 중이면 선석 로딩암을 매니폴드로 뻗는다 */
  #updateArms(dtReal) {
    for (const arm of this.world.arms) {
      const occ = arm.slot.occupant ? this.sim.ships.find((s) => s.id === arm.slot.occupant) : null;
      let target = null;
      if (occ && occ.phase === 'moored' && ['hoseOn', 'cargo'].includes(occ.stage)) {
        const m = this.views.get(occ.id).model.anchors.manifoldP;
        target = this.worldOf(occ, new THREE.Vector3(m.x - 0.5, m.y + 0.8, m.z + arm.k * 1.6));
      }
      arm.update(target, Math.min(dtReal * Math.max(1, this.timeScale ?? 1), 1));
    }
  }
}
