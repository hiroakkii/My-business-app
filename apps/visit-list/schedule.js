/* 訪問時間の条件と予定時刻の計算（ブラウザ内のみで計算。外部には送らない）
 *
 * 時間の条件（患者ごとに複数）: { kind: 'ok' | 'ng', from: 'HH:MM' | '', to: 'HH:MM' | '' }
 *   ok … 訪問できる時間帯（ok が1つでもあれば、ok の時間帯のどれかに訪問する）
 *   ng … 訪問できない時間帯（ok の有無にかかわらず、この時間帯は避ける）
 *   from が空欄 … 一日の始めから、to が空欄 … 一日の終わりまで
 * 滞在（1件の所要時間）が丸ごと「訪問できる時間」に収まるように予定を組む。
 * 早く着いたときは時間帯の始まりまで待つ。
 */
(function (root) {
  'use strict';

  const DAY_END = 24 * 60;
  const LATE_WEIGHT = 1000; // 時間外 1分 を、移動・待ち時間 1000分 と同じ重さとみなす（時間を守ることを最優先）
  const EXACT_SOLVE_MAX = 8;

  function parseHM(s) {
    const m = String(s || '').match(/^(\d{1,2}):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  function fmtHM(min) {
    const m = Math.round(min);
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
  }

  // 5分単位に丸めた「10:05頃」
  function fmtAbout(min) {
    return `${fmtHM(Math.round(min / 5) * 5)}頃`;
  }

  function validRule(r) {
    if (!r || (r.kind !== 'ok' && r.kind !== 'ng')) return false;
    const a = parseHM(r.from);
    const b = parseHM(r.to);
    if (a == null && b == null) return false;
    return a == null || b == null || a < b;
  }

  function ruleText(r) {
    const a = parseHM(r.from);
    const b = parseHM(r.to);
    let range;
    if (a != null && b != null) range = `${fmtHM(a)}〜${fmtHM(b)}`;
    else if (a != null) range = `${fmtHM(a)}以降`;
    else range = `${fmtHM(b)}まで`;
    return r.kind === 'ok' ? `${range} 可` : `${range} 不可`;
  }

  function rulesText(rules) {
    return (rules || []).filter(validRule).map(ruleText).join('、');
  }

  // 区間の和（重なりをまとめて並べる）
  function union(list) {
    const s = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const [a, b] of s) {
      const last = out[out.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  }

  function subtract(base, cut) {
    let cur = base;
    for (const [c, d] of cut) {
      const next = [];
      for (const [a, b] of cur) {
        if (d <= a || c >= b) { next.push([a, b]); continue; }
        if (a < c) next.push([a, c]);
        if (d < b) next.push([d, b]);
      }
      cur = next;
    }
    return cur;
  }

  function intersect(x, y) {
    const out = [];
    for (const [a, b] of x) {
      for (const [c, d] of y) {
        const s = Math.max(a, c);
        const e = Math.min(b, d);
        if (e > s) out.push([s, e]);
      }
    }
    return union(out);
  }

  // 1名分の条件 → 訪問できる時間帯の一覧（分）。条件なしなら null（いつでも可）
  function intervalsOf(rules) {
    const rs = (rules || []).filter(validRule);
    if (!rs.length) return null;
    const span = (r) => [parseHM(r.from) == null ? 0 : parseHM(r.from), parseHM(r.to) == null ? DAY_END : parseHM(r.to)];
    const ok = rs.filter((r) => r.kind === 'ok').map(span);
    const ng = union(rs.filter((r) => r.kind === 'ng').map(span));
    return subtract(ok.length ? union(ok) : [[0, DAY_END]], ng);
  }

  // 同じ訪問先（グループホーム・同じ住所）の全員の条件を満たす時間帯。全員条件なしなら null
  function intervalsOfStop(rulesList) {
    let cur = null;
    for (const rules of rulesList) {
      const iv = intervalsOf(rules);
      if (iv == null) continue;
      cur = cur == null ? iv : intersect(cur, iv);
    }
    return cur;
  }

  // 到着時刻 t に対して、いつ訪問を始めるか。{ begin, late }（late は時間外になる分数）
  function placeVisit(t, intervals, svc) {
    if (intervals == null) return { begin: t, late: 0 };
    if (!intervals.length) return { begin: t, late: svc }; // 条件どうしが矛盾して可能な時間が無い
    let best = null;
    for (const [a, b] of intervals) {
      const begin = Math.max(t, a);
      const late = Math.max(0, begin + svc - b);
      if (!best || late < best.late - 1e-9 || (Math.abs(late - best.late) < 1e-9 && begin < best.begin)) best = { begin, late };
    }
    return best;
  }

  /* 予定時刻を順にたどる
   * order … 訪問する地点の添字（hasDepot のとき先頭は 0 = 事業所）
   * ctx … { travel(i, j) 分, start 分, svc 分, intervals[添字] , hasDepot, roundTrip }
   */
  function simulate(order, ctx) {
    const visits = [];
    let t = ctx.start;
    let prev = null;
    let lateSum = 0;
    for (const idx of order) {
      if (ctx.hasDepot && idx === 0) { prev = 0; continue; }
      if (prev != null) t += ctx.travel(prev, idx);
      const arrive = t;
      const { begin, late } = placeVisit(arrive, ctx.intervals[idx], ctx.svc);
      visits.push({ idx, arrive, begin, wait: begin - arrive, late });
      lateSum += late;
      t = begin + ctx.svc;
      prev = idx;
    }
    if (ctx.hasDepot && ctx.roundTrip && prev != null && prev !== 0) t += ctx.travel(prev, 0);
    const end = t;
    return { visits, lateSum, end, cost: lateSum * LATE_WEIGHT + (end - ctx.start) };
  }

  function permute(arr, visit) {
    const a = arr.slice();
    const c = new Array(a.length).fill(0);
    visit(a.slice());
    let i = 0;
    while (i < a.length) {
      if (c[i] < i) {
        const j = i % 2 === 0 ? 0 : c[i];
        [a[j], a[i]] = [a[i], a[j]];
        visit(a.slice());
        c[i] += 1;
        i = 0;
      } else {
        c[i] = 0;
        i += 1;
      }
    }
  }

  function improve(tour, cost, fixed) {
    let t = tour.slice();
    let c = cost(t);
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = fixed; i < t.length - 1; i++) {
        for (let k = i + 1; k < t.length; k++) {
          const cand = t.slice(0, i).concat(t.slice(i, k + 1).reverse(), t.slice(k + 1));
          const cc = cost(cand);
          if (cc < c - 1e-9) { t = cand; c = cc; improved = true; }
        }
      }
      for (let i = fixed; i < t.length; i++) {
        for (let j = fixed; j < t.length; j++) {
          if (i === j) continue;
          const cand = t.slice();
          const [v] = cand.splice(i, 1);
          cand.splice(j, 0, v);
          const cc = cost(cand);
          if (cc < c - 1e-9) { t = cand; c = cc; improved = true; }
        }
      }
    }
    return t;
  }

  /* 時間の条件を守りつつ、帰着（片道なら最後の訪問の終了）が最も早くなる順番を探す
   * 時間を守れない場合は、時間外の分数が最も少ない順番にする
   */
  function solveTimed(n, ctx, distOrder) {
    const fixed = ctx.hasDepot ? 1 : 0;
    const head = ctx.hasDepot ? [0] : [];
    const free = [];
    for (let i = fixed; i < n; i++) free.push(i);
    const cost = (t) => simulate(t, ctx).cost;
    let best = null;
    let bestCost = Infinity;
    const consider = (t) => {
      const c = cost(t);
      if (c < bestCost - 1e-9) { bestCost = c; best = t; }
    };
    if (free.length <= EXACT_SOLVE_MAX) {
      permute(free, (perm) => consider(head.concat(perm)));
    } else {
      const starts = [];
      if (distOrder) starts.push(distOrder);
      // 締め切り（訪問できる時間の終わり）が早い順
      const due = (i) => (ctx.intervals[i] && ctx.intervals[i].length ? ctx.intervals[i][ctx.intervals[i].length - 1][1] : DAY_END);
      const open = (i) => (ctx.intervals[i] && ctx.intervals[i].length ? ctx.intervals[i][0][0] : 0);
      starts.push(head.concat(free.slice().sort((a, b) => due(a) - due(b) || open(a) - open(b))));
      starts.push(head.concat(free.slice().sort((a, b) => open(a) - open(b) || due(a) - due(b))));
      for (let k = 0; k < 24; k++) starts.push(head.concat(free.slice().sort(() => Math.random() - 0.5)));
      for (const st of starts) consider(improve(st, cost, fixed));
    }
    return { order: best, sched: simulate(best, ctx) };
  }

  const api = { parseHM, fmtHM, fmtAbout, validRule, ruleText, rulesText, intervalsOf, intervalsOfStop, placeVisit, simulate, solveTimed };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VisitSchedule = api;
})(typeof window !== 'undefined' ? window : globalThis);
