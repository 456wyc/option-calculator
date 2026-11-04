(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    tab: 'market', market: null, quotes: null, portfolio: null,
    underlying: '510050', expiry: null, autoRefresh: true,
    modalContract: null, modalPos: null,
    qc: null, qcGeom: {},
    calcDir: { direction: 'long', opt_type: 'call' },
    calcResult: null, calcMeta: null, calcGeom: null,
    chartGeom: null, timer: null, busy: false,
  };

  /* ---------------- 工具 ---------------- */
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  const num = (v, d = 4) => isNum(v) ? Number(v).toFixed(d) : '--';
  const price = (v) => !isNum(v) ? '--' : Number(v).toFixed(Math.abs(Number(v)) >= 10 ? 2 : 4);
  const pct = (v, d = 2) => isNum(v) ? (Number(v) >= 0 ? '+' : '') + Number(v).toFixed(d) + '%' : '--';
  const cls = (v) => !isNum(v) ? 'flat' : (Number(v) > 0 ? 'up' : Number(v) < 0 ? 'down' : 'flat');
  const money = (v, sign = false) => !isNum(v) ? '--' :
    (sign && Number(v) > 0 ? '+' : Number(v) < 0 ? '-' : '') +
    Math.abs(Number(v)).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const shortMoney = (v) => {
    const a = Math.abs(Number(v));
    if (a >= 1e8) return (v / 1e8).toFixed(1) + '亿';
    if (a >= 1e4) return (v / 1e4).toFixed(1) + '万';
    return Math.round(v).toLocaleString('zh-CN');
  };
  const vol = (v) => !isNum(v) ? '--' :
    (Number(v) >= 10000 ? (Number(v) / 10000).toFixed(1) + '万' : Math.round(Number(v)).toLocaleString('zh-CN'));
  const ivPct = (v) => isNum(v) ? (Number(v) * 100).toFixed(1) + '%' : '--';

  let toastTimer;
  function toast(msg, type = 'ok') {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast ' + type;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3400);
  }

  async function api(method, path, body) {
    const opts = { method };
    if (body !== undefined) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    const resp = await fetch((window.__API_BASE__ || '') + path, opts);
    let data;
    try { data = await resp.json(); } catch (e) { throw new Error('服务返回异常'); }
    if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
    return data;
  }

  /* ---------------- 数据加载 ---------------- */
  async function loadMarket() {
    state.market = await api('GET', '/api/market');
    renderMarketStatus();
    renderUnderlyingOptions();
  }

  async function loadQuotes() {
    if (!state.underlying) return;
    state.quotes = await api('GET', '/api/quotes?underlying=' + encodeURIComponent(state.underlying));
    const exps = state.quotes.expiries || [];
    if (!exps.some((e) => e.label === state.expiry)) state.expiry = exps.length ? exps[0].label : null;
    renderExpiries();
    renderQuoteStats();
    renderQuoteTable();
    renderCalcContracts();
  }

  async function loadPortfolio() {
    state.portfolio = await api('GET', '/api/portfolio');
    renderSummary();
    renderPositions();
    renderAnalysis();
  }

  async function refreshAll(force) {
    if (state.busy) return;
    state.busy = true;
    const btn = $('refreshBtn');
    btn.disabled = true;
    try {
      if (force) await api('POST', '/api/refresh');
      await loadMarket();
      await loadQuotes();
      await loadPortfolio();
      if (force) {
        toast('正在刷新行情…');
        setTimeout(() => { refreshAll(false).catch(() => {}); }, 1800);
      }
    } catch (e) {
      toast('刷新失败：' + e.message, 'err');
      renderMarketStatus(e.message);
    } finally {
      state.busy = false;
      btn.disabled = false;
    }
  }

  /* ---------------- 顶部 / 汇总 ---------------- */
  function renderMarketStatus(err) {
    const m = state.market || {};
    const dot = $('statusDot');
    dot.className = 'dot';
    if (err || m.error) {
      dot.classList.add('err');
      $('statusLabel').textContent = '行情暂不可用';
      $('statusDetail').textContent = String(err || m.error).slice(0, 72);
    } else if (m.loading) {
      dot.classList.add('warn');
      $('statusLabel').textContent = '正在获取全市场行情…';
      $('statusDetail').textContent = '首次抓取约需数秒，页面会自动更新';
    } else if (m.stale) {
      dot.classList.add('warn');
      $('statusLabel').textContent = '行情部分更新';
      $('statusDetail').textContent = '更新于 ' + (m.updated_at || '--') + ' · 数据可能不完整';
    } else {
      $('statusLabel').textContent = '行情已连接';
      $('statusDetail').textContent = '行情时间 ' + (m.quote_time || '--') +
        ' · 共 ' + (m.contract_count || 0) + ' 个合约';
    }
  }

  function renderUnderlyingOptions() {
    const list = (state.market && state.market.underlyings) || [];
    $('underlyingSelect').innerHTML = list.map((u) =>
      '<option value="' + esc(u.code) + '">' + esc(u.code) + ' · ' + esc(u.name) +
      ' (' + price(u.spot) + ')</option>').join('');
    if (state.underlying) $('underlyingSelect').value = state.underlying;
  }

  function renderSummary() {
    const s = (state.portfolio && state.portfolio.summary) || {};
    const set = (id, v, suffix) => {
      const el = $(id);
      el.textContent = isNum(v) ? money(v, true) + (suffix || '') : '--';
      el.className = cls(v);
    };
    set('sUnrealized', s.unrealized, ' 元');
    set('sRealized', s.realized, ' 元');
    set('sDelta', s.delta_value, ' 元');
    $('sMargin').textContent = money(s.margin) + ' 元';
  }

  /* ---------------- 行情看板 ---------------- */
  function renderExpiries() {
    $('expiryGroup').innerHTML = ((state.quotes && state.quotes.expiries) || []).map((e) =>
      '<button type="button" class="chip ' + (e.label === state.expiry ? 'active' : '') +
      '" data-expiry="' + esc(e.label) + '">' + esc(e.label) +
      '<em>' + e.days + '天</em></button>').join('');
  }

  function renderQuoteStats() {
    const q = state.quotes || {};
    const u = q.underlying || {};
    const list = (q.contracts || []).filter((c) => c.expiry_label === state.expiry);
    const calls = list.filter((c) => c.opt_type === 'call').length;
    const hv = list.find((c) => isNum(c.hist_vol));
    $('quoteStats').innerHTML = [
      '<div class="qstat"><span>标的现价</span><strong class="' + cls(u.spot_change_pct) + '">' +
        price(u.spot) + ' <small style="font-size:11px">' + pct(u.spot_change_pct) + '</small></strong></div>',
      '<div class="qstat"><span>当月合约</span><strong>' + calls + ' 购 / ' + (list.length - calls) + ' 沽</strong></div>',
      '<div class="qstat"><span>标的年化波动率</span><strong>' + (hv ? ivPct(hv.hist_vol / 100) : '--') + '</strong></div>',
      '<div class="qstat"><span>行情时间</span><strong style="font-size:13px">' + esc((q.quote_time || '--').slice(-8)) + '</strong></div>',
    ].join('');
    $('quoteUpdated').textContent = '更新于 ' + (q.fetch_time || '--') + (q.stale ? ' · 部分数据延迟' : '');
    const staleCount = (state.market && state.market.stale_price_count) || 0;
    const notes = [];
    if (q.error) notes.push('行情提示：' + q.error);
    if (staleCount) notes.push('有 ' + staleCount + ' 个合约当日无最新成交价，已按昨结算价 / 昨收价盯市（价格下方标注口径）');
    $('marketNotice').hidden = !notes.length;
    if (notes.length) $('marketNotice').textContent = notes.join(' · ');
  }

  function quoteSide(c, side, itm) {
    if (!c) return Array(6).fill('<td class="dim">--</td>').join('');
    const bg = itm ? (side === 'call' ? 'itm-call' : 'itm-put') : '';
    const cells = [
      '<td class="' + bg + '">' + ivPct(c.iv) + '</td>',
      '<td class="' + bg + '">' + num(c.delta, 3) + '</td>',
      '<td class="' + bg + ' ' + cls(c.change_pct) + '">' + pct(c.change_pct) + '</td>',
      '<td class="' + bg + ' muted">' + vol(c.volume) + '</td>',
      '<td class="' + bg + ' muted">' + vol(c.open_interest) + '</td>',
      '<td class="price-cell ' + bg + ' ' + cls(c.change) + '" data-code="' + esc(c.code) +
        '" title="点击录入持仓">' + price(c.last) +
        (c.price_basis && c.price_basis !== '最新价'
          ? '<small class="dim" style="display:block;font-size:10px">' + esc(c.price_basis) + '</small>' : '') +
        '<button class="qc-trigger" data-code="' + esc(c.code) + '" type="button" title="按当前价快速试算收益">∑</button>' +
        '</td>',
    ];
    return (side === 'put' ? cells.reverse() : cells).join('');
  }

  function renderQuoteTable() {
    const list = ((state.quotes && state.quotes.contracts) || [])
      .filter((c) => c.expiry_label === state.expiry);
    const map = new Map();
    list.forEach((c) => {
      const key = Number(c.strike).toFixed(4);
      if (!map.has(key)) map.set(key, { strike: c.strike, spot: c.spot, call: null, put: null });
      map.get(key)[c.opt_type] = c;
    });
    const rows = Array.from(map.values()).sort((a, b) => a.strike - b.strike);
    const spot = Number((state.quotes && state.quotes.underlying && state.quotes.underlying.spot) || rows[0]?.spot || 0);
    let atm = null, best = Infinity;
    rows.forEach((r) => { const d = Math.abs(r.strike - spot); if (d < best) { best = d; atm = r.strike; } });
    $('quoteBody').innerHTML = rows.length ? rows.map((r) => {
      const callItm = spot > 0 && r.strike < spot;
      const putItm = spot > 0 && r.strike > spot;
      const label = r.strike === atm ? '平值附近' : callItm ? '认购实值 / 认沽虚值' : '认沽实值 / 认购虚值';
      return '<tr>' + quoteSide(r.call, 'call', callItm) +
        '<td class="strike-cell ' + (r.strike === atm ? 'atm' : '') + '">' + price(r.strike) +
        '<small>' + label + '</small></td>' +
        quoteSide(r.put, 'put', putItm) + '</tr>';
    }).join('') : '<tr><td colspan="13" style="text-align:center;padding:30px" class="muted">暂无合约数据</td></tr>';
  }

  /* ---------------- 持仓 ---------------- */
  function renderPositions() {
    const pf = state.portfolio || {};
    const rows = pf.positions || [];
    $('positionEmpty').hidden = rows.length > 0;
    $('positionBody').innerHTML = rows.map((p) => {
      const dirTag = '<span class="tag ' + p.direction + '">' + (p.direction === 'long' ? '买入' : '卖出') + '</span>';
      const typeTag = '<span class="tag ' + p.opt_type + '">' + (p.opt_type === 'call' ? '认购' : '认沽') + '</span>';
      return '<tr>' +
        '<td class="name-cell">' + esc(p.name || p.code) + '<small>' + esc(p.code) + ' · ' +
          (p.quote_ok ? '行情盯市' : '<span class="tag warn">无行情 / 自定义价</span>') + '</small></td>' +
        '<td>' + dirTag + ' ' + typeTag + '</td>' +
        '<td>' + p.remain_qty + ' / ' + p.qty + '</td>' +
        '<td>' + price(p.open_price) + '</td>' +
        '<td class="' + cls(p.change) + '">' + price(p.current_price) + '<small class="dim" style="display:block">' +
          esc(p.price_basis || p.price_source || '') + '</small></td>' +
        '<td class="' + cls(p.unrealized) + '"><b>' + money(p.unrealized, true) + '</b></td>' +
        '<td class="' + cls(p.pnl_pct) + '">' + pct(p.pnl_pct) + '</td>' +
        '<td>' + ivPct(p.iv) + '</td>' +
        '<td>' + num(p.delta, 3) + '</td>' +
        '<td class="muted">' + money(p.margin) + '</td>' +
        '<td><div class="actions">' +
          '<button class="btn btn-sm" data-action="close" data-id="' + p.id + '" ' +
            (p.remain_qty > 0 ? '' : 'disabled') + '>平仓</button>' +
          '<button class="btn btn-sm" data-action="edit" data-id="' + p.id + '">编辑</button>' +
          '<button class="btn btn-sm btn-danger" data-action="del" data-id="' + p.id + '">删除</button>' +
        '</div></td></tr>';
    }).join('');

    const closes = pf.closes || [];
    $('closeBody').innerHTML = closes.length ? closes.map((c) =>
      '<tr><td class="muted">' + esc(c.close_date || (c.created_at || '').slice(0, 10)) + '</td>' +
      '<td>' + esc(c.name || c.code) + '</td>' +
      '<td>' + (c.direction === 'long' ? '买入' : '卖出') + '</td>' +
      '<td>' + c.qty + '</td><td>' + price(c.open_price) + '</td><td>' + price(c.price) + '</td>' +
      '<td class="muted">' + money(c.fee) + '</td>' +
      '<td class="' + cls(c.realized) + '"><b>' + money(c.realized, true) + '</b></td>' +
      '<td><button class="btn btn-sm btn-danger" data-action="delclose" data-id="' + c.id + '">撤销</button></td></tr>'
    ).join('') : '<tr><td colspan="9" style="text-align:center" class="muted">暂无平仓记录</td></tr>';
  }

  /* ---------------- 收益分析 ---------------- */
  function renderAnalysis() {
    const pf = state.portfolio || {};
    const s = pf.summary || {};
    const cards = [
      ['组合总盈亏', money(s.total_pnl, true) + ' 元', cls(s.total_pnl), '浮盈 + 已实现'],
      ['浮动盈亏', money(s.unrealized, true) + ' 元', cls(s.unrealized), '按最新价盯市'],
      ['已实现盈亏', money(s.realized, true) + ' 元', cls(s.realized), '平仓成交'],
      ['权利金收益率', pct(s.roi), cls(s.roi), '按净权利金支出'],
      ['净权利金支出', money(s.net_premium) + ' 元', '', '买入支出 / 卖出收入'],
      ['持仓市值', money(s.market_value) + ' 元', '', '现价 × 剩余张数 × 单位'],
      ['今日盈亏', money(s.today_pnl, true) + ' 元', cls(s.today_pnl), '按当日涨跌额'],
      ['义务仓保证金', money(s.margin) + ' 元', '', '交易所公式估算'],
      ['Delta 市值', money(s.delta_value, true) + ' 元', cls(s.delta_value), '方向敞口'],
      ['Delta 份额', shortMoney(s.delta_shares) + ' 份', cls(s.delta_shares), '等价标的份数'],
      ['Vega（每 1% IV）', money(s.vega_value, true) + ' 元', cls(s.vega_value), '波动率敏感度'],
      ['Theta（每日）', money(s.theta_value, true) + ' 元', cls(s.theta_value), '时间价值衰减'],
    ];
    $('metricGrid').innerHTML = cards.map((c) =>
      '<div class="metric"><span>' + c[0] + '</span><strong class="' + c[2] + '">' + c[1] +
      '</strong><small>' + c[3] + '</small></div>').join('');

    $('groupBody').innerHTML = (s.by_underlying || []).length ? (s.by_underlying).map((g) =>
      '<tr><td class="name-cell">' + esc(g.name) + '<small>' + esc(g.code) + '</small></td>' +
      '<td>' + price(g.spot) + '</td><td class="' + cls(g.spot_change_pct) + '">' + pct(g.spot_change_pct) + '</td>' +
      '<td>' + g.count + '</td><td class="' + cls(g.unrealized) + '"><b>' + money(g.unrealized, true) + '</b></td>' +
      '<td>' + money(g.delta_value, true) + '</td><td class="muted">' + money(g.margin) + '</td>' +
      '<td class="muted">' + money(g.market_value) + '</td></tr>'
    ).join('') : '<tr><td colspan="8" style="text-align:center" class="muted">暂无持仓</td></tr>';

    const curve = pf.curve || {};
    const bes = curve.breakevens || [];
    $('breakevenRow').innerHTML = bes.length
      ? '<span>到期盈亏平衡点：' + bes.map((b) => pct(b) +
          (isNum(curve.main_spot) ? '（' + price(curve.main_spot * (1 + b / 100)) + '）' : '')).join(' · ') + '</span>' +
        '<span>区间内最大收益：' + money(curve.max_profit, true) + ' 元</span>' +
        '<span>区间内最大亏损：' + money(curve.max_loss, true) + ' 元</span>'
      : '';
    $('chartEmpty').hidden = !!(curve.x && curve.x.length);
    drawChart();
    renderContribBars();
  }

  function renderContribBars() {
    const rows = ((state.portfolio && state.portfolio.positions) || []).map((p) => ({
      label: p.name || p.code,
      sub: p.code + ' · ' + (p.direction === 'long' ? '买入' : '卖出') +
        (p.opt_type === 'call' ? '认购' : '认沽'),
      value: Number(p.pnl) || 0,
    })).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    const box = $('contribBars');
    if (!rows.length) {
      box.innerHTML = '<div class="bar-empty">录入持仓后展示各腿盈亏贡献</div>';
      return;
    }
    const max = Math.max.apply(null, rows.map((r) => Math.abs(r.value))) || 1;
    const axis = '<div class="bar-axis"><span>合约</span>' +
      '<span class="bar-axis-mid"><b>← 亏损</b><b>0</b><b>盈利 →</b></span>' +
      '<span>总盈亏（元）</span></div>';
    box.innerHTML = axis + rows.map((r) => {
      const width = Math.max(Math.abs(r.value) / max * 48, 0.6).toFixed(2);
      const positive = r.value >= 0;
      return '<div class="bar-row">' +
        '<div class="bar-label">' + esc(r.label) + '<small>' + esc(r.sub) + '</small></div>' +
        '<div class="bar-track"><div class="bar-zero"></div>' +
          '<div class="bar-fill ' + (positive ? 'up' : 'down') + '" style="width:' + width + '%"></div>' +
        '</div>' +
        '<div class="bar-value ' + cls(r.value) + '">' + money(r.value, true) + '</div>' +
      '</div>';
    }).join('');
  }

  function drawChart(hover) {
    const canvas = $('pnlChart');
    const wrap = $('chartWrap');
    const c = (state.portfolio && state.portfolio.curve) || {};
    const ctx = canvas.getContext('2d');
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!c.x || !c.x.length) return;

    const pad = { l: 74, r: 20, t: 14, b: 30 };
    const all = c.expiry.concat(c.current, [0]);
    let ymin = Math.min.apply(null, all), ymax = Math.max.apply(null, all);
    const gap = (ymax - ymin) * 0.12 || 100;
    ymin -= gap; ymax += gap;
    const x0 = c.x[0], x1 = c.x[c.x.length - 1];
    const X = (v) => pad.l + (v - x0) / (x1 - x0) * (w - pad.l - pad.r);
    const Y = (v) => pad.t + (ymax - v) / (ymax - ymin) * (h - pad.t - pad.b);

    ctx.font = '11px -apple-system, "Microsoft YaHei", sans-serif';
    ctx.lineWidth = 1;
    const useWan = Math.max(Math.abs(ymin), Math.abs(ymax)) >= 10000;
    const yLabel = (v) => useWan ? (v / 1e4).toFixed(1) + '万' : Math.round(v).toLocaleString('zh-CN');
    for (let i = 0; i <= 5; i++) {
      const v = ymin + (ymax - ymin) * i / 5;
      const y = Y(v);
      ctx.strokeStyle = Math.abs(v) < (ymax - ymin) / 100 ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.055)';
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillStyle = '#63748f'; ctx.textAlign = 'right';
      ctx.fillText(yLabel(v), pad.l - 8, y + 4);
    }
    [-30, -20, -10, 0, 10, 20, 30].forEach((v) => {
      const x = X(v);
      ctx.strokeStyle = v === 0 ? 'rgba(245,189,90,.45)' : 'rgba(255,255,255,.045)';
      ctx.setLineDash(v === 0 ? [4, 4] : []);
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, h - pad.b); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = v === 0 ? '#f5bd5a' : '#63748f'; ctx.textAlign = 'center';
      ctx.fillText(v === 0 ? '当前' : (v > 0 ? '+' : '') + v + '%', x, h - pad.b + 16);
    });

    const line = (data, color, dashed) => {
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dashed ? [5, 4] : []);
      ctx.beginPath();
      data.forEach((v, i) => { const px = X(c.x[i]), py = Y(v); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
      ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
    };
    const zeroY = Y(0);
    ctx.fillStyle = 'rgba(91,140,255,.10)';
    ctx.beginPath();
    ctx.moveTo(X(x0), zeroY);
    c.current.forEach((v, i) => ctx.lineTo(X(c.x[i]), Y(v)));
    ctx.lineTo(X(x1), zeroY); ctx.closePath(); ctx.fill();
    line(c.current, '#5b8cff', true);
    line(c.expiry, '#f5bd5a', false);
    (c.breakevens || []).forEach((b) => {
      const x = X(b);
      ctx.fillStyle = '#f5bd5a'; ctx.beginPath(); ctx.arc(x, zeroY, 3.5, 0, Math.PI * 2); ctx.fill();
    });
    if (hover != null && c.x[hover] !== undefined) {
      const x = X(c.x[hover]);
      ctx.strokeStyle = 'rgba(232,238,248,.5)'; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, h - pad.b); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#f5bd5a'; ctx.beginPath(); ctx.arc(x, Y(c.expiry[hover]), 4, 0, Math.PI * 2); ctx.fill();
    }
    state.chartGeom = { c, X, Y, pad, w, h };
  }

  /* ---------------- 快速试算 ---------------- */
  function renderCalcContracts() {
    const sel = $('calcContract');
    const current = sel.value;
    const list = ((state.quotes && state.quotes.contracts) || []).slice(0, 200);
    sel.innerHTML = '<option value="">不选择（手动填写）</option>' + list.map((c) =>
      '<option value="' + esc(c.code) + '">' + esc(c.name) + ' · ' + price(c.last) + '</option>').join('');
    if (current) sel.value = current;
  }

  async function runCalc() {
    const payload = {
      direction: state.calcDir.direction, opt_type: state.calcDir.opt_type,
      strike: Number($('cStrike').value), spot: Number($('cSpot').value),
      open_price: Number($('cOpen').value), close_price: Number($('cClose').value),
      qty: Number($('cQty').value), multiplier: Number($('cMult').value),
      market: Number($('cMarket').value),
      days: state.calcMeta ? state.calcMeta.days : null,
      iv: state.calcMeta ? state.calcMeta.iv : null,
    };
    if (!(payload.strike > 0 && payload.qty > 0 && payload.multiplier > 0 && payload.open_price >= 0)) {
      toast('请填写有效的行权价、张数、合约单位与开仓价', 'err');
      return;
    }
    try {
      const r = await api('POST', '/api/simulate', payload);
      $('rPnl').textContent = money(r.pnl, true) + ' 元';
      $('rPnl').className = cls(r.pnl);
      $('rRoi').textContent = '收益率 ' + pct(r.roi) + ' · 权利金成本 ' + money(r.cost) + ' 元';
      const rows = [
        ['盈亏平衡价', price(r.breakeven) + '（标的到期价）'],
        ['义务仓保证金估算', money(r.margin) + ' 元'],
        ['最大收益', r.max_profit],
        ['最大亏损', r.max_loss],
        ['合约规模', payload.qty + ' 张 × ' + payload.multiplier + ' = ' +
          (payload.qty * payload.multiplier).toLocaleString('zh-CN') + ' 份'],
        ['交易方向', (payload.direction === 'long' ? '买入' : '卖出') +
          (payload.opt_type === 'call' ? '认购' : '认沽')],
      ];
      $('resultList').innerHTML = rows.map((x) =>
        '<div><span>' + x[0] + '</span><strong>' + esc(x[1]) + '</strong></div>').join('');
      state.calcResult = r;
      renderCalcKeyPoints();
      drawCalcChart();
    } catch (e) { toast(e.message, 'err'); }
  }

  function renderCalcKeyPoints() {
    const c = (state.calcResult && state.calcResult.curve) || {};
    if (!c.x || !c.x.length) {
      $('calcKeyPoints').innerHTML = '';
      $('calcChartEmpty').hidden = false;
      return;
    }
    $('calcChartEmpty').hidden = true;
    const chips = [
      '当前标的价 ' + price(c.spot),
      '行权价 ' + price(c.strike),
      '到期盈亏平衡价 ' + price(c.breakeven),
      '区间内最大盈利 ' + money(c.max_profit, true) + ' 元',
      '区间内最大亏损 ' + money(c.max_loss, true) + ' 元',
      c.iv ? 'IV ' + ivPct(c.iv) + ' · 剩余 ' + Math.round(c.days) + ' 天'
        : '权利金低于内在价值，理论曲线按到期曲线展示',
    ];
    $('calcKeyPoints').innerHTML = chips.map((x) => '<span>' + esc(x) + '</span>').join('');
  }

  function drawCalcChart(hover) {
    const canvas = $('calcChart');
    const wrap = $('calcChartWrap');
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    const c = (state.calcResult && state.calcResult.curve) || {};
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!c.x || !c.x.length || !isNum(c.lower) || !isNum(c.upper)) {
      state.calcGeom = null;
      return;
    }

    const pad = { l: 74, r: 20, t: 20, b: 30 };
    const all = c.expiry.concat(c.current, [0, c.pnl]);
    let ymin = Math.min.apply(null, all), ymax = Math.max.apply(null, all);
    const gap = (ymax - ymin) * 0.12 || 100;
    ymin -= gap; ymax += gap;
    const X = (v) => pad.l + (v - c.lower) / (c.upper - c.lower) * (w - pad.l - pad.r);
    const Y = (v) => pad.t + (ymax - v) / (ymax - ymin) * (h - pad.t - pad.b);
    ctx.font = '11px -apple-system, "Microsoft YaHei", sans-serif';
    ctx.lineWidth = 1;
    const useWan = Math.max(Math.abs(ymin), Math.abs(ymax)) >= 10000;
    const yLabel = (v) => useWan ? (v / 1e4).toFixed(1) + '万' : Math.round(v).toLocaleString('zh-CN');
    for (let i = 0; i <= 5; i++) {
      const v = ymin + (ymax - ymin) * i / 5;
      const y = Y(v);
      ctx.strokeStyle = Math.abs(v) < (ymax - ymin) / 100 ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.055)';
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillStyle = '#63748f'; ctx.textAlign = 'right';
      ctx.fillText(yLabel(v), pad.l - 8, y + 4);
    }
    for (let i = 0; i <= 6; i++) {
      const v = c.lower + (c.upper - c.lower) * i / 6;
      const x = X(v);
      ctx.strokeStyle = 'rgba(255,255,255,.045)';
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, h - pad.b); ctx.stroke();
      ctx.fillStyle = '#63748f'; ctx.textAlign = 'center';
      ctx.fillText(price(v), x, h - pad.b + 16);
    }

    const zeroY = Y(0);
    const spotX = X(c.spot);
    ctx.strokeStyle = 'rgba(245,189,90,.55)'; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(spotX, pad.t); ctx.lineTo(spotX, h - pad.b); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#f5bd5a'; ctx.textAlign = 'center';
    ctx.fillText('当前 ' + price(c.spot), spotX, pad.t - 6);

    ctx.fillStyle = 'rgba(91,140,255,.10)';
    ctx.beginPath();
    ctx.moveTo(X(c.x[0]), zeroY);
    c.current.forEach((v, i) => ctx.lineTo(X(c.x[i]), Y(v)));
    ctx.lineTo(X(c.x[c.x.length - 1]), zeroY);
    ctx.closePath(); ctx.fill();
    const line = (data, color, dashed) => {
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dashed ? [5, 4] : []);
      ctx.beginPath();
      data.forEach((v, i) => {
        const cx = X(c.x[i]), cy = Y(v);
        i ? ctx.lineTo(cx, cy) : ctx.moveTo(cx, cy);
      });
      ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
    };
    line(c.current, '#5b8cff', true);
    line(c.expiry, '#f5bd5a', false);
    if (isNum(c.breakeven) && c.breakeven >= c.lower && c.breakeven <= c.upper) {
      const bx = X(c.breakeven);
      ctx.fillStyle = '#f5bd5a';
      ctx.beginPath(); ctx.arc(bx, zeroY, 4, 0, Math.PI * 2); ctx.fill();
      ctx.font = '10px -apple-system, "Microsoft YaHei", sans-serif';
      const label = '盈亏平衡 ' + price(c.breakeven);
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(8,12,20,.88)';
      ctx.fillRect(bx - tw / 2 - 5, zeroY - 32, tw + 10, 15);
      ctx.fillStyle = '#f5bd5a'; ctx.textAlign = 'center';
      ctx.fillText(label, bx, zeroY - 21);
      ctx.font = '11px -apple-system, "Microsoft YaHei", sans-serif';
    }
    ctx.fillStyle = '#e8eef8';
    ctx.beginPath(); ctx.arc(spotX, Y(c.pnl), 4, 0, Math.PI * 2); ctx.fill();
    if (hover != null && c.x[hover] !== undefined) {
      const hx = X(c.x[hover]);
      ctx.strokeStyle = 'rgba(232,238,248,.5)'; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(hx, pad.t); ctx.lineTo(hx, h - pad.b); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#f5bd5a';
      ctx.beginPath(); ctx.arc(hx, Y(c.expiry[hover]), 4, 0, Math.PI * 2); ctx.fill();
    }
    state.calcGeom = { c, X, Y, pad, w, h };
  }

  /* ---------------- 行情快速收益试算 ---------------- */
  function openQuickCalc(contract) {
    const c = contract;
    if (!c || !isNum(c.last)) { toast('该合约暂无报价，无法试算', 'err'); return; }
    state.qcGeom = {};
    state.qc = {
      contract: c, direction: 'long', opt_type: c.opt_type,
      strike: c.strike, spot: c.spot, days: c.days, iv: c.iv, market: c.market,
      open_price: c.last, close_price: c.last, qty: 1, multiplier: c.multiplier, curve: null,
    };
    const opt = c.opt_type === 'call' ? '认购' : '认沽';
    const picked = '<div class="picked"><strong>' + esc(c.name) + ' · ' + opt + '</strong>' +
      '<span>行权价 ' + price(c.strike) + ' · 到期月 ' + esc(c.expiry_label || '--') +
      ' · 合约单位 ' + c.multiplier.toLocaleString('zh-CN') + ' · 标的现价 ' + price(c.spot) +
      (c.iv ? ' · IV ' + ivPct(c.iv) : '') + ' · 剩余 ' + (c.days || 0) + ' 天</span></div>';
    $('modalBox').innerHTML =
      '<h3>快速收益试算</h3>' +
      '<p class="sub">默认以当前最新价作为开/平仓价，调整开仓价即可计算实际持仓收益。</p>' +
      picked +
      '<div class="field"><span>开仓方向</span><div class="segment" id="qcDir">' +
        '<button class="active" data-dir="long" type="button">买入开仓</button>' +
        '<button data-dir="short" type="button">卖出开仓</button></div></div>' +
      '<div class="form-grid">' +
        '<label class="field"><span>开仓权利金</span><input id="qcOpen" type="number" step="0.0001" value="' + c.last + '"></label>' +
        '<label class="field"><span>平仓权利金（当前价）</span><input id="qcClose" type="number" step="0.0001" value="' + c.last + '"></label>' +
        '<label class="field"><span>张数</span><input id="qcQty" type="number" step="1" min="1" value="1"></label>' +
        '<label class="field"><span>合约单位</span><input id="qcMult" type="number" step="1" value="' + c.multiplier + '"></label>' +
      '</div>' +
      '<div class="qc-result">' +
        '<div class="qc-hero"><span>本笔盈亏</span><strong id="qcPnl">--</strong><small id="qcRoi">--</small></div>' +
        '<div class="qc-grid">' +
          '<div><span>盈亏平衡价（到期）</span><strong id="qcBreak">--</strong></div>' +
          '<div><span>义务仓保证金估算</span><strong id="qcMargin">--</strong></div>' +
          '<div><span>最大收益 / 亏损</span><strong id="qcMax">--</strong></div>' +
        '</div>' +
      '</div>' +
      '<div class="chart-wrap" id="qcChartWrap" style="height:230px;margin-top:14px">' +
        '<canvas id="qcChart"></canvas><div class="chart-tip" id="qcTip" hidden></div>' +
        '<div class="chart-empty" id="qcChartEmpty">计算中…</div></div>' +
      '<div class="modal-actions">' +
        '<button class="btn" id="qcCancel" type="button">关闭</button>' +
        '<button class="btn btn-primary" id="qcAdd" type="button">录入为持仓</button></div>';
    $('modal').hidden = false;
    $('qcCancel').onclick = closeModal;
    $('qcAdd').onclick = () => { const cc = state.qc && state.qc.contract; if (cc) openPositionModal(cc, null); };
    $('qcDir').querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        state.qc.direction = b.dataset.dir;
        $('qcDir').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
        renderQuickCalc();
      };
    });
    ['qcOpen', 'qcClose', 'qcQty', 'qcMult'].forEach((id) => $(id).addEventListener('input', renderQuickCalc));
    const wrap = $('qcChartWrap');
    wrap.onmousemove = (e) => {
      const g = state.qcGeom.v; if (!g || !g.c.x.length) return;
      const rect = $('qcChart').getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const ratio = (mx - g.pad.l) / (g.w - g.pad.l - g.pad.r);
      let idx = Math.round(ratio * (g.c.x.length - 1));
      idx = Math.max(0, Math.min(g.c.x.length - 1, idx));
      const cv = g.c, tip = $('qcTip');
      tip.innerHTML = '标的价格 <b>' + price(cv.x[idx]) + '</b> · 涨跌 <b>' + pct(cv.pct[idx]) + '</b>' +
        '<br>到期盈亏 <b class="' + cls(cv.expiry[idx]) + '">' + money(cv.expiry[idx], true) + ' 元</b>' +
        '<br>当前理论盈亏 <b class="' + cls(cv.current[idx]) + '">' + money(cv.current[idx], true) + ' 元</b>';
      tip.hidden = false;
      tip.style.left = Math.min(mx + 12, rect.width - 200) + 'px';
      tip.style.top = Math.max(8, Math.min(e.clientY - rect.top - 70, rect.height - 80)) + 'px';
      drawMiniCurve($('qcChart'), state.qc.curve, idx, state.qcGeom);
    };
    wrap.onmouseleave = () => {
      $('qcTip').hidden = true;
      if (state.qc && state.qc.curve) drawMiniCurve($('qcChart'), state.qc.curve, null, state.qcGeom);
    };
    renderQuickCalc();
  }

  async function renderQuickCalc() {
    const s = state.qc; if (!s) return;
    const open = Number($('qcOpen').value);
    const close = Number($('qcClose').value);
    const qty = Math.max(1, Number($('qcQty').value) || 1);
    const mult = Math.max(1, Number($('qcMult').value) || s.contract.multiplier);
    if (!(open >= 0)) return;
    const payload = {
      direction: s.direction, opt_type: s.opt_type, strike: s.strike, spot: s.spot,
      open_price: open, close_price: close, qty, multiplier: mult,
      market: s.market, days: s.days, iv: s.iv,
    };
    try {
      const r = await api('POST', '/api/simulate', payload);
      s.curve = r.curve;
      $('qcPnl').textContent = money(r.pnl, true) + ' 元';
      $('qcPnl').className = cls(r.pnl);
      $('qcRoi').textContent = '收益率 ' + pct(r.roi) + ' · 权利金成本 ' + money(r.cost) + ' 元';
      $('qcBreak').textContent = price(r.breakeven);
      $('qcMargin').textContent = money(r.margin) + ' 元';
      const fmtMax = (v) => (v == null ? '--' : String(v).split('（')[0]);
      $('qcMax').textContent = fmtMax(r.max_profit) + ' / ' + fmtMax(r.max_loss);
      $('qcChartEmpty').hidden = !!(r.curve && r.curve.x && r.curve.x.length);
      drawMiniCurve($('qcChart'), r.curve, null, state.qcGeom);
    } catch (e) { toast(e.message, 'err'); }
  }

  function drawMiniCurve(canvas, curve, hover, geomStore) {
    const wrap = canvas.parentElement;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    const c = curve || {};
    if (!c.x || !c.x.length || !isNum(c.lower) || !isNum(c.upper)) {
      if (geomStore) geomStore.v = null;
      return;
    }
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const pad = { l: 64, r: 14, t: 14, b: 24 };
    const all = c.expiry.concat(c.current, [0, c.pnl]);
    let ymin = Math.min.apply(null, all), ymax = Math.max.apply(null, all);
    const gap = (ymax - ymin) * 0.15 || 100;
    ymin -= gap; ymax += gap;
    const X = (v) => pad.l + (v - c.lower) / (c.upper - c.lower) * (w - pad.l - pad.r);
    const Y = (v) => pad.t + (ymax - v) / (ymax - ymin) * (h - pad.t - pad.b);
    ctx.font = '10px -apple-system, "Microsoft YaHei", sans-serif';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const v = ymin + (ymax - ymin) * i / 5;
      const y = Y(v);
      ctx.strokeStyle = Math.abs(v) < (ymax - ymin) / 100 ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.05)';
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillStyle = '#63748f'; ctx.textAlign = 'right';
      ctx.fillText(shortMoney(v), pad.l - 6, y + 3);
    }
    for (let i = 0; i <= 5; i++) {
      const v = c.lower + (c.upper - c.lower) * i / 5;
      const x = X(v);
      ctx.strokeStyle = 'rgba(255,255,255,.04)';
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, h - pad.b); ctx.stroke();
      ctx.fillStyle = '#63748f'; ctx.textAlign = 'center';
      ctx.fillText(price(v), x, h - pad.b + 13);
    }
    const zeroY = Y(0);
    const spotX = X(c.spot);
    ctx.strokeStyle = 'rgba(245,189,90,.55)'; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(spotX, pad.t); ctx.lineTo(spotX, h - pad.b); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#f5bd5a'; ctx.textAlign = 'center';
    ctx.fillText('当前 ' + price(c.spot), spotX, pad.t - 4);
    ctx.fillStyle = 'rgba(91,140,255,.10)';
    ctx.beginPath(); ctx.moveTo(X(c.x[0]), zeroY);
    c.current.forEach((v, i) => ctx.lineTo(X(c.x[i]), Y(v)));
    ctx.lineTo(X(c.x[c.x.length - 1]), zeroY); ctx.closePath(); ctx.fill();
    const line = (data, color, dashed) => {
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dashed ? [5, 4] : []);
      ctx.beginPath();
      data.forEach((v, i) => { const cx = X(c.x[i]), cy = Y(v); i ? ctx.lineTo(cx, cy) : ctx.moveTo(cx, cy); });
      ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
    };
    line(c.current, '#5b8cff', true);
    line(c.expiry, '#f5bd5a', false);
    if (isNum(c.breakeven) && c.breakeven >= c.lower && c.breakeven <= c.upper) {
      const bx = X(c.breakeven);
      ctx.fillStyle = '#f5bd5a';
      ctx.beginPath(); ctx.arc(bx, zeroY, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.font = '9px -apple-system, "Microsoft YaHei", sans-serif';
      const label = '盈亏平衡 ' + price(c.breakeven);
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(8,12,20,.88)';
      ctx.fillRect(bx - tw / 2 - 4, zeroY - 26, tw + 8, 13);
      ctx.fillStyle = '#f5bd5a'; ctx.textAlign = 'center';
      ctx.fillText(label, bx, zeroY - 16);
      ctx.font = '10px -apple-system, "Microsoft YaHei", sans-serif';
    }
    ctx.fillStyle = '#e8eef8';
    ctx.beginPath(); ctx.arc(spotX, Y(c.pnl), 3.5, 0, Math.PI * 2); ctx.fill();
    if (hover != null && c.x[hover] !== undefined) {
      const hx = X(c.x[hover]);
      ctx.strokeStyle = 'rgba(232,238,248,.5)'; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(hx, pad.t); ctx.lineTo(hx, h - pad.b); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#f5bd5a';
      ctx.beginPath(); ctx.arc(hx, Y(c.expiry[hover]), 3.5, 0, Math.PI * 2); ctx.fill();
    }
    if (geomStore) geomStore.v = { c, X, Y, pad, w, h };
  }

  /* ---------------- 弹窗：持仓 ---------------- */
  function closeModal() {
    $('modal').hidden = true;
    $('modalBox').innerHTML = '';
    state.modalContract = null;
    state.modalPos = null;
  }

  function pickedHtml(c) {
    if (!c) return '<div class="picked"><strong>手动录入合约</strong><span>行情中未匹配的合约，请填写行权价与合约单位，可指定自定义现价。</span></div>';
    return '<div class="picked"><strong>' + esc(c.name) + ' · ' + esc(c.code) + '</strong><span>' +
      esc(c.underlying_name || c.underlying || '') + ' · 行权价 ' + price(c.strike) +
      ' · ' + esc(c.expiry_label || '') + ' · 最新 ' + price(c.last) +
      ' · 单位 ' + c.multiplier + '</span></div>';
  }

  function openPositionModal(contract, pos) {
    state.modalContract = contract || null;
    state.modalPos = pos || null;
    const c = contract || null;
    const p = pos || null;
    const display = c || (p ? {
      name: p.name, code: p.code, underlying_name: p.underlying_name,
      strike: p.strike, expiry_label: p.expiry_label, last: p.current_price,
      multiplier: p.multiplier,
    } : null);
    const today = new Date().toISOString().slice(0, 10);
    $('modalBox').innerHTML =
      '<h3>' + (p ? '编辑持仓' : '新增持仓') + '</h3>' +
      '<p class="sub">合约信息自动取自实时行情，可手动调整开仓价与张数。</p>' +
      '<div class="field suggest"><span>合约代码 / 名称搜索</span>' +
        '<input type="text" id="pSearch" autocomplete="off" placeholder="输入代码或名称，如 10011427 / 50ETF购12月2900" value="' +
        esc(p ? p.code : (c ? c.code : '')) + '" ' + (p ? 'disabled' : '') + '>' +
        '<div class="suggest-list" id="pSuggest" hidden></div></div>' +
      '<div id="pPicked">' + pickedHtml(display) + '</div>' +
      '<div class="form-grid">' +
        '<label class="field"><span>方向</span><select id="pDir">' +
          '<option value="long" ' + (p && p.direction === 'short' ? '' : 'selected') + '>买入开仓（权利仓）</option>' +
          '<option value="short" ' + (p && p.direction === 'short' ? 'selected' : '') + '>卖出开仓（义务仓）</option>' +
        '</select></label>' +
        '<label class="field"><span>认购 / 认沽</span><select id="pType">' +
          '<option value="call" ' + ((p || c) && (p || c).opt_type === 'put' ? '' : 'selected') + '>认购</option>' +
          '<option value="put" ' + ((p || c) && (p || c).opt_type === 'put' ? 'selected' : '') + '>认沽</option>' +
        '</select></label>' +
        '<label class="field"><span>张数</span><input type="number" id="pQty" min="1" step="1" value="' +
          (p ? p.qty : 1) + '"></label>' +
        '<label class="field"><span>开仓权利金</span><input type="number" id="pOpen" min="0" step="0.0001" value="' +
          (p ? p.open_price : (c && isNum(c.last) ? c.last : '')) + '"></label>' +
        '<label class="field"><span>行权价</span><input type="number" id="pStrike" min="0" step="0.0001" value="' +
          (p ? p.strike : (c ? c.strike : '')) + '"></label>' +
        '<label class="field"><span>合约单位</span><input type="number" id="pMult" min="1" step="1" value="' +
          (p ? p.multiplier : (c ? c.multiplier : 10000)) + '"></label>' +
        '<label class="field"><span>开仓日期</span><input type="date" id="pDate" value="' +
          esc(p ? (p.open_date || today) : today) + '"></label>' +
        '<label class="field"><span>开仓手续费（元）</span><input type="number" id="pFee" min="0" step="0.01" value="' +
          (p ? (p.open_fee || 0) : 0) + '"></label>' +
        '<label class="field"><span>自定义现价（可选）</span><input type="number" id="pManual" min="0" step="0.0001" value="' +
          (p && p.manual_price != null ? p.manual_price : '') + '" placeholder="行情缺失时用于盯市"></label>' +
        '<label class="field"><span>备注</span><input type="text" id="pNote" value="' +
          esc(p ? (p.note || '') : '') + '" placeholder="策略备注"></label>' +
      '</div>' +
      '<div class="modal-actions"><button class="btn" id="pCancel" type="button">取消</button>' +
      '<button class="btn btn-primary" id="pSubmit" type="button">' + (p ? '保存修改' : '确认录入') + '</button></div>';

    $('modal').hidden = false;
    $('pCancel').onclick = closeModal;
    $('pSubmit').onclick = submitPosition;
    if (c) applyContractToForm(c);
    if (!$('pSearch').disabled) bindSuggest();
  }

  function applyContractToForm(c) {
    $('pSearch').value = c.code;
    $('pType').value = c.opt_type;
    $('pStrike').value = c.strike;
    $('pMult').value = c.multiplier;
    if (isNum(c.last)) $('pOpen').value = c.last;
    $('pPicked').innerHTML = pickedHtml(c);
  }

  function bindSuggest() {
    const input = $('pSearch'), box = $('pSuggest');
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const kw = input.value.trim();
      if (kw.length < 2) { box.hidden = true; return; }
      timer = setTimeout(async () => {
        try {
          const list = await api('GET', '/api/contracts?q=' + encodeURIComponent(kw));
          box.innerHTML = list.length ? list.map((c) =>
            '<button type="button" data-code="' + esc(c.code) + '">' + esc(c.name) +
            '<small>' + esc(c.code) + ' · ' + price(c.last) + '</small></button>').join('')
            : '<button type="button" disabled>未找到合约，可手动填写下方字段</button>';
          box.hidden = false;
        } catch (e) { box.hidden = true; }
      }, 220);
    });
    box.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-code]');
      if (!btn) return;
      try {
        const list = await api('GET', '/api/contracts?q=' + encodeURIComponent(btn.dataset.code));
        const c = list.find((x) => x.code === btn.dataset.code);
        if (c) { state.modalContract = c; applyContractToForm(c); }
        box.hidden = true;
      } catch (err) { toast(err.message, 'err'); }
    });
  }

  async function submitPosition() {
    const c = state.modalContract, p = state.modalPos;
    const code = ($('pSearch').value || '').trim();
    if (!code) { toast('请先选择或填写合约代码', 'err'); return; }
    const payload = {
      code, direction: $('pDir').value, opt_type: $('pType').value,
      qty: Number($('pQty').value), open_price: Number($('pOpen').value),
      strike: Number($('pStrike').value), multiplier: Number($('pMult').value),
      open_date: $('pDate').value, open_fee: Number($('pFee').value) || 0,
      manual_price: $('pManual').value === '' ? null : Number($('pManual').value),
      note: $('pNote').value,
    };
    if (c && c.code === code) {
      Object.assign(payload, {
        name: c.name, underlying: c.underlying, underlying_name: c.underlying_name,
        expiry_label: c.expiry_label, days: c.days, market: c.market,
      });
    }
    try {
      if (p) await api('PUT', '/api/positions/' + p.id, payload);
      else await api('POST', '/api/positions', payload);
      closeModal();
      await refreshAll(false);
      toast(p ? '持仓已更新' : '持仓已录入');
    } catch (e) { toast(e.message, 'err'); }
  }

  function openCloseModal(p) {
    $('modalBox').innerHTML =
      '<h3>平仓</h3><p class="sub">' + esc(p.name || p.code) + ' · 剩余 ' + p.remain_qty +
      ' 张 · 当前价 ' + price(p.current_price) + '</p>' +
      '<div class="picked"><strong>' + (p.direction === 'long' ? '买入持仓' : '卖出持仓') +
      ' · 开仓价 ' + price(p.open_price) + '</strong><span>平仓盈亏 = (平仓价 − 开仓价) × 张数 × 合约单位（空头取反）</span></div>' +
      '<div class="form-grid">' +
        '<label class="field"><span>平仓张数</span><input type="number" id="clQty" min="1" max="' +
          p.remain_qty + '" step="1" value="' + p.remain_qty + '"></label>' +
        '<label class="field"><span>平仓价格</span><input type="number" id="clPrice" min="0" step="0.0001" value="' +
          p.current_price + '"></label>' +
        '<label class="field"><span>手续费（元）</span><input type="number" id="clFee" min="0" step="0.01" value="0"></label>' +
        '<label class="field"><span>日期</span><input type="date" id="clDate" value="' +
          new Date().toISOString().slice(0, 10) + '"></label>' +
      '</div>' +
      '<div class="modal-actions"><button class="btn" id="clCancel" type="button">取消</button>' +
      '<button class="btn btn-primary" id="clSubmit" type="button">确认平仓</button></div>';
    $('modal').hidden = false;
    $('clCancel').onclick = closeModal;
    $('clSubmit').onclick = async () => {
      try {
        await api('POST', '/api/positions/' + p.id + '/close', {
          qty: Number($('clQty').value), price: Number($('clPrice').value),
          fee: Number($('clFee').value) || 0, close_date: $('clDate').value,
        });
        closeModal();
        await refreshAll(false);
        toast('平仓已记录');
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  /* ---------------- 事件 ---------------- */
  function bindEvents() {
    $('tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      state.tab = btn.dataset.tab;
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === btn));
      document.querySelectorAll('.panel').forEach((x) => x.classList.toggle('active', x.id === 'tab-' + state.tab));
      if (state.tab === 'analysis') drawChart();
      if (state.tab === 'calc') { renderCalcContracts(); drawCalcChart(); }
    });
    $('underlyingSelect').addEventListener('change', async (e) => {
      state.underlying = e.target.value;
      state.expiry = null;
      try { await loadQuotes(); } catch (err) { toast(err.message, 'err'); }
    });
    $('expiryGroup').addEventListener('click', (e) => {
      const btn = e.target.closest('.chip');
      if (!btn) return;
      state.expiry = btn.dataset.expiry;
      renderExpiries();
      renderQuoteStats();
      renderQuoteTable();
      renderCalcContracts();
    });
    $('quoteBody').addEventListener('click', (e) => {
      const qb = e.target.closest('.qc-trigger');
      if (qb) {
        const c = ((state.quotes && state.quotes.contracts) || []).find((x) => x.code === qb.dataset.code);
        if (c) { openQuickCalc(c); return; }
      }
      const td = e.target.closest('.price-cell');
      if (!td) return;
      const c = ((state.quotes && state.quotes.contracts) || []).find((x) => x.code === td.dataset.code);
      if (c) openPositionModal(c, null);
    });
    $('refreshBtn').addEventListener('click', () => refreshAll(true));
    $('autoRefresh').addEventListener('change', (e) => { state.autoRefresh = e.target.checked; });
    $('addPosBtn').addEventListener('click', () => openPositionModal(null, null));

    $('positionBody').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn || btn.disabled) return;
      const id = Number(btn.dataset.id);
      const p = (state.portfolio.positions || []).find((x) => x.id === id);
      if (btn.dataset.action === 'edit' && p) return openPositionModal(null, p);
      if (btn.dataset.action === 'close' && p) return openCloseModal(p);
      if (btn.dataset.action === 'del') {
        if (!window.confirm('确认删除该持仓及其平仓记录？')) return;
        try { await api('DELETE', '/api/positions/' + id); await refreshAll(false); toast('持仓已删除'); }
        catch (err) { toast(err.message, 'err'); }
      }
    });
    $('closeBody').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action="delclose"]');
      if (!btn) return;
      try { await api('DELETE', '/api/closes/' + btn.dataset.id); await refreshAll(false); toast('平仓记录已撤销'); }
      catch (err) { toast(err.message, 'err'); }
    });

    $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
    document.addEventListener('click', (e) => {
      const box = $('pSuggest');
      if (box && !e.target.closest('.suggest')) box.hidden = true;
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closeModal(); });

    $('calcDirection').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-dir]');
      if (!btn) return;
      state.calcDir = { direction: btn.dataset.dir, opt_type: btn.dataset.type };
      $('calcDirection').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === btn));
      runCalc();
    });
    $('calcBtn').addEventListener('click', runCalc);
    $('calcContract').addEventListener('change', (e) => {
      const c = ((state.quotes && state.quotes.contracts) || []).find((x) => x.code === e.target.value);
      state.calcMeta = c || null;
      if (!c) return;
      $('cStrike').value = c.strike;
      $('cSpot').value = c.spot;
      $('cOpen').value = c.last;
      $('cClose').value = isNum(c.last) ? (Number(c.last) * 1.2).toFixed(4) : c.last;
      $('cMult').value = c.multiplier;
      $('cMarket').value = String(c.market);
      const target = $('calcDirection').querySelector('button[data-type="' + c.opt_type + '"][data-dir="long"]');
      if (target) target.click();
      else runCalc();
    });

    const wrap = $('chartWrap');
    wrap.addEventListener('mousemove', (e) => {
      const g = state.chartGeom;
      if (!g || !g.c.x.length) return;
      const rect = $('pnlChart').getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const ratio = (mx - g.pad.l) / (g.w - g.pad.l - g.pad.r);
      let idx = Math.round(ratio * (g.c.x.length - 1));
      idx = Math.max(0, Math.min(g.c.x.length - 1, idx));
      const c = g.c;
      const tip = $('chartTip');
      tip.innerHTML = '标的变动 <b>' + pct(c.x[idx]) + '</b>' +
        (isNum(c.prices[idx]) ? ' · 主标的 ' + price(c.prices[idx]) : '') +
        '<br>到期盈亏 <b class="' + cls(c.expiry[idx]) + '">' + money(c.expiry[idx], true) + ' 元</b>' +
        '<br>当前理论盈亏 <b class="' + cls(c.current[idx]) + '">' + money(c.current[idx], true) + ' 元</b>';
      tip.hidden = false;
      tip.style.left = Math.min(mx + 14, rect.width - 190) + 'px';
      tip.style.top = Math.max(10, Math.min(e.clientY - rect.top - 64, rect.height - 80)) + 'px';
      drawChart(idx);
    });
    wrap.addEventListener('mouseleave', () => { $('chartTip').hidden = true; drawChart(); });

    const calcWrap = $('calcChartWrap');
    calcWrap.addEventListener('mousemove', (e) => {
      const g = state.calcGeom;
      if (!g || !g.c.x.length) return;
      const rect = $('calcChart').getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const ratio = (mx - g.pad.l) / (g.w - g.pad.l - g.pad.r);
      let idx = Math.round(ratio * (g.c.x.length - 1));
      idx = Math.max(0, Math.min(g.c.x.length - 1, idx));
      const c = g.c, tip = $('calcTip');
      tip.innerHTML = '标的价格 <b>' + price(c.x[idx]) + '</b> · 涨跌 <b>' + pct(c.pct[idx]) + '</b>' +
        '<br>到期盈亏 <b class="' + cls(c.expiry[idx]) + '">' + money(c.expiry[idx], true) + ' 元</b>' +
        '<br>当前理论盈亏 <b class="' + cls(c.current[idx]) + '">' + money(c.current[idx], true) + ' 元</b>' +
        '<br>按平仓价盈亏 <b class="' + cls(c.pnl) + '">' + money(c.pnl, true) + ' 元</b>';
      tip.hidden = false;
      tip.style.left = Math.min(mx + 14, rect.width - 215) + 'px';
      tip.style.top = Math.max(10, Math.min(e.clientY - rect.top - 86, rect.height - 100)) + 'px';
      drawCalcChart(idx);
    });
    calcWrap.addEventListener('mouseleave', () => { $('calcTip').hidden = true; drawCalcChart(); });
    window.addEventListener('resize', () => {
      if (state.tab === 'analysis') drawChart();
      if (state.tab === 'calc') drawCalcChart();
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.autoRefresh) refreshAll(false);
    });
  }

  /* ---------------- 初始化 ---------------- */
  async function init() {
    bindEvents();
    try {
      await loadMarket();
      const list = (state.market && state.market.underlyings) || [];
      state.underlying = (list.find((u) => u.code === '510050') || list[0] || {}).code || '';
      renderUnderlyingOptions();
      await Promise.all([loadQuotes(), loadPortfolio()]);
      runCalc();
      if (state.market && state.market.loading) {
        setTimeout(() => { refreshAll(false).catch(() => {}); }, 2000);
      }
    } catch (e) {
      toast('初始化失败：' + e.message, 'err');
      renderMarketStatus(e.message);
    }
    state.timer = setInterval(async () => {
      if (!state.autoRefresh || state.busy || document.hidden) return;
      try {
        await loadMarket();
        if (state.tab === 'market') await loadQuotes();
        await loadPortfolio();
      } catch (err) { /* 自动刷新失败时保留上次数据 */ }
    }, 20000);
  }

  init();
})();
