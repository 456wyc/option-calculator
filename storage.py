"""持仓与平仓记录的本地 SQLite 存储。"""
import os
import sqlite3
from datetime import datetime

DB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
DB_PATH = os.path.join(DB_DIR, "portfolio.db")

POSITION_FIELDS = (
    "code", "name", "underlying", "underlying_name", "opt_type", "direction",
    "strike", "expiry_label", "days", "market", "multiplier", "qty",
    "open_price", "open_date", "open_fee", "manual_price", "note",
)


def _conn():
    os.makedirs(DB_DIR, exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    with _conn() as con:
        con.execute("""
            CREATE TABLE IF NOT EXISTS positions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT NOT NULL,
                name TEXT DEFAULT '',
                underlying TEXT DEFAULT '',
                underlying_name TEXT DEFAULT '',
                opt_type TEXT NOT NULL DEFAULT 'call',
                direction TEXT NOT NULL DEFAULT 'long',
                strike REAL NOT NULL DEFAULT 0,
                expiry_label TEXT DEFAULT '',
                days INTEGER DEFAULT 0,
                market INTEGER DEFAULT 10,
                multiplier INTEGER NOT NULL DEFAULT 10000,
                qty INTEGER NOT NULL DEFAULT 1,
                open_price REAL NOT NULL DEFAULT 0,
                open_date TEXT DEFAULT '',
                open_fee REAL DEFAULT 0,
                manual_price REAL,
                note TEXT DEFAULT '',
                created_at TEXT DEFAULT ''
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS closes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                position_id INTEGER NOT NULL,
                qty INTEGER NOT NULL,
                price REAL NOT NULL,
                fee REAL DEFAULT 0,
                close_date TEXT DEFAULT '',
                created_at TEXT DEFAULT '',
                FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE CASCADE
            )
        """)


def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _position_dict(row, closed_qty=0):
    item = dict(row)
    item["closed_qty"] = closed_qty
    item["remain_qty"] = max(int(item["qty"]) - closed_qty, 0)
    return item


def list_positions():
    with _conn() as con:
        rows = con.execute("SELECT * FROM positions ORDER BY id DESC").fetchall()
        closed = {r["position_id"]: r["n"] for r in con.execute(
            "SELECT position_id, SUM(qty) AS n FROM closes GROUP BY position_id")}
    return [_position_dict(r, int(closed.get(r["id"], 0))) for r in rows]


def get_position(pid):
    with _conn() as con:
        row = con.execute("SELECT * FROM positions WHERE id = ?", (pid,)).fetchone()
        if not row:
            return None
        n = con.execute("SELECT COALESCE(SUM(qty), 0) FROM closes WHERE position_id = ?",
                        (pid,)).fetchone()[0]
    return _position_dict(row, int(n))


def _clean(payload, creating=True):
    out = {}
    for key in POSITION_FIELDS:
        if key in payload:
            out[key] = payload[key]
    if creating:
        out.setdefault("name", "")
        out.setdefault("underlying", "")
        out.setdefault("underlying_name", "")
        out.setdefault("expiry_label", "")
        out.setdefault("days", 0)
        out.setdefault("market", 10)
        out.setdefault("open_date", datetime.now().strftime("%Y-%m-%d"))
        out.setdefault("open_fee", 0)
        out.setdefault("manual_price", None)
        out.setdefault("note", "")
    for key in ("strike", "open_price", "open_fee", "manual_price"):
        if key in out and out[key] not in (None, ""):
            out[key] = float(out[key])
    for key in ("qty", "multiplier", "days", "market"):
        if key in out and out[key] not in (None, ""):
            out[key] = int(out[key])
    if "manual_price" in out and out["manual_price"] == "":
        out["manual_price"] = None
    return out


def _validate(data):
    if not str(data.get("code", "")).strip():
        raise ValueError("合约代码不能为空")
    if data.get("direction") not in ("long", "short"):
        raise ValueError("方向必须是 long 或 short")
    if data.get("opt_type") not in ("call", "put"):
        raise ValueError("类型必须是 call 或 put")
    if int(data.get("qty", 0)) <= 0:
        raise ValueError("张数必须大于 0")
    if int(data.get("multiplier", 0)) <= 0:
        raise ValueError("合约单位必须大于 0")
    if float(data.get("open_price") or 0) < 0:
        raise ValueError("开仓价不能为负")
    if float(data.get("strike") or 0) <= 0:
        raise ValueError("行权价必须大于 0")


def add_position(payload):
    data = _clean(payload, creating=True)
    _validate(data)
    data["created_at"] = _now()
    keys = list(data)
    sql = "INSERT INTO positions (%s) VALUES (%s)" % (
        ",".join(keys), ",".join("?" for _ in keys))
    with _conn() as con:
        cur = con.execute(sql, [data[k] for k in keys])
        pid = cur.lastrowid
    return get_position(pid)


def update_position(pid, payload):
    current = get_position(pid)
    if not current:
        return None
    data = _clean(payload, creating=False)
    merged = {**current, **data}
    _validate(merged)
    if not data:
        return current
    sql = "UPDATE positions SET %s WHERE id = ?" % ",".join("%s = ?" % k for k in data)
    with _conn() as con:
        con.execute(sql, [data[k] for k in data] + [pid])
    return get_position(pid)


def delete_position(pid):
    with _conn() as con:
        con.execute("DELETE FROM closes WHERE position_id = ?", (pid,))
        cur = con.execute("DELETE FROM positions WHERE id = ?", (pid,))
        return cur.rowcount > 0


def add_close(pid, payload):
    pos = get_position(pid)
    if not pos:
        raise ValueError("持仓不存在")
    qty = int(payload.get("qty") or 0)
    price = float(payload.get("price") or 0)
    fee = float(payload.get("fee") or 0)
    if qty <= 0 or qty > pos["remain_qty"]:
        raise ValueError("平仓张数必须在 1 ~ %s 之间" % pos["remain_qty"])
    if price < 0 or fee < 0:
        raise ValueError("价格与手续费不能为负")
    with _conn() as con:
        cur = con.execute(
            "INSERT INTO closes (position_id, qty, price, fee, close_date, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (pid, qty, price, fee,
             payload.get("close_date") or datetime.now().strftime("%Y-%m-%d"), _now()))
        return cur.lastrowid


def list_closes():
    with _conn() as con:
        return [dict(r) for r in con.execute(
            "SELECT c.*, p.code, p.name, p.direction, p.multiplier, p.open_price "
            "FROM closes c LEFT JOIN positions p ON p.id = c.position_id "
            "ORDER BY c.id DESC")]


def delete_close(cid):
    with _conn() as con:
        cur = con.execute("DELETE FROM closes WHERE id = ?", (cid,))
        return cur.rowcount > 0
