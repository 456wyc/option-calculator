"""A 股期权计算器 —— 本地 Web 服务入口。

运行：python app.py  （默认 http://127.0.0.1:8765）
零第三方依赖，行情来自东方财富公开接口，持仓保存在 data/portfolio.db。
"""
import json
import math
import os
import threading
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import analytics
import quotes
import storage

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(ROOT, "web")
STORE = quotes.QuoteStore(ttl=15)
_IV_LOCK = threading.Lock()
_IV_CACHE = {"key": None, "map": {}}


def iv_map(data):
    """按 (标的, 到期月, 行权价) 索引可解的 IV，供报价折价的一侧兜底。"""
    contracts = data.get("contracts") or {}
    key = (data.get("fetch_time"), len(contracts))
    with _IV_LOCK:
        if _IV_CACHE["key"] == key:
            return _IV_CACHE["map"]
    result = {}
    for c in contracts.values():
        iv = analytics.implied_vol(c.get("last"), c.get("spot") or 0,
                                   c.get("strike") or 0,
                                   analytics.years_to_expiry(c.get("days")),
                                   c.get("opt_type"))
        if iv:
            result.setdefault((c["underlying"], c["expiry_label"], c["strike"]), iv)
    with _IV_LOCK:
        _IV_CACHE["key"] = key
        _IV_CACHE["map"] = result
    return result


def finite(value):
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {k: finite(v) for k, v in value.items()}
    if isinstance(value, list):
        return [finite(v) for v in value]
    return value


def market_info(snap):
    data = snap["data"] or {}
    return {
        "underlyings": data.get("underlyings", []),
        "quote_time": data.get("quote_time"),
        "fetch_time": data.get("fetch_time"),
        "updated_at": snap["updated_at"],
        "loading": snap.get("loading", False),
        "stale": snap["stale"] or data.get("missing_pages", 0) > 0,
        "error": snap["error"],
        "contract_count": len(data.get("contracts", {})),
        "stale_price_count": data.get("stale_price", 0),
        "source": "东方财富（公开行情，可能有延迟，仅供研究参考）",
    }


def quote_payload(snap, underlying):
    data = snap["data"] or {}
    items = data.get("by_underlying", {}).get(underlying, [])
    peer = iv_map(data)
    enriched = [analytics.enrich(
        x, iv_override=peer.get((x["underlying"], x["expiry_label"], x["strike"])))
        for x in items]
    enriched.sort(key=lambda x: (x.get("days") or 0, x.get("strike") or 0,
                                 x.get("opt_type") or ""))
    expiries = []
    seen = set()
    for item in enriched:
        key = (item["expiry_label"], item["days"])
        if key not in seen:
            seen.add(key)
            expiries.append({"label": item["expiry_label"], "days": item["days"]})
    expiries.sort(key=lambda x: x["days"])
    u = next((x for x in data.get("underlyings", []) if x["code"] == underlying), None)
    return {
        "underlying": u or {},
        "contracts": enriched,
        "expiries": expiries,
        "quote_time": data.get("quote_time"),
        "fetch_time": data.get("fetch_time"),
        "updated_at": snap["updated_at"],
        "stale": snap["stale"],
        "error": snap["error"],
        "loading": snap.get("loading", False),
    }


def build_portfolio(snap, curve_underlying=None):
    data = snap["data"] or {}
    contracts = data.get("contracts", {})
    peer = iv_map(data)
    positions = storage.list_positions()
    closes = storage.list_closes()
    close_map = {}
    realized_total = 0.0
    for item in closes:
        if not item.get("direction") or not item.get("multiplier"):
            continue
        sign = 1 if item["direction"] == "long" else -1
        item["realized"] = (sign * (item["price"] - item["open_price"])
                            * item["qty"] * item["multiplier"] - (item["fee"] or 0))
        realized_total += item["realized"]
        close_map.setdefault(item["position_id"], []).append(item)

    rows, legs, groups = [], [], {}
    totals = {"unrealized": 0.0, "realized": realized_total, "margin": 0.0,
              "market_value": 0.0, "today_pnl": 0.0, "net_premium": 0.0,
              "delta_shares": 0.0, "delta_value": 0.0, "gamma_value": 0.0,
              "vega_value": 0.0, "theta_value": 0.0}
    for pos in positions:
        q = contracts.get(pos["code"])
        price = (q or {}).get("last")
        source = "行情"
        if price is None:
            price = pos.get("manual_price")
            source = "自定义" if price is not None else "无行情"
        if price is None:
            price = pos["open_price"]
        spot = (q or {}).get("spot")
        days = (q or {}).get("days") if q else pos.get("days")
        strike = pos["strike"] or (q or {}).get("strike")
        remain = max(int(pos["remain_qty"]), 0)
        sign = 1 if pos["direction"] == "long" else -1
        mult = int(pos["multiplier"] or 10000)
        market = (q or {}).get("market") or pos.get("market") or 10

        expiry_label = (q or {}).get("expiry_label") or pos.get("expiry_label")
        meta = {"spot": spot, "strike": strike, "days": days,
                "last": price, "opt_type": pos["opt_type"]}
        g = analytics.enrich(meta, iv_override=peer.get(
            (pos["underlying"], expiry_label, strike))) if spot and strike else {}
        unrealized = analytics.leg_pnl(
            {"direction": pos["direction"], "open_price": pos["open_price"],
             "qty": remain, "multiplier": mult}, price) - (pos["open_fee"] or 0)
        pos_realized = sum(x["realized"] for x in close_map.get(pos["id"], []))
        margin = (analytics.margin_estimate(pos["opt_type"], price, spot or 0,
                                            strike or 0, mult, market)
                  if pos["direction"] == "short" and remain else 0.0)
        cost = pos["open_price"] * remain * mult
        change = (q or {}).get("change")
        today = sign * (change or 0) * remain * mult if change is not None else 0.0

        row = {**pos,
               "current_price": price, "price_source": source, "quote_ok": bool(q),
               "price_basis": (q or {}).get("price_basis") or source,
               "spot": spot, "days_cur": days,
               "change": change, "change_pct": (q or {}).get("change_pct"),
               "spot_change_pct": (q or {}).get("spot_change_pct"),
               "expiry_label": expiry_label,
               "iv": g.get("iv"), "iv_source": g.get("iv_source"),
               "delta": g.get("delta"), "gamma": g.get("gamma"),
               "vega": g.get("vega"), "theta": g.get("theta"), "rho": g.get("rho"),
               "intrinsic": g.get("intrinsic"), "time_value": g.get("time_value"),
               "breakeven": (strike + pos["open_price"] if pos["opt_type"] == "call"
                             else strike - pos["open_price"]) if strike else None,
               "unrealized": unrealized, "realized": pos_realized,
               "pnl": unrealized + pos_realized,
               "pnl_pct": (unrealized / cost * 100.0 if cost > 0 else None),
               "margin": margin, "today_pnl": today,
               "closes": close_map.get(pos["id"], [])}
        rows.append(row)

        totals["unrealized"] += unrealized
        totals["margin"] += margin
        totals["market_value"] += price * remain * mult
        totals["today_pnl"] += today
        totals["net_premium"] += sign * cost
        if g.get("delta") is not None:
            totals["delta_shares"] += sign * g["delta"] * remain * mult
            totals["delta_value"] += sign * g["delta"] * remain * mult * (spot or 0)
            totals["gamma_value"] += sign * (g.get("gamma") or 0) * remain * mult * (spot or 0) ** 2 / 100.0
            totals["vega_value"] += sign * (g.get("vega") or 0) * remain * mult
            totals["theta_value"] += sign * (g.get("theta") or 0) * remain * mult
        key = pos["underlying"] or "-"
        grp = groups.setdefault(key, {"code": key, "name": pos["underlying_name"] or key,
                                      "spot": spot, "spot_change_pct": (q or {}).get("spot_change_pct"),
                                      "count": 0, "unrealized": 0.0, "margin": 0.0,
                                      "delta_value": 0.0, "market_value": 0.0})
        grp["count"] += 1
        grp["unrealized"] += unrealized
        grp["margin"] += margin
        grp["market_value"] += price * remain * mult
        if g.get("delta") is not None:
            grp["delta_value"] += sign * g["delta"] * remain * mult * (spot or 0)

        if remain and spot and strike and (not curve_underlying or key == curve_underlying):
            legs.append({"spot": spot, "strike": strike, "days": days,
                         "opt_type": pos["opt_type"], "direction": pos["direction"],
                         "qty": remain, "multiplier": mult, "open_price": pos["open_price"],
                         "underlying": key, "iv": g.get("iv")})

    premium_base = abs(totals["net_premium"])
    summary = {**totals, "total_pnl": totals["unrealized"] + realized_total,
               "roi": (totals["unrealized"] / premium_base * 100.0 if premium_base > 0 else None),
               "positions": len(rows), "open_legs": sum(1 for x in rows if x["remain_qty"] > 0),
               "by_underlying": sorted(groups.values(), key=lambda x: -abs(x["unrealized"]))}
    return {"positions": rows, "summary": summary, "closes": closes,
            "curve": analytics.build_curve(legs),
            "quote_time": data.get("quote_time"), "fetch_time": data.get("fetch_time"),
            "updated_at": snap["updated_at"], "stale": snap["stale"], "error": snap["error"]}


class Handler(BaseHTTPRequestHandler):
    server_version = "OptionCalculator/1.0"

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            super().log_message(fmt, *args)

    def _send(self, status, body, content_type="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(finite(body), ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, status=200):
        self._send(status, obj)

    def _error(self, exc, status=400):
        self._json({"error": str(exc)}, status)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def _static(self, path):
        mapping = {"/": "index.html", "/index.html": "index.html",
                   "/app.js": "app.js", "/style.css": "style.css"}
        name = mapping.get(path)
        if not name:
            self._error("Not Found", 404)
            return
        mime = {"index.html": "text/html; charset=utf-8",
                "app.js": "application/javascript; charset=utf-8",
                "style.css": "text/css; charset=utf-8"}[name]
        file_path = os.path.join(WEB_DIR, name)
        try:
            with open(file_path, "rb") as f:
                self._send(200, f.read(), mime)
        except OSError:
            self._error("静态文件缺失", 500)

    def _dispatch(self, method):
        parsed = urllib.parse.urlparse(self.path)
        path, params = parsed.path, urllib.parse.parse_qs(parsed.query)
        if path == "/favicon.ico" and method == "GET":
            self.send_response(204)
            self.end_headers()
            return
        if method == "GET" and not path.startswith("/api/"):
            return self._static(path)
        if path == "/api/health" and method == "GET":
            return self._json({"ok": True, "service": "A股期权计算器"})
        if path == "/api/market" and method == "GET":
            return self._json(market_info(STORE.snapshot()))
        if path == "/api/quotes" and method == "GET":
            code = (params.get("underlying") or [""])[0]
            return self._json(quote_payload(STORE.snapshot(), code))
        if path == "/api/contracts" and method == "GET":
            keyword = (params.get("q") or [""])[0].strip().lower()
            data = (STORE.snapshot()["data"] or {}).get("contracts", {})
            if not keyword:
                return self._json([])
            hits = [v for k, v in data.items()
                    if keyword in k.lower() or keyword in str(v.get("name", "")).lower()]
            hits.sort(key=lambda x: (x.get("days") or 0, x.get("strike") or 0))
            return self._json(hits[:20])
        if path == "/api/portfolio" and method == "GET":
            return self._json(build_portfolio(STORE.snapshot(),
                                              (params.get("underlying") or [None])[0]))
        if path == "/api/positions" and method == "GET":
            return self._json(storage.list_positions())
        if path == "/api/positions" and method == "POST":
            payload = self._body()
            data = (STORE.snapshot()["data"] or {}).get("contracts", {})
            q = data.get(str(payload.get("code", "")).strip())
            if q:
                # 合约元数据以行情为准，避免手填行权价/方向与真实合约不符
                for key in ("name", "underlying", "underlying_name", "opt_type",
                            "strike", "expiry_label", "days", "market"):
                    payload[key] = q[key]
                if not payload.get("multiplier"):
                    payload["multiplier"] = q["multiplier"]
                if payload.get("open_price") in (None, ""):
                    payload["open_price"] = q.get("last") or 0
            return self._json(storage.add_position(payload), 201)
        if path.startswith("/api/positions/") and path.endswith("/close") and method == "POST":
            pid = int(path.split("/")[3])
            storage.add_close(pid, self._body())
            return self._json({"ok": True})
        if path.startswith("/api/positions/") and method in ("PUT", "DELETE"):
            pid = int(path.split("/")[3])
            if method == "PUT":
                result = storage.update_position(pid, self._body())
                if not result:
                    return self._error("持仓不存在", 404)
                return self._json(result)
            return self._json({"ok": storage.delete_position(pid)})
        if path == "/api/closes" and method == "GET":
            return self._json(storage.list_closes())
        if path.startswith("/api/closes/") and method == "DELETE":
            return self._json({"ok": storage.delete_close(int(path.split("/")[3]))})
        if path == "/api/simulate" and method == "POST":
            return self._json(analytics.quick_calc(self._body()))
        if path == "/api/refresh" and method == "POST":
            result = STORE.refresh()
            return self._json({"ok": result is not False, "error": STORE.error,
                               **market_info(STORE.snapshot())})
        return self._error("Not Found", 404)

    def _handle(self, method):
        try:
            self._dispatch(method)
        except ValueError as exc:
            self._error(exc, 400)
        except (IndexError, KeyError, TypeError) as exc:
            self._error("参数错误: %s" % exc, 400)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self._error("服务异常: %s" % exc, 500)

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_PUT(self):
        self._handle("PUT")

    def do_DELETE(self):
        self._handle("DELETE")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


def main():
    storage.init_db()
    STORE.start_background()
    threading.Thread(target=STORE.refresh, name="quote-warmup", daemon=True).start()
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8765"))
    server = ThreadingHTTPServer((host, port), Handler)
    print("A 股期权计算器已启动: http://%s:%d" % (host, port))
    print("行情源: 东方财富公开接口 | 持仓数据: %s" % storage.DB_PATH)
    print("按 Ctrl+C 退出")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
