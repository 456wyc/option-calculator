"""期权定价、希腊值、盈亏与保证金计算（仅使用 Python 标准库）。

说明：A 股 ETF 期权为美式行权，此处统一用 Black-Scholes 欧式模型估算
隐含波动率与希腊值，仅供分析参考，不作为交易或结算依据。
"""
import math

RISK_FREE_RATE = 0.018
DIVIDEND_YIELD = 0.0
SQRT2 = math.sqrt(2.0)
SQRT2PI = math.sqrt(2.0 * math.pi)


def norm_cdf(x):
    return 0.5 * (1.0 + math.erf(x / SQRT2))


def norm_pdf(x):
    return math.exp(-0.5 * x * x) / SQRT2PI


def years_to_expiry(days):
    return max(float(days or 0), 1.0) / 365.0


def bs_price(s, k, t, sigma, opt_type, r=RISK_FREE_RATE, q=DIVIDEND_YIELD):
    if s <= 0 or k <= 0 or t <= 0 or sigma <= 0:
        return intrinsic_value(s, k, opt_type)
    d1 = (math.log(s / k) + (r - q + 0.5 * sigma * sigma) * t) / (sigma * math.sqrt(t))
    d2 = d1 - sigma * math.sqrt(t)
    disc_s = s * math.exp(-q * t)
    disc_k = k * math.exp(-r * t)
    if opt_type == "call":
        return disc_s * norm_cdf(d1) - disc_k * norm_cdf(d2)
    return disc_k * norm_cdf(-d2) - disc_s * norm_cdf(-d1)


def intrinsic_value(s, k, opt_type):
    if opt_type == "call":
        return max(s - k, 0.0)
    return max(k - s, 0.0)


def implied_vol(price, s, k, t, opt_type, r=RISK_FREE_RATE, q=DIVIDEND_YIELD):
    """二分法反推隐含波动率；无解（价格低于内在价值等）时返回 None。"""
    if price is None or price <= 0 or s <= 0 or k <= 0 or t <= 0:
        return None
    intrinsic_disc = max(intrinsic_value(s, k, opt_type) * math.exp(-r * t), 0.0)
    if price <= intrinsic_disc + 1e-8:
        return None
    low, high = 0.0005, 4.0
    if bs_price(s, k, t, high, opt_type, r, q) < price:
        return None
    for _ in range(60):
        mid = (low + high) / 2.0
        if bs_price(s, k, t, mid, opt_type, r, q) > price:
            high = mid
        else:
            low = mid
    return (low + high) / 2.0


def greeks(s, k, t, sigma, opt_type, r=RISK_FREE_RATE, q=DIVIDEND_YIELD):
    if not sigma or s <= 0 or k <= 0 or t <= 0:
        return {}
    root = sigma * math.sqrt(t)
    d1 = (math.log(s / k) + (r - q + 0.5 * sigma * sigma) * t) / root
    d2 = d1 - root
    pdf = norm_pdf(d1)
    disc_q = math.exp(-q * t)
    disc_r = math.exp(-r * t)
    gamma = disc_q * pdf / (s * root)
    vega = s * disc_q * pdf * math.sqrt(t) / 100.0
    if opt_type == "call":
        delta = disc_q * norm_cdf(d1)
        theta = (-s * disc_q * pdf * sigma / (2 * math.sqrt(t))
                 - r * k * disc_r * norm_cdf(d1)
                 + q * s * disc_q * norm_cdf(d1)) / 365.0
        rho = k * t * disc_r * norm_cdf(d2) / 100.0
    else:
        delta = -disc_q * norm_cdf(-d1)
        theta = (-s * disc_q * pdf * sigma / (2 * math.sqrt(t))
                 + r * k * disc_r * norm_cdf(-d1)
                 - q * s * disc_q * norm_cdf(-d1)) / 365.0
        rho = -k * t * disc_r * norm_cdf(-d2) / 100.0
    return {"delta": delta, "gamma": gamma, "vega": vega, "theta": theta, "rho": rho}


def enrich(contract, r=RISK_FREE_RATE, iv_override=None):
    """给合约附加 IV / 希腊值 / 内在价值等衍生指标。

    iv_override：当本侧报价低于内在价值导致 BS 无解时，用同行权价对侧
    合约的 IV（平价关系下两者应一致）兜底计算希腊值。
    """
    out = dict(contract)
    s = out.get("spot") or 0.0
    k = out.get("strike") or 0.0
    last = out.get("last")
    t = years_to_expiry(out.get("days"))
    iv = implied_vol(last, s, k, t, out.get("opt_type"), r)
    out["iv_source"] = "self" if iv else ("pair" if iv_override else None)
    if not iv and iv_override:
        iv = iv_override
    out["iv"] = iv
    out.update(greeks(s, k, t, iv, out.get("opt_type"), r) if iv else
               {key: None for key in ("delta", "gamma", "vega", "theta", "rho")})
    out["intrinsic"] = intrinsic_value(s, k, out.get("opt_type")) if last is not None else None
    out["time_value"] = (last - out["intrinsic"]
                         if last is not None and out["intrinsic"] is not None else None)
    out["breakeven"] = ((k + last) if out.get("opt_type") == "call" else (k - last)) \
        if last is not None and k else None
    return out


def margin_estimate(opt_type, premium, spot, strike, multiplier, market=10):
    """义务仓开仓保证金估算（交易所公式，以最新价代替前结算价）。"""
    if premium is None or spot <= 0 or strike <= 0 or multiplier <= 0:
        return 0.0
    ratio, floor_ratio = (0.15, 0.10) if market == 11 else (0.12, 0.07)
    otm = max(strike - spot, 0.0) if opt_type == "call" else max(spot - strike, 0.0)
    floor_base = spot if opt_type == "call" else strike
    per_unit = premium + max(ratio * spot - otm, floor_ratio * floor_base)
    if opt_type == "put":
        per_unit = min(per_unit, strike)
    return max(per_unit, 0.0) * multiplier


def leg_pnl(leg, price):
    """单腿浮动盈亏：多头 = (现价-开仓价)×张数×乘数。"""
    sign = 1 if leg["direction"] == "long" else -1
    return sign * (price - leg["open_price"]) * leg["qty"] * leg["multiplier"]


def leg_value(leg, underlying_price, t, sigma, mode="expiry"):
    if mode == "expiry":
        value = intrinsic_value(underlying_price, leg["strike"], leg["opt_type"])
    else:
        value = bs_price(underlying_price, leg["strike"], t, sigma, leg["opt_type"])
    sign = 1 if leg["direction"] == "long" else -1
    return sign * (value - leg["open_price"]) * leg["qty"] * leg["multiplier"]


def build_curve(legs, points=121, span=0.30):
    """组合盈亏曲线。

    横轴为「各标的相对当前价的变动百分比」，这样跨标的持仓也能叠加到
    同一张图上；prices 按持仓规模最大的标的换算成价格刻度。
    """
    valid = [x for x in legs if x.get("spot") and x.get("strike") and x.get("qty")]
    if not valid:
        return {"x": [], "prices": [], "expiry": [], "current": [],
                "breakevens": [], "max_profit": None, "max_loss": None,
                "main_underlying": "", "main_spot": None}
    weighted = {}
    for leg in valid:
        key = leg.get("underlying") or "-"
        weighted[key] = weighted.get(key, 0.0) + leg["qty"] * leg["multiplier"]
    main = max(weighted, key=weighted.get)
    main_spot = next((x["spot"] for x in valid if (x.get("underlying") or "-") == main), None)
    pcts = [-span + 2 * span * i / (points - 1) for i in range(points)]
    expiry, current = [], []
    for p in pcts:
        e_total = c_total = 0.0
        for leg in valid:
            s = leg["spot"] * (1.0 + p)
            e_total += leg_value(leg, s, 0, None, "expiry")
            if leg.get("iv"):
                c_total += leg_value(leg, s, years_to_expiry(leg.get("days")),
                                     leg["iv"], "current")
            else:
                c_total += leg_value(leg, s, 0, None, "expiry")
        expiry.append(e_total)
        current.append(c_total)
    breakevens = []
    for i in range(1, len(pcts)):
        a, b = expiry[i - 1], expiry[i]
        if a == 0:
            breakevens.append(pcts[i - 1] * 100.0)
        elif a * b < 0:
            ratio = abs(a) / (abs(a) + abs(b))
            breakevens.append((pcts[i - 1] + (pcts[i] - pcts[i - 1]) * ratio) * 100.0)
    return {"x": [p * 100.0 for p in pcts],
            "prices": [round(main_spot * (1 + p), 4) for p in pcts] if main_spot else [],
            "expiry": expiry, "current": current, "breakevens": breakevens[:6],
            "max_profit": max(expiry), "max_loss": min(expiry),
            "main_underlying": main, "main_spot": main_spot}


def quick_curve(payload, pnl, r=RISK_FREE_RATE):
    """单笔策略盈亏曲线，横轴为标的绝对价格。

    expiry 为到期按内在价值结算的盈亏；current 为按开仓权利金反推的 IV
    （或行情 IV）用 Black-Scholes 重估的当前理论盈亏；pnl 是按输入平仓价
    计算的已实现 / 假设平仓盈亏，用于标注当前标的价格处的实际盈亏点。
    """
    direction = payload.get("direction", "long")
    opt_type = payload.get("opt_type", "call")
    strike = float(payload.get("strike") or 0)
    spot = float(payload.get("spot") or 0)
    open_price = float(payload.get("open_price") or 0)
    qty = int(payload.get("qty") or 0)
    multiplier = int(payload.get("multiplier") or 10000)
    days = float(payload.get("days") or 0) or 30.0
    iv = payload.get("iv")
    t = years_to_expiry(days)
    sigma = float(iv) if iv else implied_vol(open_price, spot, strike, t, opt_type, r)
    breakeven = strike + open_price if opt_type == "call" else strike - open_price
    if spot <= 0 or strike <= 0 or qty <= 0:
        return {"x": [], "expiry": [], "current": [], "pct": [], "breakeven": breakeven,
                "max_profit": None, "max_loss": None, "spot": spot, "strike": strike,
                "lower": None, "upper": None, "iv": sigma, "days": days, "pnl": pnl}

    lower = max(min(spot * 0.70, strike * 0.92, breakeven * 0.97), 0.0)
    upper = max(spot * 1.30, strike * 1.08, breakeven * 1.03)
    if upper <= lower:
        upper = lower + max(spot * 0.10, 0.01)
    points = 121
    xs = [lower + (upper - lower) * i / (points - 1) for i in range(points)]
    leg = {"direction": direction, "opt_type": opt_type, "strike": strike,
           "open_price": open_price, "qty": qty, "multiplier": multiplier}
    expiry = [leg_value(leg, x, 0, None, "expiry") for x in xs]
    current = ([leg_value(leg, x, t, sigma, "current") for x in xs]
               if sigma else list(expiry))
    return {"x": [round(x, 4) for x in xs],
            "pct": [round((x / spot - 1.0) * 100.0, 2) for x in xs],
            "expiry": expiry, "current": current,
            "breakeven": breakeven, "pnl": pnl,
            "max_profit": max(expiry), "max_loss": min(expiry),
            "spot": spot, "strike": strike, "lower": lower, "upper": upper,
            "iv": sigma, "days": days}


def quick_calc(payload, r=RISK_FREE_RATE):
    """单笔期权快速试算。"""
    direction = payload.get("direction", "long")
    opt_type = payload.get("opt_type", "call")
    strike = float(payload.get("strike") or 0)
    spot = float(payload.get("spot") or 0)
    open_price = float(payload.get("open_price") or 0)
    close_price = float(payload.get("close_price") or 0)
    qty = int(payload.get("qty") or 0)
    multiplier = int(payload.get("multiplier") or 10000)
    market = int(payload.get("market") or 10)
    sign = 1 if direction == "long" else -1
    pnl = sign * (close_price - open_price) * qty * multiplier
    cost = open_price * qty * multiplier
    margin = margin_estimate(opt_type, open_price, spot, strike, multiplier, market) if direction == "short" else 0.0
    base = cost if direction == "long" else margin
    breakeven = strike + open_price if opt_type == "call" else strike - open_price
    if opt_type == "call":
        max_profit = "无限" if direction == "long" else f"{open_price * qty * multiplier:,.2f} 元（最大权利金收入）"
        max_loss = f"{-cost:,.2f} 元（权利金归零）" if direction == "long" else "无限"
    else:
        cap = strike * qty * multiplier
        max_profit = (f"{(cap - cost):,.2f} 元（标的跌至 0）" if direction == "long"
                      else f"{open_price * qty * multiplier:,.2f} 元（最大权利金收入）")
        max_loss = (f"{-cost:,.2f} 元（权利金归零）" if direction == "long"
                    else f"{-(cap - cost):,.2f} 元（标的跌至 0）")
    return {"pnl": pnl, "cost": cost, "roi": (pnl / base * 100.0 if base > 0 else None),
            "margin": margin, "breakeven": breakeven, "max_profit": max_profit,
            "max_loss": max_loss, "sign": sign,
            "curve": quick_curve(payload, pnl, r)}
