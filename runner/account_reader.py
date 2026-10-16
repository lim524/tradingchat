"""Read-only Binance/Bitget USDT Futures account bridge. No order endpoint exists here."""
import argparse
import getpass
import json
import time
import uuid
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from exchanges import account_snapshot

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


def main():
    parser = argparse.ArgumentParser(description="TradingChat account reader (never places orders)")
    parser.add_argument("action", choices=["setup", "run", "forget"])
    parser.add_argument("--mode", choices=["testnet", "live"], default="testnet")
    parser.add_argument("--exchange", choices=["binance", "bitget"], default="binance")
    parser.add_argument("--account-type", choices=["futures", "classic", "uta"])
    parser.add_argument("--account", required=True, type=lambda value: str(uuid.UUID(value)), help="Account UUID shown with the connection token")
    parser.add_argument("--origin", required=True, help="Exact HTTPS Vercel origin, e.g. https://your-app.vercel.app")
    args = parser.parse_args()
    args.account_type = args.account_type or ("futures" if args.exchange == "binance" else "classic")
    if (args.exchange == "binance" and args.account_type != "futures") or (args.exchange == "bitget" and args.account_type not in ("classic", "uta")):
        parser.error("Account type does not match the selected exchange")
    origin = urlparse(args.origin)
    if origin.scheme != "https" or not origin.hostname or origin.username or origin.password or origin.path not in ("", "/") or origin.query or origin.fragment:
        parser.error("Use an HTTPS origin without a path, query, or credentials")
    import keyring
    # Refuse null/plaintext/fallback keyring backends.
    backend = type(keyring.get_keyring()).__module__
    if backend not in ("keyring.backends.Windows", "keyring.backends.macOS", "keyring.backends.SecretService", "keyring.backends.kwallet"):
        raise RuntimeError("Select a supported OS secure keyring backend; plaintext/fallback backends are refused")
    prefix = args.origin.rstrip("/") + ":" + args.exchange + ":" + args.account + ":" + args.mode + ":"
    fields = [("api_key", args.exchange + " read-only API key"), ("api_secret", args.exchange + " API secret")]
    if args.exchange == "bitget":
        fields.append(("passphrase", "Bitget API passphrase"))
    fields.append(("runner_token", "TradingChat connection token for this account"))
    if args.action == "setup":
        for name, label in fields:
            value = getpass.getpass(label + ": ").strip()
            if not value:
                raise ValueError("Empty credential refused")
            keyring.set_password(SERVICE, prefix + name, value)
        print("Saved to OS keyring. This bridge is read-only.")
        return
    if args.action == "forget":
        for name in ("api_key", "api_secret", "runner_token", "passphrase"):
            try:
                keyring.delete_password(SERVICE, prefix + name)
            except keyring.errors.PasswordDeleteError:
                pass
        print("Local credentials removed. Also revoke the connection token in TradingChat.")
        return
    secrets = {n: keyring.get_password(SERVICE, prefix + n) for n, _ in fields}
    if not all(secrets.values()):
        raise ValueError("Run setup first")
    print("Read-only account sync started. Ctrl+C to stop. Mode: " + args.exchange + " / " + args.mode)
    while True:
        try:
            snapshot = account_snapshot(args.exchange, args.mode, secrets["api_key"], secrets["api_secret"], secrets.get("passphrase"), args.account_type, read_json)
            snapshot["accountId"] = args.account
            read_json(args.origin.rstrip("/") + "/api/runner",
                      {"Authorization": "Bearer " + secrets["runner_token"], "Content-Type": "application/json"}, snapshot)
            print(time.strftime("%H:%M:%S"), "Account snapshot synced")
        except HTTPError as error:
            # URLs and raw API error bodies may contain signed request information.
            print("HTTP request failed:", error.code)
            if error.code in (401, 403):
                print("Credential expired or access denied; stopping.")
                break
        except (URLError, TimeoutError, ValueError, KeyError, TypeError):
            print("Account sync failed; no orders were placed. Retrying after 30 seconds.")
        time.sleep(30)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nAccount sync stopped.")
