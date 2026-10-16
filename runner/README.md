# Binance / Bitget PC 계좌 조회 실행기

현재 실행기는 **조회 전용**입니다. 여러 계좌를 별도 프로세스로 동시에 조회할 수 있지만 자동 주문·실제 체결 기록 수집·계좌별 전략 실행은 아직 지원하지 않습니다.

## 준비

1. Python 3.11 이상 설치: `python -m pip install -r runner/requirements.txt`.
2. Supabase SQL `001`, `002`, `003`을 순서대로 실행합니다. 기존 `001`, `002` 실행이 끝났다면 `003_exchange_accounts.sql`만 추가합니다.
3. 사이트 비밀번호로 접속 → 연결 설정 → 계좌 이름·거래소·유형·환경을 선택해 계좌 추가.
4. 해당 계좌를 선택하고 연결 토큰 발급. 화면에 계좌 ID, 24시간 만료 토큰, 실행기 옵션이 표시됩니다.

지원 유형:

| 거래소 | `--exchange` | `--account-type` | `--mode testnet` |
| --- | --- | --- | --- |
| 바이낸스 USDT 선물 | `binance` | `futures` | Binance Futures 테스트넷 |
| 비트겟 일반 선물 | `bitget` | `classic` | 비트겟 모의계좌 키 + `paptrading: 1` |
| 비트겟 통합계정 | `bitget` | `uta` | 비트겟 모의계좌 키 + `paptrading: 1` |

거래소 계정과 맞는 유형을 직접 선택합니다. 계정 유형을 자동 변경하거나 실패 시 다른 유형/환경으로 전환하지 않습니다. 읽기 전용 권한을 사용하고 출금·이체·주문 권한을 켤 필요가 없습니다. UTA는 계좌/포지션 조회에 필요한 UTA 읽기 권한이 필요합니다.

## 비트겟 연결 예시

`ACCOUNT_UUID`는 사이트에서 발급 화면에 나온 실제 UUID로 바꿉니다. `--origin`은 본인 배포 주소입니다.

```sh
python runner/account_reader.py setup --exchange bitget --account-type classic --mode live --account ACCOUNT_UUID --origin https://tradingchat-eight.vercel.app
python runner/account_reader.py run --exchange bitget --account-type classic --mode live --account ACCOUNT_UUID --origin https://tradingchat-eight.vercel.app
```

setup 프롬프트에 비트겟 API Key, Secret Key, **API Passphrase**, 해당 계좌의 연결 토큰을 입력합니다. UTA 계정은 `--account-type uta`로 변경합니다. 모의계좌는 별도 계좌로 등록하고 `--mode testnet`과 **Demo API Key**를 사용합니다.

## 바이낸스 연결 예시

```sh
python runner/account_reader.py setup --exchange binance --account-type futures --mode live --account ACCOUNT_UUID --origin https://tradingchat-eight.vercel.app
python runner/account_reader.py run --exchange binance --account-type futures --mode live --account ACCOUNT_UUID --origin https://tradingchat-eight.vercel.app
```

바이낸스 API Key, Secret Key, 해당 계좌의 연결 토큰을 입력합니다. 테스트넷은 별도 계좌로 등록하고 `--mode testnet`을 사용합니다. 예전 실행기를 쓰던 경우 새 버전에서는 계좌 ID로 키 저장 위치를 분리하므로 setup을 다시 실행합니다.

## 여러 계좌 동시 조회

계좌마다 다른 UUID와 토큰을 발급합니다. 각각 별도 터미널에서 run을 실행하면 됩니다. 바이낸스 1개 + 비트겟 1개뿐 아니라 같은 거래소의 여러 계좌도 분리할 수 있습니다. 두 계좌에 같은 연결 토큰을 재사용하지 마세요.

각 프로세스는 30초마다 해당 계좌의 USDT 지갑 잔고, USDT 선물 포지션과 미실현 손익을 전송합니다. 다른 담보 코인·현물 전체 자산·다른 결제 통화를 합산하지 않습니다. 비트겟 Classic의 accountEquity에는 미실현 손익이 포함되므로 이를 빼서 지갑 잔고로 정규화합니다. UTA의 USDT 자산 balance를 사용하고 포지션 손익은 별도로 합산합니다. 헤지모드의 롱/숏은 각각 유지합니다.

## 보안과 종료

키는 OS 보안 저장소에만 저장합니다. 저장 위치는 배포 주소·거래소·계좌 ID·환경으로 분리합니다. 평문/fallback keyring 백엔드는 거부합니다. 웹 서버에 키·Passphrase·서명·계좌 응답 원문을 전송하지 않습니다. 리다이렉트를 거부하며, 거래소 요청 경로는 GET 조회 목록으로 제한합니다.

연결 토큰은 특정 계좌·거래소·환경에 묶이고 24시간 후 만료됩니다. 토큰 재발급/폐기는 해당 계좌에만 적용됩니다. 사이트 계좌 선택과 실행기 옵션이 다르면 전송을 거부합니다.

종료는 Ctrl+C. 로컬 키 삭제는 run과 같은 옵션으로 action을 `forget`으로 변경합니다. 웹의 해당 계좌 연결 폐기는 별도입니다. 키를 채팅·GitHub·로그에 붙여넣지 마세요.
