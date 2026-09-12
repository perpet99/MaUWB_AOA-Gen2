# webassistant — MaUWB AOA 웹 상위기 (Node + React)

[`pyassistant`](../pyassistant/)의 Node + React 포팅입니다. 같은 규격서
(「久凌 AOA 通信协议」, 久凌(温州)电子科技有限公司, 2025-03-24)를 따르며, 같은
바이너리 프로토콜을 디코딩합니다.

Python 판이 matplotlib 창을 띄운다면, 이쪽은 **브라우저에서 열리는 실시간 뷰어**입니다.
Node 프로세스가 시리얼 포트를 쥐고, 여러 브라우저가 같은 스트림을 동시에 구독합니다.

```
┌─ 기지국 ─┐   UART/TCP    ┌─ @mauwb/server ─┐   WebSocket   ┌─ @mauwb/web ─┐
│  AOA 앵커 │ ────────────▶ │ FrameStream     │ ─────────────▶│ React 뷰어    │
└──────────┘   0x2A…0x23   │ CSV / raw 로거   │   JSON 배치    └──────────────┘
                            └─────────────────┘
                                     ▲
                            @mauwb/protocol (양쪽 공용 코덱)
```

---

## 무엇이 들어 있나

| 패키지 | 설명 |
|---|---|
| `packages/protocol` | **isomorphic 코덱.** 프레임 파싱·생성, XOR 체크섬, `tag_detail_para` 비트필드, 리싱크 스트림, 설정 명령 빌더, CSV 스키마, 차트 토큰. Node·브라우저 양쪽에서 같은 코드가 돕니다 |
| `packages/server` | 시리얼 / TCP / 파일 리플레이 트랜스포트, 세션 관리, REST + WebSocket, CSV·원시 로거, 합성 캡처 생성기 |
| `packages/web` | React 19 + Vite 실시간 뷰어 (극좌표 + 직교좌표 SVG, 태그 테이블, 프레임 로그, 명령 패널) |

| 소스 | 하는 일 |
|---|---|
| `protocol/src/protocol.ts` | 프레임 정의·파싱·생성 (`pyassistant/mauwb/protocol.py` 대응) |
| `protocol/src/stream.ts` | UART 스트림에서 프레임 추출, 자동 리싱크 (`stream.py`) |
| `protocol/src/wire.ts` | JSON 안전 DTO + REST/WS 메시지 계약 (Python 판에 없음) |
| `protocol/src/commands.ts` | 기지국·태그·정비(整机) 설정 명령 (`commands.py`) |
| `protocol/src/csv.ts` | CSV 컬럼·행 변환 (`logging_.py`의 스키마 부분) |
| `protocol/src/theme.ts` | 차트 색상 토큰 (`theme.py`) |
| `server/src/transport.ts` | 시리얼 / TCP / 파일 (`transport.py`) |
| `server/src/session.ts` | 링크 1개를 여러 구독자에게 중계 (Python 판의 `Reader` 스레드 대응) |
| `server/src/sample.ts` | 하드웨어 없이 테스트할 합성 캡처 (`tools/make_sample.py`) |
| `protocol/test/protocol.test.ts` | 규격서 예제 프레임 기준 단위 테스트 33개 (`tests/test_protocol.py`) |

---

## 설치와 실행

```bash
cd webassistant
npm install
```

Node 20.11 이상이 필요합니다. `serialport`는 네이티브 모듈이라 **optional
dependency**로 선언돼 있습니다 — 설치에 실패해도 TCP·파일 리플레이는 그대로
동작합니다 (Python 판에서 `pyserial`이 선택 사항인 것과 같습니다).

### 하드웨어 없이 먼저 돌려보기

```bash
npm run sample -- samples/demo.bin --tags 3 --seconds 20 --garbage
npm run build
npm start
```

브라우저에서 <http://127.0.0.1:8787> 을 열고 source에 `file://samples/demo.bin`
을 넣은 뒤 Connect를 누르면 됩니다. `--garbage`는 쓰레기 바이트를 섞어 넣어
리싱크 경로를 실제로 태워 봅니다 (상태바의 `resyncs`가 올라갑니다).

### 개발 모드

```bash
npm run dev



```

서버는 `:8787`, Vite 개발 서버는 `:5173`에 뜹니다. Vite가 `/api`와 `/ws`를
서버로 프록시하므로 브라우저는 <http://127.0.0.1:5173> 만 열면 됩니다.

서버에 연결된 Raspberry Pi CSI 카메라는 우측 `camera` 패널에서 `Start`를
누르면 MJPEG로 표시됩니다. 기본 장치는 `rpicam-vid`를 사용하는 CSI 카메라입니다.
USB/V4L2 카메라를 사용할 때는 다음처럼 백엔드를 바꿉니다:

```bash
CAMERA_BACKEND=ffmpeg CAMERA_DEVICE=/dev/video2 ./run_external.sh
```

해상도와 프레임 레이트는 `CAMERA_WIDTH`, `CAMERA_HEIGHT`, `CAMERA_FPS` 환경변수로
조정할 수 있습니다. 카메라 스트림 주소는 `/camera.mjpeg`입니다.

### 실제 장비에 연결

source 입력란에 다음 중 하나를 넣습니다.

| 입력 | 의미 |
|---|---|
| `COM7`, `/dev/ttyUSB0` | USB-UART 시리얼 포트 |
| `tcp://192.168.1.50:8888` | 시리얼-이더넷 브리지 |
| `file://capture.bin` | 원시 캡처 리플레이 |

`ports` 버튼으로 시리얼 포트를 다시 스캔합니다. 공장 기본값은 115200 8N1이고,
높은 슬롯 레이트에서는 921600을 씁니다.

---

## ⚠️ 먼저 확인할 것: 상위기 보고 형식

기지국의 `setcfg` **7번째 인자**가 상위기 보고 형식(上报格式)입니다.

| 값 | 형식 |
|---|---|
| **0** | **통용(通用) — 이 도구가 파싱하는 바이너리 프로토콜** |
| 1 | JSON |
| 2 | 소형차 추종 형식 |
| 3 | 소형차 측위 형식 |

**반드시 0 이어야 합니다.** 프레임이 하나도 안 잡히면 십중팔구 이 값이 0이
아닙니다. 오른쪽 `config commands` 패널에서:

```
anchor  getcfg                      # 현재 설정 확인
anchor  setcfg 1 1 1111 1 100 1 0   # 마지막 인자가 0
anchor  saver                       # 저장 후 재부팅
```

Send 전에 **Dry run**을 누르면 링크를 건드리지 않고 만들어질 프레임 바이트만
보여줍니다. 동작 중인 기지국에 `setcfg`를 잘못 보내면 스트림이 끊기므로, 인자가
확실하지 않으면 먼저 dry run을 하세요.

---

## 모바일에서 보기

`webassistant`는 서버가 링크를 쥐고 브라우저가 붙는 구조라, 같은 네트워크의
폰에서 바로 열 수 있습니다.

```bash
HOST=0.0.0.0 npm start      # 폰에서 http://<PC의 IP>:8787
```

760px 이하 화면에서는 레이아웃이 한 열로 접히고, 두 차트가 **각자의 종횡비를
그대로 패널에 적용**받아 화면 폭을 남김없이 씁니다. 차트 라벨·마커는 뷰박스
단위라 축소되면 같이 작아지므로, 이 구간에서는 1.9배로 키워 렌더합니다
(±90° 기준 라벨 6.5px → 12.1px).

차트 높이에는 **220px 바닥값**이 걸려 있어 어떤 FOV에서도 그보다 낮아지지
않습니다. 이 값이 실제로 작동하는 건 ±90° 부근뿐인데, 반원이라 폭에 묶여 남는
높이가 위아래 여백으로 남습니다. FOV가 좁아지면 종횡비 쪽이 더 커져서 바닥값을
넘고 여백 없이 전부 쓰입니다 (390px 폭 기준 ±90° 220px, ±45° 268px).

패널 헤더의 **⤢** 버튼을 누르면 해당 차트가 화면 전체로 확대됩니다 (Esc로 복귀).
세로 화면에서 ±90° 쐐기는 반원이라 높이가 폭의 절반으로 묶이므로, 가장 크게
보려면 **가로로 눕히고 확대**하거나 FOV를 좁히세요 — ±45°는 종횡비가 1.39라
세로 화면에서도 훨씬 큽니다.

---

## 경로와 접근 범위

캡처·CSV·`file://` 경로의 **상대 경로는 항상 `webassistant/` 디렉터리 기준**입니다.
`npm start`(cwd가 `packages/server`), `node packages/server/dist/index.js`(cwd가
워크스페이스 루트), 브라우저 입력란(cwd 자체가 없음) — 이 세 진입점이 같은 곳을
가리키게 하려고 `MAUWB_DATA_ROOT`로 고정해 뒀습니다. 절대 경로는 그대로 씁니다.

```bash
MAUWB_DATA_ROOT=/srv/uwb npm start   # 기준 디렉터리 바꾸기
HOST=0.0.0.0 PORT=9000 npm start     # 바인딩 주소·포트 바꾸기
```

서버는 기본적으로 **127.0.0.1** 에만 바인딩합니다. REST로 임의 경로에 파일을
쓸 수 있으므로(CLI 도구와 같은 신뢰 모델입니다) `HOST=0.0.0.0`으로 외부에 열
때는 신뢰할 수 있는 네트워크에서만 쓰세요.

---

## 프로토콜 요약

모든 다중 바이트 필드는 **리틀엔디언**(低位在前)입니다.

### 공통 프레임 구조

```
off  size  field
0    1     head        0x2A
1    2     cmd_len     bytes[3 : 3+cmd_len] 의 길이
3    8     cmd_saddr   자신의 긴 주소
11   8     cmd_daddr   상대의 긴 주소
19   1     cmd_type
20   1     cmd_direct
21   *     payload
*    1     check       XOR of bytes[3 : 3+cmd_len]
*    1     foot        0x23
```

전체 길이 = `cmd_len + 5`.

### cmd_type

| 값 | 의미 | 길이 |
|---|---|---|
| 0x01 | 基站定位帧 — 측위 보고 | 81 |
| 0x02 | 基站配置帧 — 기지국 설정 | 가변 |
| 0x03 | 标签配置帧 — 태그 설정 | 가변 |
| 0x04 | OTA 升级帧 | 가변 |
| 0x05 | 整机配置帧 — 정비 설정 | 가변 |
| 0x64 | 基站定位帧 RSSI | 89 |

### cmd_direct

`1` 引擎请求 · `2` 设备回复 · `3` 设备请求 · `4` 引擎回复 · `5` 引擎上报 · `6` 设备上报
("引擎(엔진)"이 PC 쪽입니다.) 실제 기지국 보고 프레임은 **5**를 싣습니다.

**0x64(RSSI) 프레임은** 각 기지국의 거리 뒤에 `int16` RSSI가 하나씩 끼어들어,
오프셋 31 이후가 8바이트씩 밀립니다. 그래서 전체 길이가 89바이트입니다.

자세한 필드 표는 [`pyassistant/README.md`](../pyassistant/README.md)와
`packages/protocol/src/protocol.ts` 상단 주석에 있습니다.

---

## API

### REST

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/ports` | 시리얼 포트 목록 |
| GET | `/api/status` | 현재 세션 상태 |
| POST | `/api/connect` | `{spec, baud?, speed?, loop?, verify?}` |
| POST | `/api/disconnect` | 링크 닫기 |
| POST | `/api/send` | `{target, command, saddr?, daddr?, dryRun?}` |
| POST | `/api/decode` | `{hex, verify?}` — 붙여넣은 hex 한 프레임 디코딩 |
| GET | `/api/commands` | 문서화된 명령 카탈로그 |
| POST | `/api/preview/:target/:command` | 타입 검증된 인자 → ASCII 명령 미리보기 |
| POST | `/api/log/csv` · `/api/log/raw` | `{path}` 시작 / `{enable:false}` 중지 |
| POST | `/api/sample` | 합성 캡처 생성 |

### WebSocket (`/ws`)

서버 → 클라이언트: `hello` · `frames`(50 ms 배치) · `state` · `notice`
클라이언트 → 서버: `ping` · `setIncludeRaw`

프레임을 개별 메시지가 아니라 50 ms 배치로 보냅니다. 10 ms 슬롯에 태그 4개면
초당 400프레임인데, 배치로는 초당 20메시지지만 개별 전송이면 400번의 소켓 쓰기가
됩니다.

---

## 테스트

```bash
npm test
```

33개 테스트가 규격서 [备注 6：基站定位帧示例]의 예제 프레임을 기준으로
오프셋·엔디언·체크섬을 검증하고, `FrameStream`이 쓰레기 바이트·중간 진입·
체크섬 깨진 프레임에서 복구하는지 확인합니다.

### 규격서의 알려진 오기 두 가지

1. **`0xFFF9 = -6°`** — 예제 프레임 해설의 산술 오류입니다. 2의 보수로는 **-7**이고,
   테스트는 바이트를 기준으로 -7을 단정합니다.
2. **`cmd_direct` 열거** — 차량 펌웨어(`uwb.h`의 `Cmd_Direct_e`)는 0부터 시작해
   규격서(1부터)와 1씩 어긋납니다. 이 코덱은 규격서를 따릅니다.

같은 이유로 `angle_dir`은 **uint8_t**입니다 (규격서 index 73 / RSSI 81).
차량 펌웨어는 이를 uint16으로 잡아 구조체가 1바이트 큽니다.

---

## pyassistant와 달라진 점

| | pyassistant | webassistant |
|---|---|---|
| 실행 | CLI + matplotlib 창 | Node 프로세스 + 브라우저 |
| 동시 뷰어 | 1개 (포트를 직접 점유) | 여러 개 (서버가 중계) |
| 코덱 | Python 전용 | Node·브라우저 공용 TypeScript |
| I/O 모델 | 블로킹 `read` + 리더 스레드 | 이벤트 기반 `data` + 배치 플러시 |
| 차트 | matplotlib polar/cartesian | SVG (의존성 없음), 라이트/다크 대응 |
| CSV | 서버 측만 | 서버 측 + 브라우저 버퍼 내보내기 |

프레임 포맷·체크섬·비트필드·명령 집합은 동일합니다. 한쪽이 기록한 `.bin`
캡처를 다른 쪽이 그대로 리플레이할 수 있고, CSV 컬럼도 같습니다.

---

## 라이선스

MIT. 규격서 자체는 久凌(温州)电子科技有限公司의 문서이며, 이 저장소는 그 규격만
보고 새로 구현한 것입니다.
