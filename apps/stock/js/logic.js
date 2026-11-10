/*
 * 在庫薬の期限判定・日付計算ロジック
 * ブラウザ (window.StockLogic) と Node.js (require) の両方から使えるようにしている。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.StockLogic = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // "2026-10-29" / "2026/10/29" / Date → ローカル日付 (時刻 00:00)
  function parseDate(value) {
    if (value instanceof Date) {
      return new Date(value.getFullYear(), value.getMonth(), value.getDate());
    }
    if (typeof value !== 'string') return null;
    const m = value.trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (d.getMonth() !== Number(m[2]) - 1) return null; // 2026/02/30 などを弾く
    return d;
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  // 入力欄用 (YYYY-MM-DD)
  function toISO(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  // 表示用 (YYYY/MM/DD)
  function formatDate(date) {
    if (!date) return '';
    return date.getFullYear() + '/' + pad2(date.getMonth() + 1) + '/' + pad2(date.getDate());
  }

  // 月加算。加算先に同じ日が無い場合は月末に丸める (例: 2028/02/29 + 12ヶ月 → 2029/02/28)
  function addMonths(date, months) {
    const y = date.getFullYear();
    const m = date.getMonth() + months;
    const lastDay = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(date.getDate(), lastDay));
  }

  function addDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  }

  function diffDays(from, to) {
    const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
    const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
    return Math.round((b - a) / 86400000);
  }

  /*
   * 処方日と有効期間(月)から、黄色・赤色に切り替わる日を求める。
   *   赤色: 処方日 + 有効期間
   *   黄色: 処方日 + 有効期間の半分
   * 有効期間が偶数月なら月単位でちょうど半分 (24ヶ月 → 12ヶ月後)。
   * 奇数月なら処方日〜赤色日の日数の半分 (切り上げ) を加算する。
   */
  function thresholds(prescribedDate, expiryMonths) {
    const red = addMonths(prescribedDate, expiryMonths);
    const yellow = expiryMonths % 2 === 0
      ? addMonths(prescribedDate, expiryMonths / 2)
      : addDays(prescribedDate, Math.ceil(diffDays(prescribedDate, red) / 2));
    return { yellow: yellow, red: red };
  }

  // 'green' | 'yellow' | 'red'
  function statusOf(prescribedDate, expiryMonths, today) {
    const t = thresholds(prescribedDate, expiryMonths);
    if (diffDays(t.red, today) >= 0) return 'red';
    if (diffDays(t.yellow, today) >= 0) return 'yellow';
    return 'green';
  }

  // "2027-10" → { y: 2027, m: 10 }。不正なら null
  function parseYearMonth(value) {
    const m = typeof value === 'string' && value.trim().match(/^(\d{4})[-/](\d{1,2})$/);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
    return { y: Number(m[1]), m: Number(m[2]) };
  }

  /*
   * 実際の使用期限（「2027年10月まで」のように月までの表記）からの判定日。
   *   期限日 : その月の末日まで有効
   *   黄色   : 期限日まで1年未満になる日 = 期限月の11ヶ月前の1日
   *   赤色   : 期限を超えた日 = 期限月の翌月1日
   */
  function actualThresholds(ym) {
    return {
      end: new Date(ym.y, ym.m, 0),
      yellow: new Date(ym.y, ym.m - 1 - 11, 1),
      red: new Date(ym.y, ym.m, 1),
    };
  }

  function statusByThresholds(t, today) {
    if (diffDays(t.red, today) >= 0) return 'red';
    if (diffDays(t.yellow, today) >= 0) return 'yellow';
    return 'green';
  }

  // 経過期間を「1年2ヶ月3日」の形で返す
  function elapsedText(from, to) {
    if (diffDays(from, to) < 0) return '処方日前';
    let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
    if (addMonths(from, months) > to) months--;
    const days = diffDays(addMonths(from, months), to);
    const y = Math.floor(months / 12);
    const mo = months % 12;
    let s = '';
    if (y) s += y + '年';
    if (mo) s += mo + 'ヶ月';
    if (days || !s) s += days + '日';
    return s;
  }

  // 有効期間表示 (24 → "2年", 18 → "1年6ヶ月")
  function monthsText(months) {
    const y = Math.floor(months / 12);
    const m = months % 12;
    return (y ? y + '年' : '') + (m ? m + 'ヶ月' : '') || '0ヶ月';
  }

  // ---- 処方メモの状態 ----
  // 'unissued' : 処方メモ未発行
  // 'waiting'  : 発行済だが、医師の指示記載をまだ確認していない（処方メモに指示が書かれていない）
  // 'written'  : 医師の指示が記載されたことを確認済み
  function memoState(u) {
    if (!u.memoIssued) return 'unissued';
    return u.instructed ? 'written' : 'waiting';
  }

  // 医師名の表記ゆれ（空白・全角半角）を同じ医師として扱うためのキー
  function doctorKey(name) {
    return String(name == null ? '' : name).normalize('NFKC').replace(/\s+/g, '');
  }

  // メモ発行日から今日までの経過日数（発行日が分からなければ null）
  function waitingDays(u, today) {
    const d = parseDate(String(u.memoIssuedAt || '').slice(0, 10));
    return d ? Math.max(0, diffDays(d, today)) : null;
  }

  // 医師ごとにまとめる。戻り値: [{ key, name, items: [使用記録...] }] を医師名のかな順
  // items は発行が古い（待たせている）順
  function groupByDoctor(usages) {
    const map = new Map();
    usages.forEach(function (u) {
      const k = doctorKey(u.doctorName);
      if (!map.has(k)) map.set(k, { key: k, name: String(u.doctorName || '').trim() || '（医師名なし）', items: [] });
      map.get(k).items.push(u);
    });
    const groups = Array.from(map.values());
    groups.forEach(function (g) {
      g.items.sort(function (a, b) {
        return String(a.memoIssuedAt || '').localeCompare(String(b.memoIssuedAt || '')) || a.no - b.no;
      });
    });
    groups.sort(function (a, b) { return a.name.localeCompare(b.name, 'ja'); });
    return groups;
  }

  return {
    memoState: memoState,
    doctorKey: doctorKey,
    waitingDays: waitingDays,
    groupByDoctor: groupByDoctor,
    parseDate: parseDate,
    toISO: toISO,
    formatDate: formatDate,
    addMonths: addMonths,
    addDays: addDays,
    diffDays: diffDays,
    thresholds: thresholds,
    statusOf: statusOf,
    parseYearMonth: parseYearMonth,
    actualThresholds: actualThresholds,
    statusByThresholds: statusByThresholds,
    elapsedText: elapsedText,
    monthsText: monthsText,
  };
});
