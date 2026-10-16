import base64
import hashlib
import hmac
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runner"))
from exchanges import bitget_signature, bitget_snapshot, binance_snapshot


class ExchangeTests(unittest.TestCase):
    def test_signature_covers_exact_path_and_query(self):
        payload = b"1700000000000GET/api/v2/mix/account/accounts?productType=USDT-FUTURES"
        expected = base64.b64encode(hmac.new(b"test-secret", payload, hashlib.sha256).digest()).decode()
        self.assertEqual(bitget_signature("1700000000000", "/api/v2/mix/account/accounts", "productType=USDT-FUTURES", "test-secret"), expected)

    def bitget_get(self, account_type, mode):
        calls = []
        def get(url, headers=None):
            calls.append((url, headers))
            if url.endswith("/public/time"):
                self.assertIsNone(headers)
                return {"code": "00000", "data": {"serverTime": "1700000000000"}}
            self.assertEqual(headers["ACCESS-PASSPHRASE"], "test-passphrase")
            self.assertEqual(headers.get("paptrading"), "1" if mode == "testnet" else None)
            self.assertIn("ACCESS-SIGN", headers)
            if "/mix/account/accounts?" in url:
                return {"code": "00000", "data": [{"marginCoin": "USDT", "accountEquity": "103", "unrealizedPL": "3"}]}
            if "/mix/position/all-position?" in url:
                return {"code": "00000", "data": [{"symbol": "BTCUSDT", "marginCoin": "USDT", "holdSide": "short", "total": "0.1", "unrealizedPL": "3"}]}
            if url.endswith("/v3/account/assets"):
                return {"code": "00000", "data": {"assets": [{"coin": "USDT", "balance": "200"}, {"coin": "BGB", "balance": "999"}]}}
            if "/v3/position/current-position?" in url:
                return {"code": "00000", "data": {"list": [{"symbol": "ETHUSDT", "posSide": "long", "total": "1", "unrealisedPnl": "5"}, {"symbol": "ETHUSDT", "posSide": "short", "total": "2", "unrealisedPnl": "-2"}]}}
            raise AssertionError("Unapproved endpoint")
        return get, calls

    def test_classic_demo_normalizes_equity_and_short_side(self):
        get, calls = self.bitget_get("classic", "testnet")
        snap = bitget_snapshot("testnet", "test-key", "test-secret", "test-passphrase", "classic", get)
        self.assertEqual(snap["balance"], 100)
        self.assertEqual(snap["positions"][0]["quantity"], -0.1)
        self.assertEqual(snap["unrealizedPnl"], 3)
        self.assertEqual(len(calls), 3)
        self.assertNotIn("test-key", str(snap))
        self.assertNotIn("test-passphrase", str(snap))

    def test_uta_live_preserves_both_hedge_positions(self):
        get, _ = self.bitget_get("uta", "live")
        snap = bitget_snapshot("live", "test-key", "test-secret", "test-passphrase", "uta", get)
        self.assertEqual(snap["balance"], 200)
        self.assertEqual(snap["unrealizedPnl"], 3)
        self.assertEqual([p["quantity"] for p in snap["positions"]], [1, -2])

    def test_http_200_exchange_error_is_not_treated_as_zero_balance(self):
        with self.assertRaises(ValueError):
            bitget_snapshot("live", "key", "secret", "pass", "classic", lambda *args: {"code": "40012", "msg": "auth error"})

    def test_binance_testnet_stays_read_only(self):
        def get(url, headers=None):
            self.assertTrue(url.startswith("https://demo-fapi.binance.com/"))
            if "/time" in url:
                return {"serverTime": 1700000000000}
            self.assertIn("/fapi/v3/account?", url)
            return {"assets": [{"asset": "USDT", "walletBalance": "10", "unrealizedProfit": "2"}], "positions": []}
        result = binance_snapshot("testnet", "key", "secret", get)
        self.assertEqual(result["exchange"], "binance")
        self.assertEqual(result["balance"], 10)

if __name__ == "__main__":
    unittest.main()
