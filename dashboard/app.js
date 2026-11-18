// Token Radar's dashboard. It reads window.RADAR (written beside the page by main.ts) and renders the
// ranked board, the filters and a per-protocol detail panel. No network: every byte is in data.js.
// Rows arrive positionally (D.columns); the page rebuilds them into objects, recomputes each implied
// value from that row's own inputs, and rebuilds each farm plan from the same template and formula the
// model used, so a reader can check both on any row.
(function () {
  'use strict';
  var D = window.RADAR;
  if (!D) return;
  var $ = function (id) { return document.getElementById(id); };
  var M = D.model;
  var COLS = D.columns;

  function slugOf(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  var nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  function usd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(a >= 1e11 ? 0 : 2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(a >= 1e8 ? 1 : 2) + 'M';
    if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + nf.format(n);
  }
  function full(n) { return n === null || n === undefined ? 'n/a' : '$' + nf.format(Math.round(n)); }
  function pct(n) { return n === null || n === undefined ? 'flat' : (n > 0 ? '+' : '') + n.toFixed(2) + '%'; }
  function num2(n) { return n === null || n === undefined || !isFinite(n) ? 'n/a' : n.toFixed(2); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function firstChain(r) { return r.chainNames.length ? r.chainNames[0] : 'n/a'; }
  function cat(r) { return r.category || 'Uncategorised'; }

  // ---------------------------------------------------------------- the model, recomputed
  function recompute(r) {
    var g = r.change_7d === null ? 0 : clamp(r.change_7d / 100, -M.growth_clamp, M.growth_clamp);
    var gm = 1 + M.growth_weight * g;
    var months = r.age_months === null ? M.unknown_age_months : r.age_months;
    var am = M.age_floor + M.age_range * (Math.min(months, M.age_cap_months) / M.age_cap_months);
    var raw = r.ratio_base * gm * am;
    var ratio = clamp(raw, M.ratio_min, M.ratio_max);
    return { gm: gm, am: am, months: months, raw: raw, ratio: ratio, implied: Math.max(1, Math.round(r.tvl_usd * ratio)) };
  }
  function estimates(r) {
    var c = recompute(r);
    function raw(ratio, gm, am) { return Math.max(1, Math.round(r.tvl_usd * clamp(ratio * gm * am, M.ratio_min, M.ratio_max))); }
    return [r.implied_value_usd, raw(D.global_median, c.gm, c.am), raw(r.ratio_base, c.gm, 1), raw(r.ratio_base, 1, c.am)];
  }
  function confidenceOf(n) { return n >= 5 ? 'high' : n >= M.min_comparables ? 'medium' : 'low'; }

  // ---------------------------------------------------------------- the farm plan, rebuilt
  var GAS_PREF = ['Base', 'Arbitrum', 'Solana', 'Optimism', 'Polygon', 'Binance', 'Monad'];
  function gasToken(chain) { return chain === 'Solana' ? 'SOL' : chain.indexOf('B') === 0 ? 'BNB' : 'ETH'; }
  function planGas(chain) { return D.gas[chain] === undefined ? 0.25 : D.gas[chain]; }
  function planChain(chains) {
    if (!chains.length) return 'Ethereum';
    for (var i = 0; i < GAS_PREF.length; i++) if (chains.indexOf(GAS_PREF[i]) >= 0) return GAS_PREF[i];
    for (var j = 0; j < chains.length; j++) if (D.gas[chains[j]] !== undefined) return chains[j];
    return chains[0];
  }
  function familyOf(r) { return D.fam[cat(r)] || 'generic'; }
  var TXS = [6, 7, 8, 5, 6, 5, 9, 4, 4, 5];
  function fill(tpl, row) {
    return tpl.split('{0}').join(nf.format(row.size)).split('{1}').join('$' + row.spend.toFixed(2))
      .split('{2}').join(row.gasToken).split('{3}').join(row.chain).split('{4}').join(row.name).split('{5}').join(row.token);
  }
  function planCore(r) {
    var chain = planChain(r.chainNames);
    var fam = familyOf(r);
    var size = r.tvl_usd >= 1e9 ? 5000 : r.tvl_usd >= 1e8 ? 2000 : 500;
    var gasTotal = Number((planGas(chain) * (TXS[['lend', 'cdp', 'dex', 'lst', 'yield', 'rwa', 'basis', 'bridge', 'risk', 'generic'].indexOf(fam)] || 5)).toFixed(2));
    var bridgeCost = chain === 'Ethereum' ? 2 : 1;
    var spend = fam === 'bridge' ? bridgeCost + gasTotal * 1.5 : bridgeCost + gasTotal;
    var gt = Number((planGas(chain) * 2).toFixed(2));
    var core = { chain: chain, fam: fam, size: size, gas: planGas(chain), gasTotal: gasTotal, gasTx: gt, bridgeCost: bridgeCost, spend: Number((spend + (fam === 'dex' ? 4.5 : 0)).toFixed(2)), minutes: 60 };
    core.row = { size: size, spend: core.spend, gasToken: gasToken(chain), chain: chain, name: r.name, token: D.tokens[fam === 'lst' ? D.lst : 0] };
    return core;
  }
  function planOf(r) {
    var c = planCore(r);
    var fam = c.fam;
    var steps = D.steps[D.steps.length - 1];
    var at = ['lend', 'cdp', 'dex', 'lst', 'yield', 'rwa', 'basis', 'bridge', 'risk', 'generic'].indexOf(fam);
    if (at >= 0) steps = D.steps[at];
    var list = fam === 'bridge' ? [33, 34, 35, 36] : [37, 38, 39, 40, 41];
    return {
      chain: c.chain, fam: fam, size: c.size, gasTotal: c.gasTotal, spend: c.spend, minutes: c.minutes,
      steps: steps.map(function (k) { return fill(D.tpl[k], c.row); }),
      text: text,
      phases: list.map(function (k, i) {
        var g = fam === 'bridge'
          ? [c.gasTx, c.bridgeCost, Number((c.gasTx * 1.5).toFixed(2)), 0][i]
          : [c.bridgeCost, c.gasTx, c.gasTx, 0, c.gasTx][i];
        var m = fam === 'bridge' ? [6, 10, 18, 10][i] : [6, 8, 10, 60, 8][i];
        return { chain: fam === 'bridge' && i === 0 ? 'source' : c.chain, action: fill(D.tpl[k], c.row), gas: g, minutes: m };
      }),
    };
  }

  // ---------------------------------------------------------------- rows
  var rows = D.data.map(function (v) {
    var o = {};
    COLS.forEach(function (k, j) { o[k] = v[j]; });
    o.slug = slugOf(o.name);
    o.chainNames = o.chains.map(function (c) { return D.chains[c]; });
    o.category = o.category || null;
    o.on_watchlist = o.flag === 1;
    o.confidence = confidenceOf(o.comps_n);
    var stat = catStat(cat(o));
    o.category_median = stat ? stat[2] : D.global_median;
    o.p25_ratio = stat ? stat[3] : D.global_median;
    o.p75_ratio = stat ? stat[4] : D.global_median;
    o.ratio_base = Number(o.ratio_base);
    o.plan = null;
    var c = recompute(o);
    o.growth_mult = c.gm;
    o.age_mult = c.am;
    o.est = null;
    o.calc = c;
    return o;
  });
  var bySlug = {};
  rows.forEach(function (r) { bySlug[r.slug] = r; });
  function catStat(c) {
    for (var i = 0; i < D.cstats.length; i++) if (D.cstats[i][0] === c) return D.cstats[i];
    return null;
  }

  var state = { q: '', cat: 'all', watch: false, below: false, sort: 'implied', dir: -1, sel: null };

  var CATS = (function () {
    var counts = {};
    rows.forEach(function (r) { counts[cat(r)] = (counts[cat(r)] || 0) + 1; });
    return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || a.localeCompare(b); }).map(function (c) { return { name: c, n: counts[c] }; });
  })();

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var out = rows.filter(function (r) {
      if (state.cat !== 'all' && cat(r) !== state.cat) return false;
      if (state.watch && !r.on_watchlist) return false;
      if (state.below && r.flag !== 2) return false;
      if (!q) return true;
      return (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + r.chainNames.join(' ') + ' ' + r.confidence).toLowerCase().indexOf(q) >= 0;
    });
    var k = state.sort, d = state.dir;
    out.sort(function (a, b) {
      var x, y;
      switch (k) {
        case 'rank': x = a.rank; y = b.rank; break;
        case 'name': return d * a.name.localeCompare(b.name) || a.rank - b.rank;
        case 'category': return d * cat(a).localeCompare(cat(b)) || a.rank - b.rank;
        case 'chains': return d * firstChain(a).localeCompare(firstChain(b)) || a.rank - b.rank;
        case 'tvl': x = a.tvl_usd; y = b.tvl_usd; break;
        case 'growth': x = a.change_7d === null ? -1e9 : a.change_7d; y = b.change_7d === null ? -1e9 : b.change_7d; break;
        case 'ratio': x = a.ratio_used; y = b.ratio_used; break;
        case 'conf': x = ['low', 'medium', 'high'].indexOf(a.confidence); y = ['low', 'medium', 'high'].indexOf(b.confidence); break;
        default: x = a.implied_value_usd; y = b.implied_value_usd;
      }
      return d * (x - y) || a.rank - b.rank;
    });
    return out;
  }

  // ---------------------------------------------------------------- header and summary
  function head() {
    $('meta').textContent = 'as of ' + D.as_of + ' | ' + D.board_size + ' rows';
    $('src').textContent = D.source;
    $('asof').textContent = D.as_of;
    $('gm').textContent = num2(D.global_median);
    $('gn').textContent = D.global_n;
    $('lead-line').textContent = 'The snapshot holds ' + D.pre_token_total + ' protocols that record no token and ' + D.token_records + ' that record one. Each pre-token protocol is priced at its TVL times a ratio learned from the mcap/TVL of tokens that already trade in the same category, then adjusted for its own seven-day growth and its age.';
    var top = rows[0];
    $('judge-note').innerHTML = 'Rank 1 is <strong>' + esc(top.name) + '</strong> at <strong>' + usd(top.implied_value_usd) + '</strong>, ' + num2(top.ratio_used) + 'x its ' + usd(top.tvl_usd) + ' of TVL. All ' + D.watchlist_size + ' watchlist protocols are on the board, the best at rank ' + D.watchlist_top_rank + '; ' + D.below_floor_rows + ' rows sit below the $' + (D.floor_usd / 1e6) + 'M watchlist floor and the rest are watchlist names and protocols the list leaves out.';
    $('j-rows').textContent = D.board_size;
    $('j-watch').textContent = D.watchlist_coverage;
  }

  function median(a) {
    if (!a.length) return 0;
    a = a.slice().sort(function (x, y) { return x - y; });
    return a.length % 2 ? a[a.length >> 1] : (a[(a.length >> 1) - 1] + a[a.length >> 1]) / 2;
  }
  function stats() {
    var total = 0, tvl = 0, gas = 0, low = 0;
    rows.forEach(function (r) {
      total += r.implied_value_usd; tvl += r.tvl_usd;
      if (r.confidence === 'low') low += 1;
      if (r.rank <= 50) gas += planCore(r).spend;
    });
    var items = [
      ['Rows ranked', String(rows.length), '(' + D.watchlist_coverage + '/' + D.watchlist_size + ' watchlist)'],
      ['Sum of implied values', usd(total), 'on ' + usd(tvl) + ' of TVL'],
      ['Median ratio', num2(median(rows.map(function (r) { return r.ratio_used; }))), 'x TVL, all rows'],
      ['Low confidence', String(low), 'under ' + M.min_comparables + ' comparables'],
      ['Top 50 farm fees', '$' + gas.toFixed(2), 'gas and bridge costs'],
    ];
    $('stats').innerHTML = items.map(function (i) {
      return '<div class="stat"><div class="k">' + esc(i[0]) + '</div><div class="v">' + esc(i[1]) + '</div><div class="s">' + esc(i[2]) + '</div></div>';
    }).join('');
  }

  function chips() {
    var html = chip('all', 'All categories', rows.length);
    CATS.forEach(function (c) { if (c.n >= 2) html += chip(c.name, c.name, c.n); });
    $('chips').innerHTML = html;
    Array.prototype.forEach.call($('chips').querySelectorAll('.chip'), function (b) {
      b.addEventListener('click', function () {
        state.cat = b.getAttribute('data-cat');
        Array.prototype.forEach.call($('chips').querySelectorAll('.chip'), function (o) { o.setAttribute('aria-pressed', o === b ? 'true' : 'false'); });
        render();
      });
    });
  }
  function chip(name, label, n) {
    return '<button type="button" class="chip" data-cat="' + esc(name) + '" aria-pressed="' + (name === state.cat ? 'true' : 'false') + '">' + esc(label) + '<span class="n">' + n + '</span></button>';
  }

  // ---------------------------------------------------------------- table
  function render() {
    var list = filtered();
    $('rows').innerHTML = list.map(function (r) {
      var c = r.change_7d;
      var cls = c === null ? 'muted' : c > 0 ? 'up' : c < 0 ? 'down' : 'muted';
      return '<tr data-slug="' + esc(r.slug) + '"' + (r.slug === state.sel ? ' class="sel"' : '') + ' tabindex="0">' +
        '<td class="num rank">' + r.rank + '</td>' +
        '<td class="name">' + esc(r.name) + (r.on_watchlist ? '<span class="pill wl">watch</span>' : '') + (r.flag === 2 ? '<span class="pill">sub-floor</span>' : '') + '</td>' +
        '<td class="cat">' + esc(cat(r)) + '</td>' +
        '<td class="cat">' + esc(firstChain(r)) + (r.chains.length > 1 ? ' <span class="muted">+' + (r.chains.length - 1) + '</span>' : '') + '</td>' +
        '<td class="num">' + usd(r.tvl_usd) + '</td>' +
        '<td class="num ' + cls + '">' + pct(c) + '</td>' +
        '<td class="num">' + num2(r.ratio_used) + '</td>' +
        '<td class="num"><span class="badge ' + r.confidence + '">' + r.confidence + '</span></td>' +
        '<td class="num value">' + usd(r.implied_value_usd) + '</td>' +
        '</tr>';
    }).join('');
    $('empty').hidden = list.length > 0;
    var desc = list.length === rows.length ? 'All ' + rows.length + ' rows' : list.length + ' of ' + rows.length + ' rows';
    var how = state.sort === 'implied' ? 'implied value, highest first' : state.sort;
    $('count').textContent = desc + ', sorted by ' + how + (state.q ? ', matching "' + state.q + '"' : '') + (state.cat !== 'all' ? ', in ' + state.cat : '');
    Array.prototype.forEach.call($('rows').querySelectorAll('tr'), function (tr) {
      tr.addEventListener('click', function () { select(tr.getAttribute('data-slug')); });
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') select(tr.getAttribute('data-slug')); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('thead th[data-sort]'), function (th) {
      var on = th.getAttribute('data-sort') === state.sort;
      th.classList.toggle('sorted', on);
      var b = th.querySelector('button');
      if (b) b.setAttribute('data-arrow', on ? (state.dir < 0 ? 'v' : '^') : '');
    });
  }

  // ---------------------------------------------------------------- detail
  function select(slug) {
    state.sel = slug;
    Array.prototype.forEach.call($('rows').querySelectorAll('tr'), function (tr) {
      tr.classList.toggle('sel', tr.getAttribute('data-slug') === slug);
    });
    detail(bySlug[slug]);
  }

  function detail(r) {
    if (!r) return;
    var c = r.calc;
    var m = D.model;
    var compAt = D.comp_index[cat(r)];
    var compRows = '';
    if (compAt !== undefined) {
      var end = compAt;
      while (end < D.comps.length && end < compAt + 8) end += 1;
      compRows = D.comps.slice(compAt, end).map(function (x) {
        return '<tr><td>' + esc(D.names[x[0]]) + '</td><td class="num">' + usd(x[1]) + '</td><td class="num">' + usd(x[2]) + '</td><td class="num">' + num2(x[3]) + '</td></tr>';
      }).join('');
    }
    var deltas = r.est.map(function (v) { return r.implied_value_usd ? (v / r.implied_value_usd - 1) * 100 : 0; });
    var estRows = [['Full model (board number)', r.est[0]], ['Global median, no category', r.est[1]], ['No age premium', r.est[2]], ['Flat 7-day growth', r.est[3]]].map(function (e, i) {
      return '<div class="est"><span class="lbl">' + esc(e[0]) + '</span><span>' + usd(e[1]) + ' <span class="muted">(' + (i === 0 ? 'base' : (deltas[i] > 0 ? '+' : '') + deltas[i].toFixed(1) + '%') + ')</span></span></div>';
    }).join('');
    var plan = planOf(r);
    var steps = plan.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    var farm = plan.phases.map(function (s) {
      return '<li><strong>' + esc(s.chain === 'source' ? 'source chain' : s.chain) + '</strong> ' + esc(s.action) + ' <span class="muted">(' + (s.gas ? '$' + s.gas.toFixed(2) : 'no gas') + ', ' + s.minutes + ' min)</span></li>';
    }).join('');
    var check = c.implied === r.implied_value_usd ? 'matches the board' : 'DIFFERS from the board (' + full(r.implied_value_usd) + ')';
    var note = r.comps_n + ' comparable' + (r.comps_n === 1 ? '' : 's') + ' in ' + cat(r);
    if (r.comps_n < 3) note += ' (fewer than the ' + m.min_comparables + ' the model wants; the row leans on the global median of ' + D.global_n + ')';
    if (r.age_months === null) note += '; listed_at unknown, ' + m.unknown_age_months + ' months assumed';
    if (r.change_7d === null) note += '; no 7-day change, taken as flat';
    $('detail').innerHTML =
      '<h3>' + esc(r.name) + '</h3>' +
      '<div class="sub">#' + r.rank + ' | ' + esc(cat(r)) + ' | ' + esc(r.chainNames.join(', ')) + ' | records no token' + (r.on_watchlist ? ' | on the watchlist' : '') + '</div>' +
      '<div class="hero"><div class="k">Implied value</div><div class="v">' + usd(r.implied_value_usd) + '</div>' +
      '<div class="note">' + num2(r.ratio_used) + 'x a TVL of ' + usd(r.tvl_usd) + ', ' + (r.implied_value_usd >= r.tvl_usd ? 'a premium of ' : 'less than the TVL by ') + usd(Math.abs(r.implied_value_usd - r.tvl_usd)) + '</div></div>' +
      '<h4>Model inputs (from the snapshot)</h4><table class="mini"><tbody>' +
      '<tr><td>TVL at ' + esc(D.as_of) + '</td><td class="num">' + full(r.tvl_usd) + '</td></tr>' +
      '<tr><td>7-day TVL change</td><td class="num">' + pct(r.change_7d) + '</td></tr>' +
      '<tr><td>Category median mcap/TVL (n = ' + r.comps_n + ')</td><td class="num">' + num2(r.category_median) + ' <span class="muted">category only</span></td></tr>' +
      '<tr><td>Ratio band [p25, p75]</td><td class="num">' + num2(r.p25_ratio) + ' to ' + num2(r.p75_ratio) + '</td></tr>' +
      '<tr><td>Global median (n = ' + D.global_n + ')</td><td class="num">' + num2(D.global_median) + '</td></tr>' +
      '<tr><td>Listed</td><td class="num">' + (r.age_months === null ? 'no record (' + m.unknown_age_months + ' mo assumed)' : r.age_months + ' months before ' + esc(D.as_of)) + '</td></tr>' +
      '</tbody></table>' +
      '<h4>The arithmetic</h4><pre class="arith">ratio_base = (' + r.comps_n + ' x ' + num2(r.category_median) + ' + ' + m.shrink_k + ' x ' + num2(D.global_median) + ') / (' + r.comps_n + ' + ' + m.shrink_k + ')\n           = ' + r.ratio_base.toFixed(4) + '\n' +
      'growth     = 1 + ' + m.growth_weight + ' x clamp(' + (r.change_7d === null ? 'null' : r.change_7d.toFixed(2)) + '/100, -' + m.growth_clamp + ', ' + m.growth_clamp + ')\n           = ' + c.gm.toFixed(4) + '\n' +
      'age        = ' + m.age_floor + ' + ' + m.age_range + ' x min(' + c.months + ', ' + m.age_cap_months + ') / ' + m.age_cap_months + '\n           = ' + c.am.toFixed(4) + '\n' +
      'ratio      = clamp(' + r.ratio_base.toFixed(4) + ' x ' + c.gm.toFixed(4) + ' x ' + c.am.toFixed(4) + ', ' + m.ratio_min + ', ' + m.ratio_max + ')\n           = ' + c.ratio.toFixed(4) + (Math.abs(r.ratio_used - c.ratio) > 0.0005 ? '  (board shows ' + r.ratio_used.toFixed(4) + ')' : '') + '\n' +
      'implied    = ' + full(r.tvl_usd) + ' x ' + c.ratio.toFixed(4) + '\n           = ' + full(r.implied_value_usd) + '  (' + check + ')</pre>' +
      '<h4>Confidence</h4><p class="note"><span class="badge ' + r.confidence + '">' + r.confidence + '</span> ' + esc(note) + '</p>' +
      '<h4>Comparables behind the ratio</h4>' +
      '<table class="mini"><thead><tr><th>Protocol</th><th class="num">TVL</th><th class="num">Mcap</th><th class="num">x</th></tr></thead><tbody>' + (compRows || '<tr><td colspan="4" class="muted">No comparable in this category; the global median carries it.</td></tr>') + '</tbody></table>' +
      (r.comps_n < 3 ? '<p class="small muted">Fewer than ' + m.min_comparables + ' comparables: this row is marked low confidence and leans on the global median.</p>' : '') +
      '<h4>Farm plan: $' + plan.spend.toFixed(2) + ' in fees, about ' + plan.minutes + ' minutes, $' + plan.size.toLocaleString('en-US') + ' position</h4><ol class="steps">' + steps + '</ol>' +
      '<h4>Step by step</h4><ol class="steps">' + farm + '</ol>' +
      '<h4>Other estimates</h4>' + estRows +
      '<h4>How the model scored here</h4>' +
      '<table class="mini"><thead><tr><th>Cutoff</th><th class="num">Train</th><th class="num">Scored</th><th class="num">Log err</th><th class="num">Factor</th></tr></thead><tbody>' +
      D.validation.map(function (v) { return '<tr><td>' + v.cutoff + '</td><td class="num">' + v.train_n + '</td><td class="num">' + v.scored_n + '</td><td class="num">' + v.med_abs_log_error.toFixed(2) + '</td><td class="num">' + v.multiplier.toFixed(2) + '</td></tr>'; }).join('') +
      '</tbody></table><p class="small muted">Trained only on comparables listed before each cutoff, scored on those listed after it. The ranking is a coarse signal, not a price.</p>';
  }

  // ---------------------------------------------------------------- static blocks
  function validation() {
    $('validation').querySelector('tbody').innerHTML = D.validation.map(function (v) {
      return '<tr><td>' + v.cutoff + '</td><td class="num">' + v.train_n + '</td><td class="num">' + v.scored_n + '</td><td class="num">' + v.held_n + '</td><td class="num">' + v.med_abs_log_error.toFixed(2) + '</td><td class="num accent">' + v.multiplier.toFixed(2) + 'x</td></tr>';
    }).join('');
    var v = D.validation;
    $('val-note').textContent = 'Train n is the comparables the fit saw; scored n is the out-of-sample set, a comparable listed on or after the cutoff; held n is how many of the training rows were already listed and so were not scored. At each cutoff ' + v.map(function (x) { return x.categories_low_n; }).join(', ') + ' board rows sit in a category with fewer than three training comparables; they fall back toward the global median and are marked low confidence.';
  }
  function cats() {
    $('cats').querySelector('tbody').innerHTML = D.cats.filter(function (c) { return c[1] >= 2; }).map(function (c) {
      var top = bySlug[c[2]];
      return '<tr><td>' + esc(c[0]) + '</td><td class="num">' + c[1] + '</td><td class="num">' + num2(c[3]) + '</td><td class="num">' + usd(c[4]) + '</td><td>' + esc(top ? top.name : c[2]) + '</td></tr>';
    }).join('');
  }

  // ---------------------------------------------------------------- wiring
  $('q').addEventListener('input', function (e) { state.q = e.target.value; render(); });
  $('tog-watch').addEventListener('click', function (e) { state.watch = !state.watch; e.target.setAttribute('aria-pressed', String(state.watch)); render(); });
  $('tog-floor').addEventListener('click', function (e) { state.below = !state.below; e.target.setAttribute('aria-pressed', String(state.below)); render(); });
  $('tog-reset').addEventListener('click', function () { state.sort = 'implied'; state.dir = -1; render(); });
  Array.prototype.forEach.call(document.querySelectorAll('thead th[data-sort]'), function (th) {
    th.querySelector('button').addEventListener('click', function () {
      var k = th.getAttribute('data-sort');
      if (state.sort === k) state.dir = -state.dir;
      else { state.sort = k; state.dir = k === 'name' || k === 'category' || k === 'chains' || k === 'rank' ? 1 : -1; }
      render();
    });
  });

  head();
  stats();
  chips();
  validation();
  cats();
  render();
  select(rows[0].slug);

  // Screenshot hooks: ?cat=, ?watch=1, ?below=1, ?slug= and #anchor make reproducible captures.
  var params = new URLSearchParams(location.search);
  if (params.get('cat')) {
    var b = $('chips').querySelector('.chip[data-cat="' + params.get('cat').replace(/["\\]/g, '') + '"]');
    if (b) b.click();
  }
  if (params.get('watch') === '1') $('tog-watch').click();
  if (params.get('below') === '1') $('tog-floor').click();
  if (params.get('slug')) select(params.get('slug'));
  if (location.hash) {
    var at = document.querySelector(location.hash);
    if (at) at.scrollIntoView();
  }
})();
