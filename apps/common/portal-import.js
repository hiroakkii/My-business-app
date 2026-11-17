/*
 * まとめ版（上部タブ）の「患者マスタ一括取込」用の補助スクリプト。
 *
 * 外側のまとめ画面（../../index.html）から患者マスタの Excel ファイルを受け取り、
 * このアプリの「患者マスタ取込」と同じ手順（ファイル選択 → 確認画面で OK）を自動で行います。
 * 取り込みの中身（列の判別・WA／[亘] の除外・グループホームの判定など）は、各アプリの処理そのものです。
 *
 * <script src="../common/portal-import.js" data-app="stock"></script> のように、アプリの最後で読み込みます。
 * アプリを単独で開いたとき（タブの中でないとき）は何もしません。
 */
(function () {
  'use strict';
  if (window.parent === window) return;
  var me = document.currentScript;
  var APP = me && me.dataset.app;

  // アプリごとの手順
  //  input: 患者マスタのファイル選択欄 / ok: 確認画面の取込ボタン（無ければ結果はメッセージで分かる）
  //  success: 成功したときのメッセージ / summary: 確認画面から結果の説明を読み取る
  var CONFIG = {
    stock: { input: '#patient-file', success: /名を読み込みました/ },
    jisan: { input: '#masterIn', success: /患者名簿を取り込みました/ },
    order: {
      input: '#file-input', dialog: '#import-dialog', ok: '#btn-import-ok',
      summary: function () { return text('#preview-info') + ' ' + text('#mapping-warnings'); }
    },
    'visit-list': {
      input: '#file-input', dialog: '#import-dialog', ok: '#btn-import-ok',
      summary: function () { return text('#preview-info') + ' ' + text('#mapping-warnings'); }
    },
    vaccine: {
      // まとめ画面で一括バックアップしたら、このアプリでバックアップしたときと同じように記録する
      // （「未保存の変更あり」の表示と、閉じるときの確認を出さないようにする）
      onBackedUp: function (label) {
        /* global state, persist, renderHeader */
        state.lastBackup = label; state.dirty = false; persist(false); renderHeader();
      },
      input: '#fileMaster', dialog: '#dlg', ok: '#mOk', closeDialogsFirst: true,
      ready: function () { return /患者マスタの読み込み/.test(text('#dlgTitle')); },
      summary: function () { var m = text('#dlgBody').match(/読み込み件数[^\n]*/); return m ? m[0] : ''; }
    }
  };
  var cfg = CONFIG[APP];
  if (!cfg) return;

  // 各アプリの言い方の違う結果を「○名を取り込みました（○名は除外）」にそろえる
  function tidy(msg) {
    var s = String(msg || '').replace(/\s+/g, ' ');
    var n = s.match(/(\d[\d,]*)\s*(?:名|人|件)\s*を(?:読み込み|取り込み)/) || s.match(/取込対象\s*(\d[\d,]*)\s*件/) ||
      s.match(/読み込み件数：\s*(\d[\d,]*)\s*名/) || s.match(/取り込みました:\s*(\d[\d,]*)\s*人/);
    var x = s.match(/(\d[\d,]*)\s*(?:名|人|件)\s*(?:は除外|は取り込みません)/);
    if (!n) return s;
    return n[1] + '名を取り込みました' + (x ? '（ID に WA・名前に [亘] の ' + x[1] + '名は除外）' : '');
  }

  function $(s) { return document.querySelector(s); }
  function text(s) { var el = $(s); return el ? el.innerText.replace(/[ \t]+/g, ' ').trim() : ''; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  async function waitFor(fn, ms) {
    for (var t = 0; t < ms; t += 100) { var v = fn(); if (v) return v; await sleep(100); }
    return null;
  }

  var busy = false;
  async function run(file) {
    var alerts = [], origAlert = window.alert, origConfirm = window.confirm;
    // 取り込み中のメッセージは画面に出さずに結果としてまとめ画面へ返す
    window.alert = function (m) { alerts.push(String(m)); };
    window.confirm = function () { return true; };
    try {
      if (cfg.closeDialogsFirst) document.querySelectorAll('dialog[open]').forEach(function (d) { d.close(); });
      var input = $(cfg.input);
      if (!input) throw new Error('取込欄が見つかりません');
      var dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));

      if (cfg.ok) {
        // 確認画面が出て、自動判別が終わるのを待つ
        var btn = await waitFor(function () {
          if (alerts.length) return 'alert';
          var d = $(cfg.dialog), b = $(cfg.ok);
          return d && d.open && b && (!cfg.ready || cfg.ready()) ? b : null;
        }, 20000);
        if (btn === 'alert') return { ok: false, message: alerts.join('\n') };
        if (!btn) return { ok: false, message: '確認画面が表示されませんでした。' };
        await sleep(300);
        var summary = cfg.summary ? cfg.summary() : '';
        if (btn.disabled) {
          return { ok: false, message: '列を自動で判別できませんでした。このタブを開いて、取込確認画面で列を指定してください。' + (summary ? '\n' + summary : '') };
        }
        btn.click();
        await sleep(300);
        if (alerts.length) return { ok: false, message: alerts.join('\n') };
        return { ok: true, message: tidy(summary) };
      }

      var msg = await waitFor(function () { return alerts.length ? alerts[0] : null; }, 20000);
      if (!msg) return { ok: false, message: '取込結果が確認できませんでした。このタブを開いて確認してください。' };
      return cfg.success.test(msg) ? { ok: true, message: tidy(msg) } : { ok: false, message: msg };
    } finally {
      window.alert = origAlert;
      window.confirm = origConfirm;
    }
  }

  window.addEventListener('message', async function (e) {
    var d = e.data;
    if (e.source !== window.parent || !d || d.portalImport !== 1) return;
    var reply = function (v) { v.portalImport = 1; v.id = d.id; window.parent.postMessage(v, '*'); };
    if (d.op === 'ping') { reply({ ok: true, app: APP }); return; }
    if (d.op === 'backedUp') {
      try { if (cfg.onBackedUp) cfg.onBackedUp(String(d.label || '')); reply({ ok: true }); }
      catch (err) { reply({ ok: false, message: err && err.message || String(err) }); }
      return;
    }
    if (d.op !== 'run' || !(d.file instanceof Blob)) return;
    if (busy) { reply({ ok: false, message: '取り込み中です。' }); return; }
    busy = true;
    try { reply(await run(d.file)); }
    catch (err) { reply({ ok: false, message: err && err.message || String(err) }); }
    finally { busy = false; }
  });
})();
