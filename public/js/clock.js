// 시나리오 시계: 매일 KST 07:30 의 고정 상태에서 출발해 지금(실제 시각)까지 진행한 상태를 2D 지도와 3D 뷰가 함께 쓴다.
import { KST_OFFSET_H, SCENARIO_START } from './data.js';

/** 오늘(아직 07:30 전이면 어제) KST 07:30 의 UTC ms 와 지금까지 경과 초 */
export function scenarioClock(nowMs = Date.now()) {
  const kst = new Date(nowMs + KST_OFFSET_H * 3600_000);
  let startUtc = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), SCENARIO_START.hour - KST_OFFSET_H, SCENARIO_START.minute);
  if (startUtc > nowMs) startUtc -= 86_400_000;
  return { startUtc, elapsed: (nowMs - startUtc) / 1000 };
}

/** 시뮬레이션을 seconds 만큼 chunk 초 단위로 진행. 매 chunk 뒤 onChunk(sim) 호출(항적 기록 등) */
export function advance(sim, seconds, chunk = 120, onChunk) {
  let left = seconds;
  while (left > 0) {
    const d = Math.min(chunk, left);
    sim.step(d);
    left -= d;
    onChunk?.(sim);
  }
}

/** UTC ms → 'YYYY-MM-DD HH:MM' (KST) */
export function kstText(utcMs) {
  const d = new Date(utcMs + KST_OFFSET_H * 3600_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
