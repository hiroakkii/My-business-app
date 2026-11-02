// 実行: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/logic.js');

const d = (s) => L.parseDate(s);
const fmt = (x) => L.formatDate(x);

test('仕様の例: 2026/10/29 処方・有効期限2年', () => {
  const t = L.thresholds(d('2026/10/29'), 24);
  assert.equal(fmt(t.yellow), '2027/10/29');
  assert.equal(fmt(t.red), '2028/10/29');
});

test('色の切り替わりは当日から', () => {
  const p = d('2026/10/29');
  assert.equal(L.statusOf(p, 24, d('2027/10/28')), 'green');
  assert.equal(L.statusOf(p, 24, d('2027/10/29')), 'yellow');
  assert.equal(L.statusOf(p, 24, d('2028/10/28')), 'yellow');
  assert.equal(L.statusOf(p, 24, d('2028/10/29')), 'red');
  assert.equal(L.statusOf(p, 24, d('2030/01/01')), 'red');
});

test('うるう日の処方は月末に丸める', () => {
  const t = L.thresholds(d('2028/02/29'), 24);
  assert.equal(fmt(t.yellow), '2029/02/28');
  assert.equal(fmt(t.red), '2030/02/28');
});

test('奇数月は日数の半分で黄色', () => {
  const t = L.thresholds(d('2026/01/01'), 3); // 赤 2026/04/01, 90日 → 45日後
  assert.equal(fmt(t.red), '2026/04/01');
  assert.equal(fmt(t.yellow), '2026/02/15');
});

test('経過期間の表示', () => {
  assert.equal(L.elapsedText(d('2026/10/29'), d('2026/10/29')), '0日');
  assert.equal(L.elapsedText(d('2026/10/29'), d('2027/10/29')), '1年');
  assert.equal(L.elapsedText(d('2026/10/29'), d('2028/01/02')), '1年2ヶ月4日');
  assert.equal(L.elapsedText(d('2026/01/31'), d('2026/03/01')), '1ヶ月1日');
});

test('不正な日付は null', () => {
  assert.equal(L.parseDate('2026/02/30'), null);
  assert.equal(L.parseDate('abc'), null);
  assert.equal(fmt(L.parseDate('2026-10-29')), '2026/10/29');
});

test('実際の使用期限: 月末まで有効、1年未満で黄色、超過で赤色', () => {
  const t = L.actualThresholds(L.parseYearMonth('2027-10'));
  assert.equal(fmt(t.end), '2027/10/31');
  assert.equal(fmt(t.yellow), '2026/11/01');
  assert.equal(fmt(t.red), '2027/11/01');
  const st = (s) => L.statusByThresholds(t, d(s));
  assert.equal(st('2026/10/31'), 'green'); // 残りちょうど1年
  assert.equal(st('2026/11/01'), 'yellow'); // 1年未満
  assert.equal(st('2027/10/31'), 'yellow'); // 期限当日まで有効
  assert.equal(st('2027/11/01'), 'red');
});

test('年月の解析', () => {
  assert.deepEqual(L.parseYearMonth('2027-01'), { y: 2027, m: 1 });
  assert.equal(L.parseYearMonth('2027-13'), null);
  assert.equal(L.parseYearMonth(''), null);
  const t = L.actualThresholds({ y: 2027, m: 2 });
  assert.equal(fmt(t.end), '2027/02/28');
  assert.equal(fmt(t.yellow), '2026/03/01');
});
