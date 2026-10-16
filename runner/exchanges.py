"""Read-only Binance / Bitget adapters. No order or transfer endpoints."""
import base64
import hashlib
import hmac
import math
import time
import uuid
from urllib.parse import urlencode

BINANCE_HOSTS = {"testnet": "https://demo-fapi.binance.com", "live": "https://fapi.binance.com"}
BITGET_HOST = "https://api.bitget.com"


def number(value):
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("Non-finite account value")
    return result


def snapshot(exchange, mode, balance, positions):
    return {"action": "snapshot", "id": str(uuid.uuid4()), "exchange": exchange, "mode": mode,
            "timestamp": int(time.time() * 1000), "balance": balance,
            "unrealizedPnl": sum(p["unrealizedPnl"] for p in positions), "positions": positions}


def binance_snapshot(mode, api_key, api_secret, get):
    host = BINANCE_HOSTS[mode]
    server_time = get(host + "/fapi/v1/time")["serverTime"]
    query = urlencode({"timestamp": server_time, "recvWindow": 5000})
    signature = hmac.new(api_secret.encode(), query.encode(), hashlib.sha256).hexdigest()
    account = get(host + "/fapi/v3/account?" + query + "&signature=" + signature, {"X-MBX-APIKEY": api_key})
    usdt = next((a for a in account.get("assets", []) if a.get("asset") == "USDT"), None)
    if usdt is None:
        raise ValueError("USDT account data missing")
    positions = [{"symbol": p["symbol"], "quantity": number(p["positionAmt"]),
                  "unrealizedPnl": number(p["unrealizedProfit"])}
                 for p in account.get("positions", [])
                 if p["symbol"].endswith("USDT") and number(p["positionAmt"]) != 0]
    result = snapshot("binance", mode, number(usdt["walletBalance"]), positions)
    result["unrealizedPnl"] = number(usdt["unrealizedProfit"])
    result["accountType"] = "futures"
    return result


def bitget_signature(timestamp, path, query, secret):
    payload = str(timestamp) + "GET" + path + ("?" + query if query else "")
    return base64.b64encode(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest()).decode()


def bitget_data(response):
    if not isinstance(response, dict) or response.get("code") != "00000" or "data" not in response:
        # Never propagate the raw exchange message, signed URL, or response into logs.
        raise ValueError("Bitget request rejected")
    return response["data"]


def bitget_snapshot(mode, api_key, api_secret, passphrase, account_type, get):
    if mode not in ("testnet", "live") or account_type not in ("classic", "uta") or not passphrase:
        raise ValueError("Bitget mode/account type/passphrase required")
    server_time = bitget_data(get(BITGET_HOST + "/api/v2/public/time"))["serverTime"]

    def private_get(path, params=None):
        allowed = {"/api/v2/mix/account/accounts", "/api/v2/mix/position/all-position",
                   "/api/v3/account/assets", "/api/v3/position/current-position"}
        if path not in allowed:
            raise ValueError("Read-only endpoint required")
        query = urlencode(params or {})
        headers = {"ACCESS-KEY": api_key, "ACCESS-PASSPHRASE": passphrase,
                   "ACCESS-TIMESTAMP": str(server_time), "locale": "en-US",
                   "ACCESS-SIGN": bitget_signature(server_time, path, query, api_secret)}
        if mode == "testnet":
            headers["paptrading"] = "1"
        return bitget_data(get(BITGET_HOST + path + ("?" + query if query else ""), headers))

    if account_type == "classic":
        accounts = private_get("/api/v2/mix/account/accounts", {"productType": "USDT-FUTURES"})
        usdt = next((a for a in accounts if a.get("marginCoin") == "USDT"), None)
        if usdt is None:
            raise ValueError("USDT Futures account data missing")
        rows = private_get("/api/v2/mix/position/all-position", {"productType": "USDT-FUTURES", "marginCoin": "USDT"})
    else:
        assets = private_get("/api/v3/account/assets")
        usdt = next((a for a in assets["assets"] if a.get("coin") == "USDT"), None)
        rows = private_get("/api/v3/position/current-position", {"category": "USDT-FUTURES"})["list"]
    positions = []
    for p in rows:
        if not p["symbol"].endswith("USDT") or p.get("marginCoin", "USDT") != "USDT":
            continue
        qty = number(p["total"])
        if qty == 0:
            continue
        side = p["holdSide"] if account_type == "classic" else p["posSide"]
        if side not in ("long", "short"):
            raise ValueError("Unsupported position side")
        positions.append({"symbol": p["symbol"], "quantity": abs(qty) * (-1 if side == "short" else 1),
                          "unrealizedPnl": number(p["unrealizedPL"] if account_type == "classic" else p["unrealisedPnl"])})
    if account_type == "classic":
        # accountEquity already includes PnL; normalize to the same wallet-balance basis as Binance.
        unreal = number(usdt["unrealizedPL"]) if usdt.get("unrealizedPL") not in (None, "") else sum(p["unrealizedPnl"] for p in positions)
        balance = number(usdt["accountEquity"]) - unreal
    else:
        # UTA omits zero balances. Show the USDT wallet, not the total value of other collateral.
        balance = number(usdt["balance"]) if usdt else 0.0
    result = snapshot("bitget", mode, balance, positions)
    if account_type == "classic":
        result["unrealizedPnl"] = unreal
    result["accountType"] = account_type
    return result


def account_snapshot(exchange, mode, api_key, api_secret, passphrase, account_type, get):
    if exchange == "binance" and account_type == "futures":
        return binance_snapshot(mode, api_key, api_secret, get)
    if exchange == "bitget":
        return bitget_snapshot(mode, api_key, api_secret, passphrase, account_type, get)
    raise ValueError("Unsupported exchange/account type")
