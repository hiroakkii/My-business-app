// 実行: node --test apps/visit-list/tests/schedule.test.js
const test = require('node:test');
const assert = require('node:assert');
const S = require('../schedule.js');

const H = (s) => S.parseHM(s);

test('条件の文字表示', () => {
  assert.strictEqual(S.ruleText({ kind: 'ok', from: '10:00', to: '12:00' }), '10:00〜12:00 可');
  assert.strictEqual(S.ruleText({ kind: 'ok', from: '14:00', to: '' }), '14:00以降 可');
  assert.strictEqual(S.ruleText({ kind: 'ok', from: '', to: '11:30' }), '11:30まで 可');
  assert.strictEqual(S.ruleText({ kind: 'ng', from: '12:00', to: '13:00' }), '12:00〜13:00 不可');
  assert.strictEqual(S.rulesText([{ kind: 'ok', from: '', to: '' }, { kind: 'ng', from: '13:00', to: '12:00' }]), ''); // 無効な行は無視
});

test('訪問できる時間帯の組み立て', () => {
  assert.strictEqual(S.intervalsOf([]), null);
  assert.deepStrictEqual(S.intervalsOf([{ kind: 'ok', from: '10:00', to: '12:00' }]), [[600, 720]]);
  assert.deepStrictEqual(S.intervalsOf([{ kind: 'ok', from: '14:00', to: '' }]), [[840, 1440]]);
  assert.deepStrictEqual(S.intervalsOf([{ kind: 'ng', from: '12:00', to: '13:00' }]), [[0, 720], [780, 1440]]);
  // 9〜11時 か 14〜16時、ただし 10:30〜10:45 は不可
  assert.deepStrictEqual(S.intervalsOf([
    { kind: 'ok', from: '09:00', to: '11:00' }, { kind: 'ok', from: '14:00', to: '16:00' }, { kind: 'ng', from: '10:30', to: '10:45' },
  ]), [[540, 630], [645, 660], [840, 960]]);
  // グループホーム: 2名の条件を両方満たす時間
  assert.deepStrictEqual(S.intervalsOfStop([[{ kind: 'ok', from: '10:00', to: '15:00' }], [], [{ kind: 'ok', from: '13:00', to: '' }]]), [[780, 900]]);
  assert.strictEqual(S.intervalsOfStop([[], []]), null);
});

test('早く着いたら待つ・滞在が時間内に収まらなければ次の時間帯', () => {
  assert.deepStrictEqual(S.placeVisit(H('09:40'), [[600, 720]], 15), { begin: 600, late: 0 });
  // 10:50 着、10:30〜11:00 と 14:00〜 → 15分が収まらないので 14:00
  assert.deepStrictEqual(S.placeVisit(H('10:50'), [[630, 660], [840, 1440]], 15), { begin: 840, late: 0 });
  // 間に合わない
  assert.deepStrictEqual(S.placeVisit(H('11:55'), [[600, 720]], 15), { begin: 715, late: 10 });
});

test('時間の条件を守る順番を選ぶ', () => {
  // 一直線に並んだ4か所（事業所=0）。距離だけなら 1→2→3→4 だが、4 は 10時まで、1 は 11時以降
  const pos = [0, 1, 2, 3, 4]; // km
  const travel = (i, j) => Math.abs(pos[i] - pos[j]) / 20 * 60;
  const intervals = [null, [[H('11:00'), 1440]], null, null, [[0, H('10:00')]]];
  const ctx = { travel, start: H('09:30'), svc: 15, intervals, hasDepot: true, roundTrip: true };
  const { order, sched } = S.solveTimed(5, ctx);
  assert.strictEqual(sched.lateSum, 0);
  assert.ok(order.indexOf(4) < order.indexOf(1), '10時までの患者を先に');
  const v4 = sched.visits.find((v) => v.idx === 4);
  assert.ok(v4.begin + 15 <= H('10:00'));
  const v1 = sched.visits.find((v) => v.idx === 1);
  assert.ok(v1.begin >= H('11:00'));
});

test('条件が無ければ移動の短い順', () => {
  const pos = [0, 1, 2, 3];
  const travel = (i, j) => Math.abs(pos[i] - pos[j]) / 20 * 60;
  const ctx = { travel, start: H('09:30'), svc: 15, intervals: [null, null, null, null], hasDepot: true, roundTrip: false };
  assert.deepStrictEqual(S.solveTimed(4, ctx).order, [0, 1, 2, 3]);
});

test('訪問先が多い場合（近似計算）でも時間を守る', () => {
  const n = 16;
  const pos = Array.from({ length: n }, (_, i) => i * 0.8);
  const travel = (i, j) => Math.abs(pos[i] - pos[j]) / 20 * 60;
  const intervals = Array(n).fill(null);
  intervals[15] = [[0, H('10:30')]]; // 一番遠い所を 10:30 まで
  intervals[2] = [[H('12:00'), 1440]];
  const ctx = { travel, start: H('09:30'), svc: 15, intervals, hasDepot: true, roundTrip: true };
  const { sched } = S.solveTimed(n, ctx);
  assert.strictEqual(sched.lateSum, 0);
});

test('どうしても間に合わない場合は時間外を報告', () => {
  const travel = () => 60;
  const ctx = { travel, start: H('09:30'), svc: 15, intervals: [null, [[0, H('10:00')]]], hasDepot: true, roundTrip: true };
  const { sched } = S.solveTimed(2, ctx);
  assert.ok(sched.visits[0].late > 0);
});

test('経路の相談文用の短い表記', () => {
  assert.strictEqual(S.rulesShort([{ kind: 'ok', from: '12:00', to: '16:00' }]), '12-16時可');
  assert.strictEqual(S.rulesShort([{ kind: 'ok', from: '13:00', to: '' }]), '13時以降可');
  assert.strictEqual(S.rulesShort([{ kind: 'ng', from: '12:00', to: '13:00' }]), '12-13時不可');
  assert.strictEqual(S.rulesShort([{ kind: 'ok', from: '', to: '11:30' }]), '11:30まで可');
  assert.strictEqual(S.rulesShort([{ kind: 'ok', from: '09:00', to: '11:00' }, { kind: 'ng', from: '10:00', to: '10:30' }]), '9-11時可、10:00-10:30不可');
  assert.strictEqual(S.stopRulesShort([[], []]), '');
  assert.strictEqual(S.stopRulesShort([[{ kind: 'ng', from: '12:00', to: '13:00' }], []]), '12-13時不可');
  // グループホームで2名に条件 → 両方を満たす時間
  assert.strictEqual(S.stopRulesShort([[{ kind: 'ok', from: '10:00', to: '15:00' }], [{ kind: 'ok', from: '13:00', to: '' }]]), '13-15時可');
  assert.strictEqual(S.stopRulesShort([[{ kind: 'ok', from: '09:00', to: '10:00' }], [{ kind: 'ok', from: '13:00', to: '' }]]), '訪問できる時間なし（条件が重ならない）');
});
