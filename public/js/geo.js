// 위경도 ↔ 시뮬레이션 로컬 좌표(미터). x = 동쪽, y = 북쪽. 3D 장면에서는 (x, 높이, -y) 로 쓴다.
// 영역이 15 km 정도라 등장방형 근사로 충분하다(오차 < 0.1 %).

/** 시뮬레이션 영역: 울산본항 SK 부두 ~ SK 2·3부이 ~ 외항 정박지 */
export const BOUNDS = { south: 35.4, west: 129.33, north: 35.53, east: 129.49 };
export const ORIGIN = { lat: 35.47, lng: 129.4 };

const M_PER_DEG_LAT = 110_950;
const M_PER_DEG_LNG = 111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180);

export function toLocal(lat, lng) {
  return { x: (lng - ORIGIN.lng) * M_PER_DEG_LNG, y: (lat - ORIGIN.lat) * M_PER_DEG_LAT };
}

export function toLatLng(x, y) {
  return { lat: ORIGIN.lat + y / M_PER_DEG_LAT, lng: ORIGIN.lng + x / M_PER_DEG_LNG };
}

/** 위도/경도를 도·분 표기로 (예: 35°28.215'N) */
export function formatDm(value, pos, neg) {
  const hemi = value >= 0 ? pos : neg;
  const v = Math.abs(value);
  const deg = Math.floor(v);
  const min = (v - deg) * 60;
  return `${deg}°${min.toFixed(3).padStart(6, '0')}'${hemi}`;
}
