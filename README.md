# SK 울산 액체부두 · 선박운항 정보공유

울산항만공사 [PortWise 선박운항 정보공유 서비스](https://www.upa.or.kr/portwise/vsl/)의 화면 구성(전체화면 지도, 하단 도크 메뉴, 선박 카드, 기상·해운·해무 패널)을 재현하고, 범위를 **SK 1~8부두와 SK 2·3부이**, 그리고 **유류·케미칼·가스 운반선**으로 좁힌 버전이다.

## 실행

```bash
cd sk-portwise
npm start            # 의존성 없음, Node 20+
# http://127.0.0.1:5050  (PORT, HOST 환경변수로 변경)
```

브라우저는 업스트림을 직접 부르지 않는다. 업스트림이 CORS를 허용하지 않기 때문에 `server.js`가 PortWise 공개 엔드포인트를 서버에서 호출하고, 결과를 캐시해 `/api/*`로 내려준다. 로그인이 필요 없는 엔드포인트만 쓴다.

### GitHub Pages (정적 스냅샷)

공개 페이지: https://minkyu-k530.github.io/sk-portwise/

Pages는 서버 코드를 실행할 수 없다. 그래서 `.github/workflows/pages.yml`이 10분마다(그리고 `main`에 push할 때마다) `scripts/build-static.js`를 실행한다. 이 스크립트는 `/api/*` 응답을 `data/*.json`으로 저장하고, `public/`과 함께 Pages에 배포한다. 화면은 `index.html`에 들어간 `<meta name="skpw-mode" content="static">` 태그를 보고 `data/` 아래 파일을 읽는다.

- 데이터는 몇 분씩 늦다. GitHub의 cron 실행은 자주 몇 분 밀리고, 헤더에 "(스냅샷)"과 기준 시각을 표시한다.
- 선박 상세는 모든 선박을 저장한다. 항적은 응답이 커서 SK 시설에 접안한 선박만 저장하고, 나머지 선박은 카드의 "항해경로 표시하기" 버튼이 비활성화된다.
- 혼잡 예보(오늘·내일 × 23시간)는 Actions 캐시에 두고 KST 06시 전/후 단위로만 새로 받는다.
- 처음 한 번은 저장소 관리자가 Settings → Pages → Source를 **GitHub Actions**로 설정해야 한다.
- 공개 저장소에서 60일 동안 활동이 없으면 GitHub이 예약 실행을 자동으로 멈춘다. 그때는 Actions 탭에서 다시 켜면 된다.

로컬에서 정적 빌드를 확인하려면 `node scripts/build-static.js dist`를 실행한 뒤 `dist/`를 아무 정적 서버로 연다.

## 화면

| 메뉴 | 내용 |
|---|---|
| GIS Monitoring | 지도(OSM)·스카이뷰(Esri)·전자해도(OpenSeaMap 항로표지), 거리 측정, 선박 검색, 좌표 표시 |
| 선박필터 | 내항·외항, 선종(TANKER / GENERAL·CRUDE·PRODUCT·CHEMICALS TANKER / GAS·LNG CARRIER), SK 시설 접안 선박만 보기, 조선소 시운전·계선 선박 포함 여부 |
| 지도설정 | SK 부두·부이, 정박지, 항로, 보고선, 도선 승선구역, 선박명, COG 벡터, 선박 색상 기준(목적지 / 화물군) |
| 기상 | 해양기상, 대기오염, 육상기상(울산본항·신항·온산항), 파고 |
| 해운 | 해상운임지수(SCFI·CCFI·BDI), 국제유가(WTI·Brent·Dubai) |
| 접안시설 | SK 10개 시설의 제원과 접안 척수. 누르면 지도에서 해당 시설로 이동 |
| 해무 | 울산항 1·3·6시간 후 해무 발생확률 |
| 혼잡도 | 해양교통 혼잡 예보 격자 |
| 라이브맵 | 표시 중인 선박을 항행상태별로 집계 |
| SK 부두 현황 | 시설별 제원, AIS 기준 접안 중인 선박, PORT-MIS 시설사용 신청·배정·사용 내역 |
| 입항·접안 선박 | 선박 목록(정렬, 검색, 화물군 필터, SK 접안만, 울산행만) |

선박을 누르면 선박 카드가 열린다. 카드에는 국적, MMSI·IMO·호출부호, 선종, 항행상태, 제원, 목적지·ETA, 항차·시설 사용시간, PORT-MIS 진행상태, 항해경로(오늘 / 이전 항적)가 나온다.

## 데이터 출처 (PortWise 중계)

| `/api` | PortWise 엔드포인트 | 원 출처 | 캐시 |
|---|---|---|---|
| `/vessels` | `getAisListOnTheMap.do` + `getArrivalVesselList.do` | 해양수산부 AIS(T-AIS/S-AIS), PORT-MIS | 30s / 60s |
| `/facilities` | `getWharf.do` + 위 두 엔드포인트 | UPA 접안시설 제원, PORT-MIS | 24h |
| `/vessels/:mmsi/detail` | `getVesselDetailInfo.do` | PORT-MIS | 없음 |
| `/vessels/:mmsi/route` | `getVoyageRoute.do` | AIS 항적 | 없음 |
| `/weather` | `getWeatherList.do`, `getSeaWaveHeightApiData.do` | 국립해양조사원, 한국환경공단, 기상청 | 5m |
| `/seafog` | `getSeaFogProbability.do` | 해양수산부 해무 예측 | 10m |
| `/shipping` | `getFreightIndex.do`, `getInternationalOilPrice.do` | 공공데이터포털, oilpriceapi | 30m |
| `/congestion?date=YYYYMMDD&time=HHMM` | `getSeaTfcCongstFcst.do` | 해양교통 혼잡 예보 | 30m |
| `/layers/{anchorage,route,reporting,pilot}` | `getAnchorage.do` 등 | UPA 시설정보 | 24h |

업스트림 호출이 실패해도 직전 값이 캐시에 남아 있으면 그 값을 계속 내려준다. 이때 응답에 `stale: true`가 붙고, 헤더에 "(지연)"이 표시된다.

## 선박을 고르는 규칙 (`lib/sk.js`)

- 표시 대상은 PortWise `vsslTp`가 탱커 계열이거나 `GAS_CARRIER`·`LNG_CARRIER`인 선박이다. 선종이 비어 있으면 AIS 선종코드 80–89(탱커)도 포함한다.
- 선종이 미분류(`NOT_AVAILABLE`, `OTHER`)여도 SK 시설에 접안해 있으면 `미분류(SK 시설 내)`로 표시한다.
- 어느 SK 시설인지는 PortWise 위치시설명(예: `SK2부두 4선석`)과 PORT-MIS 시설명·코드(예: `SK1부두 12`, `MDU-08`)에서 정한다. 위치시설명이 없고 계류 중인 선박은 시설 좌표 근처(부두 250 m, 부이 600 m)에 있으면 `근접 추정`으로 배정한다.
- 목적지가 시운전(S/T, SEA TRIAL)이나 계선(LAY UP)인 조선소 신조선에는 `shipyard: true`가 붙는다. 화면에서는 기본으로 숨기고, 선박필터에서 다시 켤 수 있다.

## 알려진 한계

- **SK 2·3부이 좌표는 근사값이다.** PortWise는 두 부이의 좌표를 `0,0`으로 내려주고, 공개된 정확한 좌표도 찾지 못했다(UPA 재난안전 포털에는 "용잠동 해상"으로만 나온다). 그래서 지도에 점선과 "위치 근사" 표시를 붙였다. 정확한 좌표는 `lib/sk.js`의 `SK_FACILITIES`에서 `lat`/`lng`을 고치고 `approx: false`로 바꾸면 된다.
- 비공식 중계 방식이다. PortWise 내부 엔드포인트가 바뀌면 이 앱도 깨진다. 운영 용도로 쓰려면 울산항만공사 개방데이터 포털이나 공공데이터포털(data.go.kr)의 정식 API와 이용 승인으로 바꿔야 한다. PortWise 약관은 무단 복제·자동화 수집을 제한한다.
- 원본 화면에 있는 로그인, 관심선박, 알림, 하역관리, 대기시간 예측은 로그인 사용자 전용 기능이라 넣지 않았다.
