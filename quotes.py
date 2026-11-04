"""A 股期权实时行情：东方财富 T 型报价接口 + 本地缓存（仅标准库）。

覆盖：
  m:10  上交所 ETF 期权（50ETF / 300ETF / 500ETF / 科创50 等）
  m:11  中金所股指期权（沪深300 / 上证50 / 中证1000）
  m:12  深交所 ETF 期权（创业板ETF / 300ETF / 500ETF / 深证100ETF）
"""
import json
import math
import re
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

PUSH2_LIST = "https://push2.eastmoney.com/api/qt/clist/get"
PUSH2_QUOTE = "https://push2.eastmoney.com/api/qt/stock/get"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
HEADERS = {"User-Agent": UA, "Referer": "https://quote.eastmoney.com/"}
MARKETS = "m:10,m:11,m:12"
PAGE_SIZE = 100
FIELDS = (
    "f1,f2,f3,f4,f5,f6,f7,f12,f13,f14,f15,f16,f17,f18,f28,f108,"
    "f161,f162,f250,f331,f333,f334,f335,f336,f337"
)
EXPIRY_RE = re.compile(r"(?:\d{2}年)?\d{1,2}月")


def _num(value):
    if value is None or value == "-" or value == "":
        return None
    try:
        v = float(value)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def _http_json(url, timeout=8, retries=2):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001 - 网络异常统一降级
            last = exc
            time.sleep(0.3 * (attempt + 1))
    raise last


def _page_url(pn):
    params = {
        "pn": pn, "pz": PAGE_SIZE, "po": 0, "np": 1, "fltt": 2, "invt": 2,
        "fid": "f12", "fs": MARKETS, "fields": FIELDS,
    }
    return PUSH2_LIST + "?" + urllib.parse.urlencode(params)


def _fetch_page(pn):
    """返回该页合约行；失败返回 None 以便上层重试。"""
    try:
        payload = _http_json(_page_url(pn))
        data = payload.get("data") or {}
        return data.get("diff") or []
    except Exception:  # noqa: BLE001
        return None


def _quote_time():
    try:
        url = PUSH2_QUOTE + "?secid=1.510050&fields=f86"
        ts = (_http_json(url, timeout=6, retries=1).get("data") or {}).get("f86")
        if isinstance(ts, (int, float)) and ts > 1_000_000_000:
            return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:  # noqa: BLE001
        pass
    return None


def _expiry_label(name, days):
    m = EXPIRY_RE.search(name or "")
    return m.group(0) if m else "剩 %s 天" % days


def _contract(row):
    """接口每行是一个合约（f12/f14 为主合约），方向由简称中的「购/沽」判断。"""
    code = row.get("f12")
    name = str(row.get("f14") or "")
    if not code or not name:
        return None
    if "购" in name:
        side = "call"
    elif "沽" in name:
        side = "put"
    else:
        return None
    market = int(_num(row.get("f13")) or 10)
    last = _num(row.get("f2"))
    change = _num(row.get("f4"))
    prev_close = _num(row.get("f18"))
    basis = "最新价"
    if last is None:
        # 盘后清算或当日无成交时接口会返回 "-"，用昨结算 / 昨收价盯市
        settle = _num(row.get("f28"))
        last = settle if settle is not None else prev_close
        basis = "昨结算价" if settle is not None else ("昨收价" if last is not None else "无报价")
    if prev_close is None and last is not None and change is not None:
        prev_close = round(last - change, 4)
    strike = _num(row.get("f161"))
    days = int(_num(row.get("f162")) or 0)
    return {
        "code": str(code),
        "name": name,
        "opt_type": side,
        "underlying": str(row.get("f331") or ""),
        "underlying_name": str(row.get("f333") or ""),
        "market": market,
        "multiplier": 100 if market == 11 else 10000,
        "strike": strike,
        "days": days,
        "expiry_label": _expiry_label(name, days),
        "last": last,
        "price_basis": basis,
        "change": change,
        "change_pct": _num(row.get("f3")),
        "prev_close": prev_close,
        "prev_settle": _num(row.get("f28")),
        "volume": _num(row.get("f5")),
        "open_interest": _num(row.get("f108")),
        "amount": _num(row.get("f6")),
        "high": _num(row.get("f15")),
        "low": _num(row.get("f16")),
        "open": _num(row.get("f17")),
        "premium_rate": _num(row.get("f250")),
        "hist_vol": _num(row.get("f336")),
        "spot": _num(row.get("f334")),
        "spot_change_pct": _num(row.get("f335")),
    }


def fetch_all():
    first = _http_json(_page_url(1))
    data = first.get("data") or {}
    if not data:
        raise RuntimeError("行情接口未返回数据")
    total = int(data.get("total") or 0)
    rows = list(data.get("diff") or [])
    pages = math.ceil(total / PAGE_SIZE) if total else 1
    failed = []
    if pages > 1:
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(_fetch_page, range(2, pages + 1)))
        for pn, part in zip(range(2, pages + 1), results):
            if part is None:
                failed.append(pn)
            else:
                rows.extend(part)
    if failed:
        still_failed = []
        for pn in failed:
            time.sleep(0.3)
            part = _fetch_page(pn)
            if part is None:
                still_failed.append(pn)
            else:
                rows.extend(part)
        failed = still_failed

    contracts = {}
    for row in rows:
        item = _contract(row)
        if not item or item["underlying"] in ("", "-"):
            continue
        contracts[item["code"]] = item

    underlyings = {}
    by_underlying = {}
    for item in contracts.values():
        code = item["underlying"]
        by_underlying.setdefault(code, []).append(item)
        u = underlyings.setdefault(code, {
            "code": code, "name": item["underlying_name"],
            "spot": item["spot"], "spot_change_pct": item["spot_change_pct"],
            "market": item["market"], "multiplier": item["multiplier"], "count": 0,
        })
        u["count"] += 1
        if u["spot"] is None and item["spot"] is not None:
            u["spot"] = item["spot"]

    return {
        "contracts": contracts,
        "by_underlying": by_underlying,
        "underlyings": sorted(underlyings.values(), key=lambda x: x["code"]),
        "quote_time": _quote_time(),
        "fetch_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "total": total,
        "rows": len(rows),
        "missing_pages": len(failed),
        "no_quote": sum(1 for c in contracts.values() if c["last"] is None),
        "stale_price": sum(1 for c in contracts.values() if c["price_basis"] != "最新价"),
    }


class QuoteStore:
    """带 TTL 的行情缓存：单飞刷新 + 后台保温，接口失败时保留上次快照。"""

    def __init__(self, ttl=15):
        self.ttl = ttl
        self._lock = threading.Lock()
        self._refresh_lock = threading.Lock()
        self._data = None
        self._updated_ts = 0.0
        self._last_access = 0.0
        self.error = None
        self.stale = False

    def refresh(self):
        if not self._refresh_lock.acquire(blocking=False):
            return None  # 已有刷新在跑，稍后复用其结果，绝不阻塞请求线程
        try:
            data = fetch_all()
            total = len(data.get("contracts") or {})
            with self._lock:
                has_old = self._data is not None
            if has_old and total and data.get("no_quote", 0) / total > 0.2:
                with self._lock:
                    self.stale = True
                    self.error = "本轮行情大量合约无报价，已保留上次快照"
                return False
            with self._lock:
                self._data = data
                self._updated_ts = time.time()
                self.error = None
                self.stale = data.get("missing_pages", 0) > 0
            return True
        except Exception as exc:  # noqa: BLE001
            with self._lock:
                self.error = str(exc)
                self.stale = True
            return False
        finally:
            self._refresh_lock.release()

    def snapshot(self, force=False):
        now = time.time()
        with self._lock:
            self._last_access = now
            data = self._data
            age = now - self._updated_ts
            error, stale = self.error, self.stale
            updated = self._updated_ts
        if force or data is None or age > self.ttl:
            threading.Thread(target=self.refresh, name="quote-fetch", daemon=True).start()
        with self._lock:
            data = self._data
            error, stale = self.error, self.stale
            updated = self._updated_ts
        return {
            "data": data,
            "error": error,
            "stale": stale,
            "loading": data is None,
            "updated_at": (datetime.fromtimestamp(updated).strftime("%H:%M:%S")
                           if updated else None),
        }

    def start_background(self):
        def loop():
            while True:
                time.sleep(max(self.ttl, 20))
                with self._lock:
                    active = time.time() - self._last_access < 180
                if active:
                    self.refresh()
        t = threading.Thread(target=loop, name="quote-refresh", daemon=True)
        t.start()
        return t
