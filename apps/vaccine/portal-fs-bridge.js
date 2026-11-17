/*
 * まとめ版（上部タブ）の中で動かすときだけ働く補助スクリプト。
 *
 * パソコン内のファイルとして開いた場合、Chrome / Edge はタブの中（iframe）からの
 * フォルダ選択（showDirectoryPicker）を禁止しています。そのため「バックアップ保存先フォルダ」の
 * 選択・保存・復元を、外側のまとめ画面（../../index.html）に代わりに行ってもらいます。
 *
 * このアプリを単独で開いたとき（タブの中でないとき）は何もしません。
 * 保存先フォルダの記録は単独で開いたときと同じ場所（IndexedDB 'vaccineKanri.fs'）を使うので、
 * どちらで設定しても同じフォルダが使われます。
 */
(function () {
  'use strict';
  if (window.parent === window) return;                       // 単独で開いている
  try { void window.parent.document; return; } catch (e) {}   // 同じオリジンなら通常どおりフォルダを選べる
  if (typeof window.showDirectoryPicker !== 'function') return; // フォルダ機能の無いブラウザ

  var CFG = { db: 'vaccineKanri.fs', store: 'h', key: 'backupDir', pickerId: 'vaccineKanriBackup' };
  var seq = 0, waits = {};

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (e.source !== window.parent || !d || d.portalFs !== 1 || !waits[d.id]) return;
    var w = waits[d.id]; delete waits[d.id];
    if (d.ok) w.res(d.v);
    else { var err = new Error(d.v && d.v.message || ''); err.name = d.v && d.v.name || 'Error'; w.rej(err); }
  });

  function call(op, args, timeout) {
    return new Promise(function (res, rej) {
      var id = ++seq;
      waits[id] = { res: res, rej: rej };
      window.parent.postMessage({ portalFs: 1, id: id, op: op, args: args || {}, cfg: CFG }, '*');
      if (timeout) setTimeout(function () {
        if (waits[id]) { delete waits[id]; var e = new Error('timeout'); e.name = 'TimeoutError'; rej(e); }
      }, timeout);
    });
  }

  function fileHandle(name, info) {
    return {
      kind: 'file', name: name,
      getFile: function () {
        return Promise.resolve({
          name: name, lastModified: info ? info.lastModified : Date.now(), size: info ? info.size : 0,
          text: function () { return call('read', { name: name }); }
        });
      },
      createWritable: function () {
        var parts = [];
        return Promise.resolve({
          write: function (data) { parts.push(data); return Promise.resolve(); },
          close: function () { return call('write', { name: name, data: new Blob(parts) }); }
        });
      }
    };
  }

  // アプリから見ると普通のフォルダ（FileSystemDirectoryHandle）と同じように使える代理オブジェクト
  function dirProxy(name) {
    return {
      kind: 'directory', name: name,
      queryPermission: function () { return call('perm', { request: false }); },
      requestPermission: function () { return call('perm', { request: true }); },
      getFileHandle: function (n) { return Promise.resolve(fileHandle(n)); },
      entries: async function* () {
        var list = await call('list');
        for (var i = 0; i < list.length; i++) {
          var x = list[i];
          yield [x.name, x.kind === 'file' ? fileHandle(x.name, x) : { kind: x.kind, name: x.name }];
        }
      }
    };
  }

  call('hello', null, 3000).then(async function () {
    // 元のアプリの関数を、外側のまとめ画面に頼む版に置き換える
    window.chooseBackupDir = async function () {
      try {
        var r = await call('pick');
        backupDir = dirProxy(r.name); // eslint-disable-line no-undef
        return true;
      } catch (e) {
        if (e && e.name !== 'AbortError') alert('このフォルダは選べませんでした。\n「デスクトップ」「ドキュメント」「ダウンロード」そのものは選べないため、その中に専用のフォルダを作って選んでください。\n\n' + e.message);
        return false;
      }
    };
    try { await dirReady; } catch (e) {} // eslint-disable-line no-undef
    var st = await call('status');
    backupDir = st ? dirProxy(st.name) : null; // eslint-disable-line no-undef
  }).catch(function () { /* まとめ画面以外の中で開かれている：何もしない */ });
})();
