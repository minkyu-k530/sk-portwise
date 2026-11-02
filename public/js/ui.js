// 화면 UI: 상단 시계·배속, 좌측 선박/부두/로그 패널, 우측 선박 카드, 미니맵, 시점 버튼.
import { KST_OFFSET_H, WEATHER } from './data.js';
import { KN, PHASE_KR, STAGE_KR, fmtDur, navStatus } from './sim.js';

const D2R = Math.PI / 180;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const deg = (r) => `${String(Math.round(((r / D2R) % 360 + 360) % 360)).padStart(3, '0')}°`;
const kn = (ms) => (ms / KN).toFixed(1);
const FLAG = { KR: '대한민국', MH: '마셜제도', LR: '라이베리아', PA: '파나마', SG: '싱가포르', HK: '홍콩' };
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

export function phaseGroup(v) {
  if (v.phase === 'away') return 'away';
  if (['moored', 'buoyMoored'].includes(v.phase)) return 'moored';
  if (['anchoring', 'anchored', 'heaving'].includes(v.phase)) return 'anchored';
  if (['berthing', 'unberthing', 'buoyMooring', 'buoyLeave'].includes(v.phase)) return 'maneuver';
  return 'underway';
}
const GROUP_KR = { underway: '항해', maneuver: '접·이안', moored: '계류', anchored: '묘박', away: '항외' };

export class UI {
  constructor({ sim, fleet, world, startUtc, cam }) {
    this.sim = sim;
    this.fleet = fleet;
    this.world = world;
    this.startUtc = startUtc;
    this.cam = cam;
    this.speed = 1;
    this.paused = false;
    this.selected = null;
    this.tab = 'ships';
    this.lastPanel = 0;
    this.$ = (id) => document.getElementById(id);
    this.#bindTop();
    this.#bindTabs();
    this.#bindView();
    this.#minimapInit();
    this.#keys();
  }

  kstDate(simT) {
    return new Date(this.startUtc + simT * 1000 + KST_OFFSET_H * 3600_000);
  }

  clock(simT, withSec = true) {
    const d = this.kstDate(simT);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}${withSec ? `:${p(d.getUTCSeconds())}` : ''}`;
  }

  /** HH:MM, 현재 시뮬레이션 날짜와 다르면 (전일)/(+N일) 표시 */
  when(t, simT) {
    const day = (x) => Math.floor((this.startUtc + x * 1000 + KST_OFFSET_H * 3600_000) / 86400_000);
    const diff = day(t) - day(simT);
    return `${this.clock(t, false)}${diff === 0 ? '' : diff === -1 ? ' (전일)' : diff < 0 ? ` (${diff}일)` : ` (+${diff}일)`}`;
  }

  #bindTop() {
    for (const b of document.querySelectorAll('[data-speed]')) {
      b.addEventListener('click', () => this.setSpeed(Number(b.dataset.speed)));
    }
    this.setSpeed(this.speed);
  }

  setSpeed(s) {
    this.paused = s === 0;
    if (s > 0) this.speed = s;
    for (const b of document.querySelectorAll('[data-speed]')) {
      b.classList.toggle('on', this.paused ? b.dataset.speed === '0' : Number(b.dataset.speed) === this.speed);
    }
  }

  #bindTabs() {
    for (const b of document.querySelectorAll('[data-tab]')) {
      b.addEventListener('click', () => {
        this.tab = b.dataset.tab;
        for (const x of document.querySelectorAll('[data-tab]')) x.classList.toggle('on', x === b);
        this.lastPanel = 0;
      });
    }
    // 목록은 0.5초마다 다시 그리므로 click(누름·뗌이 같은 요소여야 함) 대신 pointerdown 으로 받는다
    this.$('panelBody').addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const row = e.target.closest('[data-vessel]');
      if (row) {
        const v = this.#findVessel(row.dataset.vessel);
        if (v) {
          this.select(v);
          if (v.phase !== 'away') this.cam.flyToVessel(v);
        }
        return;
      }
      const fac = e.target.closest('[data-fac]');
      if (fac) this.cam.flyToFacility(this.sim.facility(fac.dataset.fac));
    });
  }

  #bindView() {
    this.$('btnHome').addEventListener('click', () => this.cam.home());
    this.$('btnFollow').addEventListener('click', () => this.selected && this.cam.follow(this.selected));
    this.$('btnBridge').addEventListener('click', () => this.selected && this.cam.bridge(this.selected));
    const lab = this.$('btnLabels');
    lab.addEventListener('click', () => {
      lab.classList.toggle('on');
      this.fleet.setLabels(lab.classList.contains('on'));
      document.body.classList.toggle('nolabels', !lab.classList.contains('on'));
    });
    const chart = this.$('btnChart');
    chart.addEventListener('click', () => {
      chart.classList.toggle('on');
      this.world.setOverlay(chart.classList.contains('on'));
    });
    this.$('card').addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act || !this.selected) return;
      if (act === 'follow') this.cam.follow(this.selected);
      if (act === 'bridge') this.cam.bridge(this.selected);
      if (act === 'goto') this.cam.flyToVessel(this.selected);
      if (act === 'close') this.select(null);
    });
  }

  #keys() {
    window.addEventListener('keydown', (e) => {
      if (e.target.closest('input, textarea')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        this.setSpeed(this.paused ? this.speed : 0);
      }
      const speeds = { Digit1: 1, Digit2: 10, Digit3: 60, Digit4: 300, Digit5: 1200 };
      if (speeds[e.code]) this.setSpeed(speeds[e.code]);
      if (e.code === 'KeyF' && this.selected) this.cam.follow(this.selected);
      if (e.code === 'KeyB' && this.selected) this.cam.bridge(this.selected);
      if (e.code === 'KeyH') this.cam.home();
      if (e.code === 'Escape') {
        if (this.cam.mode !== 'orbit') this.cam.release();
        else this.select(null);
      }
    });
  }

  #findVessel(id) {
    return this.sim.ships.find((s) => s.id === id) ?? this.sim.tugs.find((t) => t.id === id) ?? null;
  }

  select(v) {
    this.selected = v;
    this.fleet.select(v);
    this.$('card').classList.toggle('hidden', !v);
    this.$('btnFollow').disabled = !v;
    this.$('btnBridge').disabled = !v;
    if (!v && this.cam.mode !== 'orbit') this.cam.release();
    this.lastCard = 0;
    this.lastPanel = 0;
  }

  update(simT, nowMs) {
    const d = this.kstDate(simT);
    this.$('clockDate').textContent = `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${String(d.getUTCDate()).padStart(2, '0')} (${WEEK[d.getUTCDay()]})`;
    this.$('clockTime').textContent = this.clock(simT);
    const w = this.world;
    const sunDeg = (w.sunAlt ?? 0) / D2R;
    this.$('sky').textContent = sunDeg > 6 ? '주간' : sunDeg > -6 ? '박명' : '야간';
    const wind = ((WEATHER.windFromDeg + WEATHER.windSwingDeg * Math.sin((2 * Math.PI * simT) / (WEATHER.windPeriodH * 3600))) % 360 + 360) % 360;
    this.$('wind').textContent = `${dirName(wind)} ${WEATHER.windKn}kn · 너울 ${WEATHER.swellM}m`;
    this.$('modeHint').textContent = this.cam.mode === 'bridge' ? `브리지 뷰 — ${this.cam.target?.name} (드래그로 둘러보기 · Esc 해제)` : this.cam.mode === 'follow' ? `따라가기 — ${this.cam.target?.name} (Esc 해제)` : '';
    this.$('modeHint').classList.toggle('hidden', this.cam.mode === 'orbit');
    if (nowMs - this.lastPanel > 500) {
      this.lastPanel = nowMs;
      this.#renderPanel(simT);
      this.#renderCounts();
    }
    if (this.selected && nowMs - (this.lastCard ?? 0) > 250) {
      this.lastCard = nowMs;
      this.#renderCard(simT);
    }
    this.#minimapDraw();
  }

  #renderCounts() {
    const c = { underway: 0, maneuver: 0, moored: 0, anchored: 0, away: 0 };
    for (const s of this.sim.ships) c[phaseGroup(s)]++;
    this.$('counts').innerHTML = Object.entries(c).filter(([k]) => k !== 'away')
      .map(([k, n]) => `<span class="cnt g-${k}"><i></i>${GROUP_KR[k]} ${n}</span>`).join('');
  }

  #renderPanel(simT) {
    const body = this.$('panelBody');
    if (this.tab === 'ships') body.innerHTML = this.#shipList(simT);
    else if (this.tab === 'berths') body.innerHTML = this.#berthList(simT);
    else body.innerHTML = this.#eventList();
  }

  #shipList(simT) {
    const order = { maneuver: 0, underway: 1, moored: 2, anchored: 3, away: 4 };
    const ships = [...this.sim.ships].sort((a, b) => order[phaseGroup(a)] - order[phaseGroup(b)] || (a.returnAt ?? 0) - (b.returnAt ?? 0));
    const rows = ships.map((s) => {
      const g = phaseGroup(s);
      let status = PHASE_KR[s.phase];
      if (s.phase === 'away') status = `입항 예정 ${this.when(s.returnAt, simT)}`;
      else if (s.stage && ['moored', 'buoyMoored'].includes(s.phase)) status = `${s.slot.id} · ${STAGE_KR[s.stage]}${s.stage === 'cargo' ? ` ${Math.round(this.#progress(s, simT) * 100)}%` : ''}`;
      else if (s.phase === 'anchored') status = `${s.spot?.anchorage.id ?? ''} 묘박 · ${s.spec.home} 대기 ${fmtDur(simT - (s.waitSince ?? simT))}`;
      else if (s.slot) status += ` → ${s.slot.id}`;
      const spd = s.phase === 'away' ? '' : `${kn(s.sog)}kn`;
      return `<li data-vessel="${s.id}" class="${this.selected === s ? 'sel' : ''}">
        <i class="dot g-${g}"></i>
        <div class="nm"><b>${esc(s.name)}</b><small>${esc(s.cls.kr)}</small></div>
        <div class="st">${esc(status)}</div><div class="sp">${spd}</div></li>`;
    }).join('');
    const tugs = this.sim.tugs.map((t) => `<li data-vessel="${t.id}" class="tug ${this.selected === t ? 'sel' : ''}">
      <i class="dot ${t.job ? 'g-maneuver' : 'g-away'}"></i>
      <div class="nm"><b>${esc(t.name)}</b><small>예선 ${t.bollardT}t</small></div>
      <div class="st">${t.job ? `${esc(t.job.ship.name)} ${t.attached ? '작업 중' : '이동 중'}` : '대기'}</div><div class="sp">${kn(t.speed)}kn</div></li>`).join('');
    return `<ul class="vlist">${rows}</ul><h4>예선</h4><ul class="vlist">${tugs}</ul>`;
  }

  #progress(s, simT) {
    if (s.stage !== 'cargo') return s.stage === 'ready' || s.stage === 'hoseOff' ? 1 : 0;
    return Math.min(1, Math.max(0, (simT - s.stageStart) / (s.stageEnd - s.stageStart)));
  }

  #berthList(simT) {
    return this.sim.facilities.map((f) => {
      const slots = f.slots.map((slot) => {
        const s = slot.occupant ? this.sim.ships.find((x) => x.id === slot.occupant) : null;
        let body = '<span class="muted">비어 있음</span>';
        if (s) {
          if (['moored', 'buoyMoored'].includes(s.phase)) {
            const p = this.#progress(s, simT);
            body = `<a data-vessel="${s.id}">${esc(s.name)}</a> <span class="tag">${STAGE_KR[s.stage]}</span>
              <div class="bar"><i style="width:${(p * 100).toFixed(0)}%"></i></div>`;
          } else {
            body = `<a data-vessel="${s.id}">${esc(s.name)}</a> <span class="tag t-in">${PHASE_KR[s.phase]}</span>`;
          }
        }
        return `<div class="slot"><span class="sid">${slot.id}</span><div>${body}</div></div>`;
      }).join('');
      const queue = f.queue.map((id) => this.sim.ships.find((s) => s.id === id))
        .map((s) => `<a data-vessel="${s.id}">${esc(s.name)}</a> <small>${s.phase === 'anchored' ? `${s.spot?.anchorage.id} ` : ''}${fmtDur(simT - (s.waitSince ?? simT))}</small>`).join(' · ');
      return `<section class="fac">
        <header data-fac="${f.id}"><b>${f.label}</b><small>${esc(f.operator)} · ${esc(f.capacity)} · 수심 ${f.depth}m</small></header>
        ${slots}${queue ? `<div class="queue">대기 ${queue}</div>` : ''}</section>`;
    }).join('');
  }

  #eventList() {
    return `<ol class="log">${this.sim.events.slice(-150).reverse().map((e) => `<li ${e.ship ? `data-vessel="${e.ship}"` : ''}>
      <time>${this.clock(e.t, false)}</time><b>${esc(e.name ?? '')}</b> ${esc(e.text)}</li>`).join('')}</ol>`;
  }

  #renderCard(simT) {
    const v = this.selected;
    const card = this.$('card');
    if (!v) return;
    const isTug = !v.spec;
    if (isTug) {
      card.innerHTML = `<header><div><h2>${esc(v.name)}</h2><p>항만 예선 (ASD) · 예인력 ${v.bollardT}t</p></div><button data-act="close" title="닫기">✕</button></header>
        <dl class="grid">
          <dt>작업</dt><dd>${v.job ? `${esc(v.job.ship.name)} — ${v.mode === 'push' ? '접·이안 보조(밀기)' : v.mode === 'stern' ? '선미 견제(예인줄)' : '호송(예인줄)'}` : '대기'}</dd>
          <dt>상태</dt><dd>${v.job ? (v.attached ? '작업 위치' : '이동 중') : '예선 계류장'}</dd>
          <dt>SOG</dt><dd>${kn(v.speed)} kn</dd><dt>HDG</dt><dd>${deg(v.psi)}</dd>
          <dt>추력</dt><dd><div class="bar"><i style="width:${Math.round(v.thrust * 100)}%"></i></div></dd>
        </dl>
        <footer><button data-act="follow">따라가기</button><button data-act="bridge">조타실 뷰</button></footer>`;
      return;
    }
    const s = v;
    const st = navStatus(s);
    const trim = s.trim;
    const fore = s.draft - trim / 2;
    const aft = s.draft + trim / 2;
    const rot = (s.phase === 'away' ? 0 : (s.r / D2R) * 60).toFixed(1);
    const rudder = s.delta / D2R;
    const tugs = this.sim.tugsOf(s).map((t) => `${t.name}${t.attached ? '' : '(이동)'}`).join(', ');
    const eta = this.sim.etaOf(s);
    const dest = s.slot ? `${s.slot.facility.label} (${s.slot.id})` : this.sim.facility(s.spec.home).label;
    const prog = this.#progress(s, simT);
    card.innerHTML = `
      <header><div><h2>${esc(s.name)}</h2><p>${esc(s.cls.kr)} · ${FLAG[s.spec.flag] ?? s.spec.flag}</p></div><button data-act="close" title="닫기">✕</button></header>
      <div class="chips"><span class="chip g-${phaseGroup(s)}">${PHASE_KR[s.phase]}</span><span class="chip">AIS ${st.code} · ${st.kr}</span>${s.stage && ['moored', 'buoyMoored'].includes(s.phase) ? `<span class="chip">${STAGE_KR[s.stage]}</span>` : ''}</div>
      <dl class="grid">
        <dt>MMSI</dt><dd>${s.spec.mmsi}</dd><dt>IMO</dt><dd>${s.spec.imo}</dd>
        <dt>호출부호</dt><dd>${s.spec.callSign}</dd><dt>DWT</dt><dd>${s.spec.dwt.toLocaleString()} t</dd>
        <dt>LOA×B</dt><dd>${s.L} × ${s.B} m</dd><dt>흘수</dt><dd>${s.phase === 'away' ? '-' : `선수 ${fore.toFixed(1)} / 선미 ${aft.toFixed(1)} m`}</dd>
      </dl>
      ${s.phase === 'away' ? '' : `<div class="nav">
        <div><small>SOG</small><b>${kn(s.sog)}</b><small>kn</small></div>
        <div><small>COG</small><b>${s.sog > 0.15 ? deg(s.cog) : '-'}</b></div>
        <div><small>HDG</small><b>${deg(s.psi)}</b></div>
        <div><small>ROT</small><b>${rot}</b><small>°/min</small></div>
      </div>
      <div class="helm">
        <div class="rudder"><small>타각 ${rudder >= 0 ? '우' : '좌'} ${Math.abs(rudder).toFixed(0)}°</small><div class="gauge"><i style="left:${50 + (rudder / 35) * 50}%"></i></div></div>
        <div class="tele"><small>기관 지령</small><b>${s.telegraph}</b></div>
      </div>`}
      <dl class="grid">
        <dt>목적지</dt><dd>${esc(dest)}</dd>
        <dt>${s.phase === 'away' ? '입항 예정' : 'ETA'}</dt><dd>${eta != null ? this.when(eta, simT) : ['moored', 'buoyMoored'].includes(s.phase) ? `접안 ${this.when(s.berthedAt ?? simT, simT)}` : '-'}</dd>
        <dt>화물</dt><dd>${esc(s.spec.cargo)}</dd>
        <dt>적재</dt><dd><div class="bar"><i style="width:${Math.round(s.cargo * 100)}%"></i></div><small>${Math.round(s.cargo * 100)}%${s.stage === 'cargo' ? ` · 작업 ${Math.round(prog * 100)}%` : ''}</small></dd>
        ${tugs ? `<dt>예선</dt><dd>${esc(tugs)}</dd>` : ''}
        ${s.waitSince != null && s.phase !== 'away' ? `<dt>대기</dt><dd>${fmtDur(simT - s.waitSince)} (체선)</dd>` : ''}
      </dl>
      ${s.phase === 'away' ? '' : '<footer><button data-act="goto">위치로</button><button data-act="follow">따라가기</button><button data-act="bridge">브리지 뷰</button></footer>'}`;
  }

  // ── 미니맵 ──
  #minimapInit() {
    const c = this.$('minimap');
    const mask = this.world.mask;
    this.mm = { c, g: c.getContext('2d'), w: c.width, h: c.height };
    const bg = document.createElement('canvas');
    bg.width = c.width;
    bg.height = c.height;
    const g = bg.getContext('2d');
    g.fillStyle = '#0d2733';
    g.fillRect(0, 0, bg.width, bg.height);
    g.imageSmoothingEnabled = true;
    // 육지 마스크를 색칠해 축소
    const tmp = document.createElement('canvas');
    tmp.width = mask.w;
    tmp.height = mask.h;
    const tg = tmp.getContext('2d');
    const img = tg.createImageData(mask.w, mask.h);
    for (let i = 0; i < mask.land.length; i++) {
      const on = mask.land[i];
      img.data.set(on ? [84, 92, 80, 255] : [13, 39, 51, 255], i * 4);
    }
    tg.putImageData(img, 0, 0);
    g.drawImage(tmp, 0, 0, bg.width, bg.height);
    this.mm.bg = bg;
    this.mm.sx = bg.width / (mask.w * mask.cell);
    this.mm.sy = bg.height / (mask.h * mask.cell);
    c.addEventListener('click', (e) => {
      const r = c.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * c.width;
      const py = ((e.clientY - r.top) / r.height) * c.height;
      this.cam.flyTo(mask.x0 + px / this.mm.sx, mask.y1 - py / this.mm.sy);
    });
  }

  #minimapDraw() {
    const { g, bg, sx, sy } = this.mm;
    const mask = this.world.mask;
    const P = (x, y) => [(x - mask.x0) * sx, (mask.y1 - y) * sy];
    g.drawImage(bg, 0, 0);
    const colors = { underway: '#5fd4ff', maneuver: '#ffb547', moored: '#5ee089', anchored: '#c39bff' };
    for (const s of this.sim.ships) {
      if (s.phase === 'away') continue;
      const [px, py] = P(s.x, s.y);
      g.save();
      g.translate(px, py);
      g.rotate(s.psi);
      g.fillStyle = colors[phaseGroup(s)];
      const l = Math.max(3, s.L * sx * 1.3);
      g.beginPath();
      g.moveTo(0, -l);
      g.lineTo(l * 0.45, l * 0.6);
      g.lineTo(-l * 0.45, l * 0.6);
      g.closePath();
      g.fill();
      if (this.selected === s) {
        g.strokeStyle = '#fff';
        g.lineWidth = 1.5;
        g.stroke();
      }
      g.restore();
    }
    g.fillStyle = '#ff7a59';
    for (const t of this.sim.tugs) {
      const [px, py] = P(t.x, t.y);
      g.fillRect(px - 1, py - 1, 2, 2);
    }
    // 카메라 위치·시선
    const cam = this.cam.camera.position;
    const tgt = this.cam.controls.target;
    const [cx, cy] = P(cam.x, -cam.z);
    const [tx, ty] = P(tgt.x, -tgt.z);
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(tx, ty);
    g.stroke();
    g.beginPath();
    g.arc(tx, ty, 4, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#fff';
    g.fillRect(cx - 2, cy - 2, 4, 4);
  }
}

function dirName(d) {
  const names = ['북', '북북동', '북동', '동북동', '동', '동남동', '남동', '남남동', '남', '남남서', '남서', '서남서', '서', '서북서', '북서', '북북서'];
  return `${names[Math.round(d / 22.5) % 16]}풍`;
}
