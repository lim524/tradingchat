# PC 계좌 조회 실행기 (주문 기능 없음)

이 릴리스의 실행기는 **계좌 조회만** 합니다. Binance 서명·계좌 조회·Vercel 전송·OS 키 저장소 경로부터 검증합니다. 테스트넷/실거래 자동 주문, 보호 주문, 체결 복구, Flash 분당 판단은 아직 구현·통합 검증 전입니다. 웹의 승인 버튼으로 실거래가 활성화되지 않습니다.

1. Python 3.11 이상 설치 후 `python -m pip install -r runner/requirements.txt`.
2. 사이트 비밀번호로 접속 → 연결 설정 → 24시간 연결 토큰 발급. 토큰은 한 번만 표시됩니다.
3. `python runner/account_reader.py setup --mode testnet --origin https://YOUR_APP.vercel.app`
4. 프롬프트에서 Binance **테스트넷 조회 키**, secret, 웹 연결 토큰 입력. 키는 OS 보안 저장소에만 저장됩니다. 평문 keyring/fallback은 거부합니다.
5. `python runner/account_reader.py run --mode testnet --origin https://YOUR_APP.vercel.app`
6. 실거래 **조회만** 하려면 읽기 전용 키로 별도 setup/run에 `--mode live` 사용.
7. 종료는 Ctrl+C. 로컬 키 삭제는 같은 origin/mode로 `forget`; 웹 토큰 폐기도 별도로 실행합니다.

출금·이체·거래 권한을 켤 필요가 없습니다. 30초마다 USDT 잔고와 USDT 포지션 요약만 보냅니다. API 키·secret·서명·계좌 원문은 Vercel/Supabase로 보내지 않습니다. 리다이렉트는 거부합니다. 연결 토큰은 24시간 만료하고 새 발급 시 이전 토큰은 폐기됩니다.

실행기 토큰의 권한은 계좌 스냅샷 전송뿐입니다. 전략 승인·주문·AI 호출 권한은 없습니다. 자동 주문 기능을 붙일 때 이 토큰의 권한을 확대하지 말고 별도 실행 권한 및 검증 경로를 구현해야 합니다.
