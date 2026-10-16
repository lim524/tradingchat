"""Read-only Binance USDT Futures account bridge. No order endpoint exists here."""
import argparse
import getpass
import hashlib
import hmac
import json
import time
import uuid
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

HOSTS = {"testnet": "https://demo-fapi.binance.com", "live": "https://fapi.binance.com"}
SERVICE = "tradingchat-account-reader"


def read_json(url, headers=None, data=None):
    request = Request(url, headers=headers or {}, data=None if data is None else json.dumps(data).encode())
    # Do not follow redirects with either Binance keys or the runner token.
    from urllib.request import HTTPRedirectHandler, build_opener
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    with build_opener(NoRedirect).open(request, timeout=15) as response:
        return json.load(response)


def account_snapshot(mode, api_key, api_secret):
    host = HOSTS[mode]
    server_time = read_json(host + "/fapi/v1/time")["serverTime"]
    query = urlencode({"timestamp": server_time, "recvWindow": 5000})
    signature = hmac.new(api_secret.encode(), query.encode(), hashlib.sha256).hexdigest()
    # Fixed GET URL; no arbitrary path, POST, leverage, transfer, or order capability.
    account = read_json(host + "/fapi/v3/account?" + query + "&signature=" + signature,
                        {"X-MBX-APIKEY": api_key})
    usdt = next((a for a in account.get("assets", []) if a.get("asset") == "USDT"), None)
    if usdt is None:
        raise ValueError("USDT account data missing")
    return {"action": "snapshot", "id": str(uuid.uuid4()), "mode": mode,
            "timestamp": int(time.time() * 1000), "balance": float(usdt["walletBalance"]),
            "unrealizedPnl": float(usdt["unrealizedProfit"]),
            "positions": [{"symbol": p["symbol"], "quantity": float(p["positionAmt"]),
                           "unrealizedPnl": float(p["unrealizedProfit"])}
                          for p in account.get("positions", [])
                          if p["symbol"].endswith("USDT") and float(p["positionAmt"]) != 0]}


def main():
    parser = argparse.ArgumentParser(description="TradingChat account reader (never places orders)")
    parser.add_argument("action", choices=["setup", "run", "forget"])
    parser.add_argument("--mode", choices=HOSTS, default="testnet")
    parser.add_argument("--origin", required=True, help="Exact HTTPS Vercel origin, e.g. https://your-app.vercel.app")
    args = parser.parse_args()
    origin = urlparse(args.origin)
    if origin.scheme != "https" or not origin.hostname or origin.username or origin.password or origin.path not in ("", "/") or origin.query or origin.fragment:
        parser.error("Use an HTTPS origin without a path, query, or credentials")
    import keyring
    # Refuse null/plaintext/fallback keyring backends.
    backend = type(keyring.get_keyring()).__module__
    if backend not in ("keyring.backends.Windows", "keyring.backends.macOS", "keyring.backends.SecretService", "keyring.backends.kwallet"):
        raise RuntimeError("Select a supported OS secure keyring backend; plaintext/fallback backends are refused")
    prefix = args.origin.rstrip("/") + ":" + args.mode + ":"
    if args.action == "setup":
        for name, label in [("api_key", "Binance read-only API key"), ("api_secret", "Binance API secret"), ("runner_token", "TradingChat connection token")]:
            value = getpass.getpass(label + ": ").strip()
            if not value:
                raise ValueError("Empty credential refused")
            keyring.set_password(SERVICE, prefix + name, value)
        print("Saved to OS keyring. This bridge is read-only.")
        return
    if args.action == "forget":
        for name in ("api_key", "api_secret", "runner_token"):
            try:
                keyring.delete_password(SERVICE, prefix + name)
            except keyring.errors.PasswordDeleteError:
                pass
        print("Local credentials removed. Also revoke the connection token in TradingChat.")
        return
    secrets = [keyring.get_password(SERVICE, prefix + n) for n in ("api_key", "api_secret", "runner_token")]
    if not all(secrets):
        raise ValueError("Run setup first")
    print("Read-only account sync started. Ctrl+C to stop. Mode: " + args.mode)
    while True:
        try:
            snapshot = account_snapshot(args.mode, secrets[0], secrets[1])
            read_json(args.origin.rstrip("/") + "/api/runner",
                      {"Authorization": "Bearer " + secrets[2], "Content-Type": "application/json"}, snapshot)
            print(time.strftime("%H:%M:%S"), "Account snapshot synced")
        except HTTPError as error:
            # URLs and raw API error bodies may contain signed request information.
            print("HTTP request failed:", error.code)
            if error.code in (401, 403):
                print("Credential expired or access denied; stopping.")
                break
        except (URLError, TimeoutError, ValueError, KeyError):
            print("Account sync failed; no orders were placed. Retrying after 30 seconds.")
        time.sleep(30)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nAccount sync stopped.")
