// 고정 목업 데이터. 선박·선사·호출부호·MMSI·화물·일정은 모두 가상이다.
// 시설 위치는 SK 부두 실제 위치를 기준으로 했지만, 선석 수·배치는 시뮬레이션에 맞게 단순화했다.
// 좌표는 geo.js 로컬 미터(x 동, y 북). 각도는 진북 기준 시계방향(도).
import { toLocal } from './geo.js';

export const KST_OFFSET_H = 9;
/** 시나리오 시작 시각(KST). 날짜는 실행한 날의 KST 날짜를 쓴다. */
export const SCENARIO_START = { hour: 7, minute: 30 };

/** 바람(불어오는 방향). 정박·부이 계류 선박이 이 방향으로 선수를 둔다. */
export const WEATHER = { windFromDeg: 300, windKn: 14, windSwingDeg: 18, windPeriodH: 9, swellFromDeg: 110, swellM: 1.1 };

// ── 항로 노드 ────────────────────────────────────────────────────────────────
// CH*: 제1항로 중심선(울산항 항로 데이터 기준), IN*: 내항(태화강 하구) 진입로, TB12: SK1·2부두 선회장
// SEA_*: 시뮬레이션 영역 밖 외해 출입구. 동측은 입항(북쪽 차선)·출항(남쪽 차선)·부이 출항을 나눈다.
// lane: 진행 방향 오른쪽으로 비켜 가는 거리(m, 통항 분리). kn: 그 노드로 가는 구간 제한 속력.
export const NODES = {
  SEA_E: { x: 11500, y: -3800, label: '동측 외해 (입항)', kn: 12 },
  SEA_EO: { x: 11500, y: -4300, label: '동측 외해 (출항)', kn: 13 },
  SEA_EN: { x: 11500, y: -2900, label: '동측 외해 (부이 출항)', kn: 13 },
  OUT_E: { x: 3000, y: -4300, kn: 12 },
  BUOY_OUT: { x: 5000, y: -2900, kn: 10 },
  SEA_S: { x: 3500, y: -11500, label: '남측 외해', kn: 12 },
  PILOT: { x: 1600, y: -3950, label: '도선사 승선구역', kn: 9 },
  CH0: { x: 420, y: -3580, label: '제1항로 입구', lane: 70, kn: 9 },
  CH1: { x: 290, y: -2219, lane: 70, kn: 9 },
  CH2: { x: -281, y: -399, lane: 70, kn: 8 },
  CH3: { x: -462, y: 1331, lane: 70, kn: 7 },
  CH4: { x: -571, y: 2352, lane: 60, kn: 6 },
  J1: { x: -560, y: 1950, lane: 50, kn: 5 },
  IN1: { x: -1100, y: 3100, lane: 40, kn: 5 },
  IN2: { x: -1850, y: 3470, lane: 30, kn: 5 },
  IN3: { x: -2200, y: 3425, lane: 22, kn: 4 },
  IN4: { x: -2460, y: 3315, lane: 30, kn: 4 },
  TB12: { x: -2780, y: 3315, label: 'SK1·2부두 선회장', kn: 3 },
};

/** 예선 대기 위치(내항 동측 안벽, 선수 방향으로 일렬) */
export const TUG_BASE = { x: 500, y: 2350, headingDeg: 27, spacing: 45 };

/** 예선 이동 경로망(육지를 가로지르지 않도록 노드 사이로만 다닌다). BASE = TUG_BASE */
export const TUG_LINKS = [
  ['BASE', 'CH4'], ['BASE', 'CH3'], ['CH4', 'CH3'], ['CH3', 'CH2'], ['CH2', 'CH1'], ['CH1', 'CH0'], ['CH0', 'PILOT'],
  ['CH4', 'J1'], ['J1', 'CH3'], ['CH4', 'IN1'], ['IN1', 'IN2'], ['IN2', 'IN3'], ['IN3', 'IN4'], ['IN4', 'TB12'],
];

export const TUGS = [
  { id: 't1', name: 'HANBADA 1', bollardT: 60 },
  { id: 't2', name: 'HANBADA 2', bollardT: 60 },
  { id: 't3', name: 'HANBADA 3', bollardT: 65 },
  { id: 't5', name: 'HANBADA 5', bollardT: 70 },
  { id: 't7', name: 'HANBADA 7', bollardT: 70 },
  { id: 't8', name: 'HANBADA 8', bollardT: 55 },
];

// ── 시설 ─────────────────────────────────────────────────────────────────────
const P = (x, y) => ({ x, y });

const BANK_SK1 = { a: P(-3276, 3733), b: P(-3121.6, 3475.7) };
const BANK_SK2 = { a: P(-3179, 3444), b: P(-2943, 3096) };
const QUAY_SK35 = { a: P(-1500, 2727), b: P(-1137, 2149) };
const DOLPHIN_SK3 = { a: P(-1469.9, 2714), b: P(-1361.4, 2535.2) }; // SK3: 양 끝 돌출부(돌핀)에 선측을 댄다
const QUAY_SK5X = { a: P(-1137, 2149), b: P(-1024, 2022) };
const JETTY_X = -835;

/**
 * 선석: line(a→b) 위 s 미터 지점이 안벽 기준점. 선박은 a 쪽으로 선수를 두고 좌현 계류한다.
 * kind — quay: 안벽 / jetty: 해상 돌핀식 부두(플랫폼·돌핀·잔교를 그린다) / buoy: SPM 부이.
 * inbound  — 도선 구역부터 회합점 전까지 지나는 항로 노드.
 * rendezvous — 예선과 만나 보조 접안을 시작하는 곳:
 *   'behind'(선석 정횡 뒤쪽 접근선, preY 가 있으면 그 y 에서 접근선에 올라탐) | { offset: m }(정횡에서 바다 쪽) | 노드 id.
 * swing    — 이안 후 선회 지점: 노드 id | { normal: m }(안벽에서 바다 쪽) | { x }(같은 y 의 x 지점).
 * outbound — 선회 지점부터 외해 출구 전까지 노드.
 */
export const FACILITIES = [
  {
    id: 'SK1', label: 'SK 1부두', operator: 'SK가스㈜', cargo: 'LPG·유류', depth: 7.5, lengthM: 260,
    capacity: '5,000 DWT × 2', kind: 'quay',
    slots: [
      { id: 'SK1-1', line: BANK_SK1, s: 75, maxLoa: 112, maxDwt: 5000 },
      { id: 'SK1-2', line: BANK_SK1, s: 215, maxLoa: 112, maxDwt: 5000 },
    ],
    rendezvous: 'TB12',
    inbound: ['PILOT', 'CH0', 'CH1', 'CH2', 'CH3', 'CH4', 'IN1', 'IN2', 'IN3', 'IN4', 'TB12'],
    swing: 'TB12',
    outbound: ['IN4', 'IN3', 'IN2', 'IN1', 'CH4', 'CH3', 'CH2', 'CH1', 'CH0'],
  },
  {
    id: 'SK2', label: 'SK 2부두', operator: 'SK에너지㈜·SK가스㈜', cargo: '유류·LPG', depth: 8, lengthM: 580,
    capacity: '6,000 / 4,000 / 3,000 DWT', kind: 'quay',
    slots: [
      { id: 'SK2-1', line: BANK_SK2, s: 70, maxLoa: 112, maxDwt: 6000 },
      { id: 'SK2-2', line: BANK_SK2, s: 195, maxLoa: 105, maxDwt: 4000 },
      { id: 'SK2-3', line: BANK_SK2, s: 320, maxLoa: 95, maxDwt: 3000 },
    ],
    rendezvous: 'TB12',
    inbound: ['PILOT', 'CH0', 'CH1', 'CH2', 'CH3', 'CH4', 'IN1', 'IN2', 'IN3', 'IN4', 'TB12'],
    swing: 'TB12',
    outbound: ['IN4', 'IN3', 'IN2', 'IN1', 'CH4', 'CH3', 'CH2', 'CH1', 'CH0'],
  },
  {
    id: 'SK3', label: 'SK 3부두', operator: 'SK에너지㈜', cargo: '석유제품', depth: 12, lengthM: 130,
    capacity: '50,000 DWT', kind: 'quay',
    slots: [{ id: 'SK3', line: DOLPHIN_SK3, s: 104.5, maxLoa: 195, maxDwt: 50000 }],
    rendezvous: { offset: 150 },
    inbound: ['PILOT', 'CH0', 'CH1', 'CH2', 'CH3', 'J1'],
    swing: { normal: 380 },
    outbound: ['J1', 'CH3', 'CH2', 'CH1', 'CH0'],
  },
  {
    id: 'SK4', label: 'SK 4부두', operator: 'SK에너지㈜', cargo: '석유제품·케미컬', depth: 10, lengthM: 228,
    capacity: '10,000 / 4,000 DWT', kind: 'quay',
    slots: [
      { id: 'SK4-1', line: QUAY_SK35, s: 330, maxLoa: 130, maxDwt: 10000 },
      { id: 'SK4-2', line: QUAY_SK35, s: 455, maxLoa: 100, maxDwt: 4000 },
    ],
    rendezvous: { offset: 150 },
    inbound: ['PILOT', 'CH0', 'CH1', 'CH2', 'CH3', 'J1'],
    swing: { normal: 380 },
    outbound: ['J1', 'CH3', 'CH2', 'CH1', 'CH0'],
  },
  {
    id: 'SK5', label: 'SK 5부두', operator: 'SK에너지㈜', cargo: '석유제품·케미컬', depth: 11, lengthM: 798,
    capacity: '15,000 / 5,000 DWT', kind: 'quay',
    slots: [
      { id: 'SK5-1', line: QUAY_SK35, s: 590, maxLoa: 145, maxDwt: 15000 },
      { id: 'SK5-2', line: QUAY_SK5X, s: 85, maxLoa: 105, maxDwt: 5000, depth: 8 },
    ],
    rendezvous: { offset: 150 },
    inbound: ['PILOT', 'CH0', 'CH1', 'CH2', 'CH3', 'J1'],
    swing: { normal: 380 },
    outbound: ['J1', 'CH3', 'CH2', 'CH1', 'CH0'],
  },
  {
    id: 'SK6', label: 'SK 6부두', operator: 'SK에너지㈜', cargo: '석유제품·LPG', depth: 15, lengthM: 347,
    capacity: '70,000 DWT', kind: 'jetty',
    slots: [{ id: 'SK6', line: { a: P(JETTY_X, 2400), b: P(JETTY_X, 0) }, s: 2400 - 1720, maxLoa: 250, maxDwt: 70000 }],
    rendezvous: 'behind', preY: -700,
    inbound: ['PILOT', 'CH0', 'CH1'],
    swing: { x: -560 },
    outbound: ['CH2', 'CH1', 'CH0'],
  },
  {
    id: 'SK7', label: 'SK 7부두', operator: 'SK에너지㈜', cargo: '원유', depth: 15, lengthM: 370,
    capacity: '130,000 DWT', kind: 'jetty',
    slots: [{ id: 'SK7', line: { a: P(JETTY_X, 2400), b: P(JETTY_X, 0) }, s: 2400 - 1376, maxLoa: 270, maxDwt: 130000 }],
    rendezvous: 'behind', preY: -700,
    inbound: ['PILOT', 'CH0', 'CH1'],
    swing: { x: -560 },
    outbound: ['CH2', 'CH1', 'CH0'],
  },
  {
    id: 'SK8', label: 'SK 8부두', operator: 'SK에너지㈜', cargo: '원유', depth: 18, lengthM: 400,
    capacity: '150,000 DWT', kind: 'jetty',
    slots: [{ id: 'SK8', line: { a: P(JETTY_X, 2400), b: P(JETTY_X, 0) }, s: 2400 - 1010, maxLoa: 290, maxDwt: 150000 }],
    rendezvous: 'behind', preY: -700,
    inbound: ['PILOT', 'CH0', 'CH1'],
    swing: { x: -560 },
    outbound: ['CH2', 'CH1', 'CH0'],
  },
  {
    id: 'SKB2', label: 'SK 2부이', operator: 'SK에너지㈜', cargo: '원유', depth: 27, lengthM: null,
    capacity: '325,000 DWT (SPM)', kind: 'buoy', buoy: toLocal(35.4483, 129.4236),
    slots: [{ id: 'SKB2', maxLoa: 345, maxDwt: 325000 }],
  },
  {
    id: 'SKB3', label: 'SK 3부이', operator: 'SK에너지㈜', cargo: '원유', depth: 27, lengthM: null,
    capacity: '325,000 DWT (SPM)', kind: 'buoy', buoy: toLocal(35.44, 129.43),
    slots: [{ id: 'SKB3', maxLoa: 345, maxDwt: 325000 }],
  },
];

/**
 * 묘박지: 선박 크기(DWT)별 정박 위치. 울산항 E1(1만t 이하)·E2(3만t 이하)·E3(대형)·W1(2만t급).
 * via: 도선사 승선구역에서 묘박지로 갈 때 거치는 점(부이·항로를 피한다).
 */
export const ANCHORAGES = [
  { id: 'E1', label: 'E1 정박지', maxDwt: 10000, via: [P(1100, -2900)], spots: [P(1300, -1600), P(1900, -1050), P(3300, -1100), P(3900, -1800), P(4700, -2300)] },
  { id: 'W1', label: 'W1 정박지', maxDwt: 20000, via: [P(420, -3580), P(-500, -2600)], spots: [P(-932, -1698)] },
  { id: 'E2', label: 'E2 정박지', maxDwt: 30000, via: [], spots: [P(2600, -5100), P(4000, -5200), P(5400, -5100), P(3300, -5700)] },
  { id: 'E3', label: 'E3 정박지', maxDwt: Infinity, via: [], spots: [P(3600, -6600), P(5000, -6500), P(6400, -6200), P(4400, -7400)] },
];

// ── 선종 ─────────────────────────────────────────────────────────────────────
/** 모델·운동 특성. kind 는 3D 모델 형태, nomoto 는 무차원 조종성 지수(K', T') */
export const SHIP_CLASSES = {
  VLCC: { kr: '원유운반선 (VLCC)', kind: 'crude', nomoto: [1.1, 3.5], serviceKn: 15 },
  SUEZMAX: { kr: '원유운반선 (Suezmax)', kind: 'crude', nomoto: [1.15, 3.0], serviceKn: 14.5 },
  AFRAMAX: { kr: '원유운반선 (Aframax)', kind: 'crude', nomoto: [1.2, 2.8], serviceKn: 14.5 },
  LR1: { kr: '석유제품운반선 (LR1)', kind: 'product', nomoto: [1.25, 2.4], serviceKn: 14.5 },
  MR: { kr: '석유제품운반선 (MR)', kind: 'product', nomoto: [1.3, 2.2], serviceKn: 14 },
  PRODUCT_S: { kr: '석유제품운반선 (연안)', kind: 'product', nomoto: [1.5, 1.6], serviceKn: 12.5 },
  CHEM: { kr: '케미컬운반선', kind: 'chemical', nomoto: [1.45, 1.8], serviceKn: 13.5 },
  LPG_S: { kr: 'LPG운반선 (가압식)', kind: 'lpg', nomoto: [1.5, 1.6], serviceKn: 13.5 },
  VLGC: { kr: 'LPG운반선 (VLGC)', kind: 'vlgc', nomoto: [1.25, 2.4], serviceKn: 16.5 },
};

/** 선체 도장: [선체, 갑판, 연돌, 연돌 띠] */
const LIVERY = {
  navy: ['#1f2b3d', '#6f2a24', '#e9e6df', '#c62d2d'],
  black: ['#20211f', '#7a3324', '#d8b23a', '#1d1d1d'],
  green: ['#22433a', '#6b2f27', '#f0efe8', '#2f7d4f'],
  red: ['#7c1e1e', '#5b5f63', '#f0efe8', '#1f4e8c'],
  blue: ['#24497a', '#7a2f26', '#f2f2ee', '#f08a24'],
  grey: ['#4d5359', '#6b2a25', '#1f3c78', '#e7e7e7'],
  orange: ['#c4581f', '#5d6166', '#f2f2ee', '#2b2b2b'],
};

const ship = (id, name, cls, flag, dims, extra) => ({
  id, name, cls, flag,
  loa: dims[0], beam: dims[1], depth: dims[2], draftLaden: dims[3], draftBallast: dims[4], dwt: dims[5],
  ...extra,
});

/**
 * 가상 선단. home: 주로 이용하는 시설, op: discharge(양하)/load(선적), opHours: 하역 소요, awayHours: 출항 후 다시 올 때까지.
 * dims: [LOA, 폭, 형깊이, 만재흘수, 공선흘수, DWT]
 */
export const FLEET = [
  ship('v01', 'GRAND HALLA', 'VLCC', 'KR', [333, 60, 30.4, 22.4, 9.8, 318000],
    { mmsi: '440912001', imo: '9890011', callSign: 'D7HL', livery: LIVERY.navy, cargo: '원유 (Arab Medium)', home: 'SKB2', op: 'discharge', opHours: 32, awayHours: 40 }),
  ship('v02', 'PACIFIC ORCHID', 'VLCC', 'MH', [330, 60, 29.7, 21.6, 9.5, 306000],
    { mmsi: '538912002', imo: '9890023', callSign: 'V7OR2', livery: LIVERY.black, cargo: '원유 (Murban)', home: 'SKB3', op: 'discharge', opHours: 30, awayHours: 44 }),
  ship('v03', 'NOVA ARIRANG', 'SUEZMAX', 'KR', [274, 48, 23.2, 17.0, 7.8, 158000],
    { mmsi: '440912003', imo: '9890035', callSign: 'D7NA', livery: LIVERY.green, cargo: '원유 (Basrah Medium)', home: 'SK8', op: 'discharge', opHours: 24, awayHours: 30 }),
  ship('v04', 'CORAL BAY SPIRIT', 'SUEZMAX', 'LR', [275, 48, 23.1, 16.8, 7.6, 157000],
    { mmsi: '636912004', imo: '9890047', callSign: 'D5CB4', livery: LIVERY.blue, cargo: '원유 (CPC Blend)', home: 'SK8', op: 'discharge', opHours: 22, awayHours: 34 }),
  ship('v05', 'OCEAN CAMELLIA', 'AFRAMAX', 'PA', [250, 44, 21.0, 13.9, 7.0, 115000],
    { mmsi: '352912005', imo: '9890059', callSign: '3E2C5', livery: LIVERY.red, cargo: '원유 (ESPO)', home: 'SK7', op: 'discharge', opHours: 20, awayHours: 28 }),
  ship('v06', 'EASTERN PHOENIX', 'AFRAMAX', 'SG', [249, 44, 21.0, 14.0, 7.0, 114000],
    { mmsi: '563912006', imo: '9890061', callSign: '9V2P6', livery: LIVERY.grey, cargo: '원유 (Upper Zakum)', home: 'SK7', op: 'discharge', opHours: 20, awayHours: 30 }),
  ship('v07', 'BLUE MAGPIE', 'LR1', 'KR', [228, 32.2, 20.6, 14.0, 6.5, 72800],
    { mmsi: '440912007', imo: '9890073', callSign: 'D7BM', livery: LIVERY.navy, cargo: '경유 (선적)', home: 'SK6', op: 'load', opHours: 18, awayHours: 26 }),
  ship('v08', 'JADE HORIZON', 'LR1', 'HK', [228, 32.2, 20.5, 13.6, 6.4, 73000],
    { mmsi: '477912008', imo: '9890085', callSign: 'VRJH8', livery: LIVERY.green, cargo: '나프타 (양하)', home: 'SK6', op: 'discharge', opHours: 16, awayHours: 30 }),
  ship('v09', 'POLAR ARIES', 'VLGC', 'PA', [230, 36.6, 22.0, 11.6, 7.4, 54000],
    { mmsi: '352912009', imo: '9890097', callSign: '3E2P9', livery: LIVERY.orange, cargo: 'LPG (프로판·부탄)', home: 'SK6', op: 'discharge', opHours: 20, awayHours: 36 }),
  ship('v10', 'STELLA KOREA', 'MR', 'KR', [183, 32.2, 19.1, 12.2, 6.0, 49999],
    { mmsi: '440912010', imo: '9890102', callSign: 'D7SK', livery: LIVERY.blue, cargo: '휘발유 (선적)', home: 'SK3', op: 'load', opHours: 14, awayHours: 22 }),
  ship('v11', 'HANA VOYAGER', 'MR', 'KR', [183, 32.2, 19.0, 12.0, 6.0, 49800],
    { mmsi: '440912011', imo: '9890114', callSign: 'D7HV', livery: LIVERY.red, cargo: '항공유 (선적)', home: 'SK3', op: 'load', opHours: 14, awayHours: 24 }),
  ship('v12', 'HANA CHEMI', 'CHEM', 'KR', [144, 23, 12.8, 9.0, 4.6, 19900],
    { mmsi: '440912012', imo: '9890126', callSign: 'D7HC', livery: LIVERY.grey, cargo: '파라자일렌 (선적)', home: 'SK3', op: 'load', opHours: 12, awayHours: 26 }),
  ship('v13', 'DONGBANG PETRO 7', 'PRODUCT_S', 'KR', [128, 20, 10.5, 7.6, 3.8, 12000],
    { mmsi: '440912013', imo: '9890138', callSign: 'D7DP', livery: LIVERY.black, cargo: '벙커C유 (선적)', home: 'SK5', op: 'load', opHours: 8, awayHours: 18 }),
  ship('v14', 'BLUE IRIS', 'CHEM', 'KR', [119, 19.6, 10.2, 8.0, 4.0, 12500],
    { mmsi: '440912014', imo: '9890140', callSign: 'D7BI', livery: LIVERY.blue, cargo: '벤젠 (선적)', home: 'SK5', op: 'load', opHours: 9, awayHours: 20 }),
  ship('v15', 'MIRAE CHEM 2', 'CHEM', 'KR', [99, 16, 8.4, 6.6, 3.4, 7000],
    { mmsi: '440912015', imo: '9890152', callSign: 'D7MC', livery: LIVERY.green, cargo: '톨루엔 (선적)', home: 'SK4', op: 'load', opHours: 7, awayHours: 16 }),
  ship('v16', 'GEUMGANG 5', 'PRODUCT_S', 'KR', [80, 12.8, 6.4, 5.2, 2.6, 3400],
    { mmsi: '440912016', imo: '9890164', callSign: 'D7GG', livery: LIVERY.orange, cargo: '경유 (선적)', home: 'SK4', op: 'load', opHours: 6, awayHours: 12 }),
  ship('v17', 'SEOHAE 3', 'PRODUCT_S', 'KR', [99, 16, 8.2, 6.4, 3.2, 3000],
    { mmsi: '440912017', imo: '9890176', callSign: 'D7SH', livery: LIVERY.red, cargo: '등유 (선적)', home: 'SK2', op: 'load', opHours: 6, awayHours: 14 }),
  ship('v18', 'HAN RIVER 11', 'PRODUCT_S', 'KR', [89, 14, 7.0, 5.6, 2.8, 4300],
    { mmsi: '440912018', imo: '9890188', callSign: 'D7HR', livery: LIVERY.navy, cargo: '경유 (선적)', home: 'SK2', op: 'load', opHours: 6, awayHours: 14 }),
  ship('v19', 'DAEYANG GAS', 'LPG_S', 'KR', [99, 17, 8.6, 6.2, 4.4, 4800],
    { mmsi: '440912019', imo: '9890190', callSign: 'D7DG', livery: LIVERY.grey, cargo: 'LPG 부탄 (양하)', home: 'SK1', op: 'discharge', opHours: 8, awayHours: 20 }),
  ship('v20', 'HALLA LPG', 'LPG_S', 'KR', [105, 17.6, 9.0, 6.5, 4.6, 5800],
    { mmsi: '440912020', imo: '9890205', callSign: 'D7HG', livery: LIVERY.green, cargo: 'LPG 프로판 (양하)', home: 'SK2', op: 'discharge', opHours: 8, awayHours: 22 }),
  ship('v21', 'SUNRISE GAS 2', 'LPG_S', 'KR', [96, 16, 8.4, 6.0, 4.2, 4300],
    { mmsi: '440912021', imo: '9890217', callSign: 'D7SG', livery: LIVERY.orange, cargo: 'LPG 프로판 (선적)', home: 'SK1', op: 'load', opHours: 7, awayHours: 18 }),
];

/**
 * 07:30 시작 상태.
 *  moored   — slot 에 계류 중, progress(0~1) 만큼 하역 진행. phase: 'cargo'(하역 중) | 'done'(하역 완료, 출항 준비)
 *  anchored — 묘박지 대기(waitFor 시설 대기열에 등록)
 *  inbound  — at 위치에서 시설로 접근 중(speedKn)
 *  outbound — at 위치에서 외해로 나가는 중
 *  away     — 항외. arriveInH 시간 뒤 entry 에서 입항
 */
export const INITIAL = [
  { ship: 'v01', state: 'moored', slot: 'SKB2', progress: 0.55 },
  { ship: 'v02', state: 'inbound', at: P(8200, -3850), headingDeg: 272, speedKn: 11 },
  { ship: 'v03', state: 'moored', slot: 'SK8', progress: 0.8 },
  { ship: 'v04', state: 'anchored', anchorage: 'E3', spot: 1 },
  { ship: 'v05', state: 'moored', slot: 'SK7', progress: 1, phase: 'done', departInMin: 12 },
  { ship: 'v06', state: 'anchored', anchorage: 'E3', spot: 0 },
  { ship: 'v07', state: 'inbound', at: P(330, -2700), headingDeg: 355, speedKn: 8 },
  { ship: 'v08', state: 'away', arriveInH: 9, entry: 'SEA_S' },
  { ship: 'v09', state: 'away', arriveInH: 5.5, entry: 'SEA_E' },
  { ship: 'v10', state: 'moored', slot: 'SK3', progress: 0.35 },
  { ship: 'v11', state: 'away', arriveInH: 2.5, entry: 'SEA_E' },
  { ship: 'v12', state: 'away', arriveInH: 15, entry: 'SEA_S' },
  { ship: 'v13', state: 'moored', slot: 'SK5-1', progress: 0.6 },
  { ship: 'v14', state: 'away', arriveInH: 3.5, entry: 'SEA_S' },
  { ship: 'v15', state: 'moored', slot: 'SK4-1', progress: 0.5 },
  { ship: 'v16', state: 'moored', slot: 'SK4-2', progress: 0.2 },
  { ship: 'v17', state: 'outbound', at: P(-420, 900), headingDeg: 172, speedKn: 7, exit: 'SEA_S' },
  { ship: 'v18', state: 'moored', slot: 'SK2-1', progress: 1, phase: 'done', departInMin: 35 },
  { ship: 'v19', state: 'moored', slot: 'SK1-1', progress: 0.4 },
  { ship: 'v20', state: 'inbound', at: P(2600, -7600), headingDeg: 335, speedKn: 11 },
  { ship: 'v21', state: 'away', arriveInH: 1.5, entry: 'SEA_S' },
];

// ── 2D 지도(PortWise 형식 화면)용 보조 목업 ─────────────────────────────────

/** 시설 대표 좌표(지도 마커). 부이 2기는 공개 좌표가 없어 근사값 */
export const FACILITY_POS = {
  SK1: { lat: 35.5027, lng: 129.3632 },
  SK2: { lat: 35.4986, lng: 129.3658 },
  SK3: { lat: 35.4946, lng: 129.3829 },
  SK4: { lat: 35.4927, lng: 129.3842 },
  SK5: { lat: 35.4892, lng: 129.3863 },
  SK6: { lat: 35.4855, lng: 129.3907 },
  SK7: { lat: 35.4824, lng: 129.3907 },
  SK8: { lat: 35.4791, lng: 129.3906 },
  SKB2: { lat: 35.4483, lng: 129.4236, approx: true },
  SKB3: { lat: 35.44, lng: 129.43, approx: true },
};

/** 가상 항차: [직전 항구, 다음 항구] */
export const VOYAGES = {
  v01: ['RAS TANURA', 'RAS TANURA'], v02: ['RUWAIS', 'FUJAIRAH'], v03: ['BASRAH', 'SINGAPORE'],
  v04: ['NOVOROSSIYSK', 'SINGAPORE'], v05: ['KOZMINO', 'KOZMINO'], v06: ['FUJAIRAH', 'SINGAPORE'],
  v07: ['YEOSU', 'SINGAPORE'], v08: ['SINGAPORE', 'KAOHSIUNG'], v09: ['HOUSTON', 'NINGBO'],
  v10: ['DAESAN', 'TOKYO'], v11: ['YEOSU', 'SYDNEY'], v12: ['DAESAN', 'ZHANGJIAGANG'],
  v13: ['BUSAN', 'BUSAN'], v14: ['YEOSU', 'SHANGHAI'], v15: ['ONSAN', 'DALIAN'],
  v16: ['MOKPO', 'POHANG'], v17: ['INCHEON', 'GWANGYANG'], v18: ['BUSAN', 'POHANG'],
  v19: ['PYEONGTAEK', 'PYEONGTAEK'], v20: ['YEOSU', 'INCHEON'], v21: ['BUSAN', 'MOKPO'],
};
