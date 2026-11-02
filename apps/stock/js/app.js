/* 在宅 抗菌薬・解熱鎮痛薬 在庫管理 */
(function () {
  'use strict';

  const L = window.StockLogic;
  const STORAGE_KEY = 'abx-stock-control-v1';
  const CATEGORIES = ['抗菌薬', '解熱鎮痛薬', '麻薬'];

  const DEFAULT_SETTINGS = {
    memoTitle: '処方メモ（お守り薬）',
    doctors: [],
  };

  // ---------- データ保存 ----------
  let db = load();

  function load() {
    let data = null;
    try {
      data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch (e) {
      data = null;
    }
    data = data || {};
    const saved = data.settings || {};
    if (saved.memoTitle === '処方メモ（在庫薬使用）') delete saved.memoTitle; // 旧初期値は新しい表題に置き換える
    return {
      drugs: data.drugs || [],
      patients: data.patients || [],
      stocks: data.stocks || [],
      usages: data.usages || [],
      settings: Object.assign({}, DEFAULT_SETTINGS, saved),
      nextUsageNo: data.nextUsageNo || 1,
    };
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    } catch (e) {
      alert('データを保存できませんでした。ブラウザの設定（保存領域）をご確認ください。\n' + e.message);
    }
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---------- 共通 ----------
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function today() {
    return L.parseDate(new Date());
  }

  function fmtISO(iso) {
    const d = L.parseDate(iso || '');
    return d ? L.formatDate(d) : '';
  }

  function formData(form) {
    const o = {};
    new FormData(form).forEach((v, k) => { o[k] = typeof v === 'string' ? v.trim() : v; });
    return o;
  }

  function fillForm(form, obj) {
    $$('input, select, textarea', form).forEach((el) => {
      if (!el.name || !(el.name in obj)) return;
      if (el.type === 'checkbox') el.checked = !!obj[el.name];
      else el.value = obj[el.name] == null ? '' : obj[el.name];
    });
  }

  function findDrug(name) {
    return db.drugs.find((d) => d.name === name);
  }

  // 実際の使用期限があればそれを優先し、無ければ処方日＋製造からの有効期限で判定する
  function judge(prescribedDate, expiryMonths, actualExpiry) {
    const p = L.parseDate(prescribedDate || '');
    const ym = L.parseYearMonth(actualExpiry || '');
    let t;
    if (ym) t = L.actualThresholds(ym);
    else if (p && expiryMonths) t = L.thresholds(p, expiryMonths);
    else return null;
    return {
      status: L.statusByThresholds(t, today()),
      yellow: t.yellow,
      red: t.red,
      actual: !!ym,
      elapsed: p ? L.elapsedText(p, today()) : '',
    };
  }

  // 使用開始指示済みで、処方メモが未発行の使用記録（あれば）
  function pendingUsage(s) {
    return db.usages.find((u) => u.stockId === s.id && !u.memoIssued) || null;
  }

  function latestUsage(s) {
    const list = db.usages.filter((u) => u.stockId === s.id);
    return list.length ? list[list.length - 1] : null;
  }

  function stockStatus(s) {
    return judge(s.prescribedDate, s.expiryMonths, s.actualExpiry);
  }

  function expiryLabel(s) {
    const ym = L.parseYearMonth(s.actualExpiry || '');
    return (ym ? '<b>' + ym.y + '年' + ym.m + '月まで</b><br><small>実際の期限</small>' : '') +
      (ym && s.expiryMonths ? '<br>' : '') +
      (s.expiryMonths ? (ym ? '<small>製造から ' + L.monthsText(s.expiryMonths) + '</small>' : L.monthsText(s.expiryMonths)) : '');
  }

  const STATUS_LABEL = { green: '期限内', yellow: '黄', red: '赤' };

  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  // ---------- タブ ----------
  function showTab(name) {
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
    render();
  }

  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) showTab(b.dataset.tab);
  });

  // ---------- 入力補助 (datalist) ----------
  function renderDatalists() {
    $('#dl-drugs').innerHTML = db.drugs.map((d) =>
      '<option value="' + esc(d.name) + '">' + esc(d.category + (d.spec ? ' ' + d.spec : '') + ' / 有効期限 ' + L.monthsText(d.expiryMonths)) + '</option>'
    ).join('');
    $('#dl-doctors').innerHTML = db.settings.doctors.map((n) => '<option value="' + esc(n) + '">').join('');
    // 患者マスタ（ID・カナを補足表示）＋ これまでに在庫登録した患者名
    const known = new Set(db.patients.map((p) => p.name));
    const others = Array.from(new Set(db.stocks.map((s) => s.patientName).filter((n) => n && !known.has(n)))).sort();
    $('#dl-patients').innerHTML =
      db.patients.map((p) => '<option value="' + esc(p.name) + '">' + esc([p.id, p.kana].filter(Boolean).join(' ')) + '</option>').join('') +
      others.map((n) => '<option value="' + esc(n) + '">').join('');
  }

  // ---------- 在庫一覧 ----------
  function renderStock() {
    const q = $('#stock-search').value.trim();
    const cat = $('#stock-filter-category').value;
    const st = $('#stock-filter-status').value;
    const showClosed = $('#stock-show-closed').checked;
    const order = { red: 0, yellow: 1, green: 2 };

    const rows = db.stocks
      .map((s) => ({ s: s, info: stockStatus(s), pending: pendingUsage(s) }))
      .filter(({ s, info, pending }) => {
        if (!showClosed && s.state !== '在庫' && !pending) return false;
        if (cat && s.category !== cat) return false;
        if (st && (!info || info.status !== st)) return false;
        if (q && !(s.patientName + ' ' + s.drugName + ' ' + (s.patientId || '')).includes(q)) return false;
        return true;
      })
      .sort((a, b) =>
        (b.pending ? 1 : 0) - (a.pending ? 1 : 0) ||
        (a.s.state === '在庫' ? 0 : 1) - (b.s.state === '在庫' ? 0 : 1) ||
        (order[a.info && a.info.status] ?? 3) - (order[b.info && b.info.status] ?? 3) ||
        a.s.patientName.localeCompare(b.s.patientName, 'ja') ||
        a.s.prescribedDate.localeCompare(b.s.prescribedDate)
      );

    const active = db.stocks.filter((s) => s.state === '在庫').map(stockStatus).filter(Boolean);
    const pendingCount = db.stocks.filter((s) => pendingUsage(s)).length;
    const count = (k) => active.filter((i) => i.status === k).length;
    $('#stock-summary').innerHTML =
      'お守り薬 <b>' + active.length + '</b> 件　' +
      '<span class="chip red">赤 ' + count('red') + '</span>' +
      '<span class="chip yellow">黄 ' + count('yellow') + '</span>' +
      '<span class="chip green">期限内 ' + count('green') + '</span>' +
      (pendingCount ? '　<span class="chip red">処方メモ未発行 ' + pendingCount + '</span>' : '');

    $('#stock-table tbody').innerHTML = rows.map(({ s, info, pending }) => {
      const cls = pending ? 'row-pending' : s.state !== '在庫' ? 'row-closed' : info ? 'row-' + info.status : '';
      const statusCell = pending
        ? '<span class="chip red">メモ未発行</span><br><small>使用開始 ' + fmtISO(pending.startDate) + '</small>'
        : s.state !== '在庫'
          ? esc(s.state)
          : info ? '<span class="chip ' + info.status + '">' + STATUS_LABEL[info.status] + '</span>' : '-';
      const ops = pending
        ? '<button data-act="memo" data-id="' + s.id + '" class="primary small">処方メモ発行</button>' +
          '<button data-act="edit-use" data-id="' + s.id + '" class="small">使用開始を編集</button>' +
          '<button data-act="cancel-use" data-id="' + s.id + '" class="small danger">使用開始を取り消す</button>'
        : s.state === '在庫'
        ? (s.category === '抗菌薬' ? '<button data-act="use" data-id="' + s.id + '" class="primary small">使用開始指示</button>' : '') +
          '<button data-act="edit" data-id="' + s.id + '" class="small">編集</button>' +
          '<button data-act="discard" data-id="' + s.id + '" class="small">廃棄</button>'
        : (latestUsage(s) && s.state === '使用済'
          ? '<button data-act="cancel-use" data-id="' + s.id + '" class="small danger">使用開始を取り消す</button>'
          : '<button data-act="restore" data-id="' + s.id + '" class="small">お守り薬に戻す</button>') +
          '<button data-act="delete" data-id="' + s.id + '" class="small danger">削除</button>';
      return '<tr class="' + cls + '">' +
        '<td>' + statusCell + '</td>' +
        '<td>' + esc(s.patientName) + (s.patientId ? '<br><small>' + esc(s.patientId) + '</small>' : '') + '</td>' +
        '<td>' + esc(s.drugName) + '<br><small>' + esc(s.category) + '</small></td>' +
        '<td class="num">' + esc(s.quantity) + esc(s.unit) + '</td>' +
        '<td>' + fmtISO(s.prescribedDate) + (info ? '<br><small>' + esc(info.elapsed) + '</small>' : '') + '</td>' +
        '<td>' + expiryLabel(s) + '</td>' +
        '<td>' + (info ? '<span class="dot yellow"></span>' + L.formatDate(info.yellow) + '<br><span class="dot red"></span>' + L.formatDate(info.red) : '') + '</td>' +
        '<td>' + esc(s.prescriber) + '</td>' +
        '<td><div class="ops">' + ops + '</div></td>' +
        '</tr>';
    }).join('') || '<tr><td colspan="9" class="empty">該当するお守り薬はありません</td></tr>';
  }

  ['#stock-search', '#stock-filter-category', '#stock-filter-status', '#stock-show-closed'].forEach((sel) =>
    $(sel).addEventListener('input', renderStock));

  $('#stock-table').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const s = db.stocks.find((x) => x.id === b.dataset.id);
    if (!s) return;
    switch (b.dataset.act) {
      case 'use': openUseDialog(s); break;
      case 'memo': openMemo([pendingUsage(s)]); break;
      case 'edit-use': openUseDialog(null, pendingUsage(s)); break;
      case 'cancel-use': {
        const u = latestUsage(s);
        if (!u) break;
        const msg = s.patientName + ' の「' + s.drugName + '」の使用開始指示（使用開始日 ' + fmtISO(u.startDate) + '）を取り消します。\n' +
          '使用記録No.' + u.no + ' は削除され、お守り薬は一覧に戻ります。' +
          (u.memoIssued ? '\n※ 処方メモは発行済みです。' : '') + '\nよろしいですか？';
        if (!confirm(msg)) break;
        db.usages = db.usages.filter((x) => x !== u);
        if (s.state === '使用済') s.state = '在庫';
        save(); render();
        break;
      }
      case 'edit': editStock(s); break;
      case 'discard':
        if (confirm(s.patientName + ' の「' + s.drugName + '」を廃棄済にしますか？')) {
          s.state = '廃棄'; save(); render();
        }
        break;
      case 'restore': s.state = '在庫'; save(); render(); break;
      case 'delete':
        if (confirm('このお守り薬のデータを削除します。よろしいですか？（使用記録は残ります）')) {
          db.stocks = db.stocks.filter((x) => x !== s); save(); render();
        }
        break;
    }
  });

  // ---------- お守り薬登録 ----------
  const stockForm = $('#stock-form');
  const rowsBox = $('#drug-rows');
  let editingId = '';

  function categoryOptions() {
    return CATEGORIES.map((c) => '<option>' + c + '</option>').join('');
  }

  function addDrugRow(values) {
    const v = values || {};
    const row = document.createElement('div');
    row.className = 'drug-row';
    row.innerHTML =
      '<div class="drug-row-head"><b class="drug-no"></b><button type="button" class="small danger" data-act="remove-row">この薬剤を削除</button></div>' +
      '<div class="form drug-row-body">' +
      '<label>薬剤名 <span class="req">*</span><input data-f="drugName" list="dl-drugs" required placeholder="薬剤マスタから入力補助されます"><small class="hint" data-r="hint"></small><div class="warn" data-r="warn"></div></label>' +
      '<label>区分 <span class="req">*</span><select data-f="category" required>' + categoryOptions() + '</select></label>' +
      '<label>数量<span class="inline"><input data-f="quantity" type="number" min="0" step="any"><input data-f="unit" class="unit" placeholder="錠"></span></label>' +
      '<label>有効期限（製造から）<span class="inline">' +
        '<input data-f="expiryYears" type="number" min="0" step="1" class="short"> 年 ' +
        '<input data-f="expiryMonthsRest" type="number" min="0" max="11" step="1" class="short"> ヶ月</span>' +
        '<small class="hint">薬剤マスタの値が自動で入ります。個別に変更も可能です。</small></label>' +
      '<label>実際の使用期限（任意）<input data-f="actualExpiry" type="month">' +
        '<small class="hint">薬局等で確認できた場合のみ。「2027年10月まで」なら 2027年10月 と入力（月末まで有効として判定）。入力すると製造からの期限より優先され、期限まで1年未満で黄色、期限を超えると赤色になります。</small></label>' +
      '<label class="wide">備考<input data-f="note"></label>' +
      '<div class="preview wide" data-r="preview"></div>' +
      '</div>';
    rowsBox.appendChild(row);
    const f = (n) => $('[data-f=' + n + ']', row);
    f('drugName').value = v.drugName || '';
    f('category').value = v.category || CATEGORIES[0];
    f('quantity').value = v.quantity || '';
    f('unit').value = v.unit || '';
    f('note').value = v.note || '';
    f('actualExpiry').value = v.actualExpiry || '';
    f('expiryYears').value = v.expiryMonths ? Math.floor(v.expiryMonths / 12) : '';
    f('expiryMonthsRest').value = v.expiryMonths ? v.expiryMonths % 12 : '';
    renumberRows();
    updateRowPreview(row);
    updateRowWarn(row);
    return row;
  }

  // マスタの有効期限を確認していない薬剤を選んだら警告し、薬剤マスタへ誘導する
  function updateRowWarn(row) {
    const d = editingId ? null : findDrug($('[data-f=drugName]', row).value);
    const el = $('[data-r=warn]', row);
    el.innerHTML = d && !d.verified
      ? '⚠ この薬剤の有効期限は<b>未確認</b>です（マスタの設定: ' + L.monthsText(d.expiryMonths) + '）。' +
        '実際の有効期限を確認し、薬剤マスタで「確認済みにする」を押してください。<br>' +
        '<a href="#" data-act="open-master" data-name="' + esc(d.name) + '">薬剤マスタで確認する →</a>'
      : '';
  }

  function renumberRows() {
    const rows = $$('.drug-row', rowsBox);
    rows.forEach((r, i) => {
      $('.drug-no', r).textContent = '薬剤 ' + (i + 1);
      $('[data-act=remove-row]', r).style.display = rows.length > 1 && !editingId ? '' : 'none';
    });
    $('#drug-add-wrap').style.display = editingId ? 'none' : '';
  }

  function rowExpiry(row) {
    return (Number($('[data-f=expiryYears]', row).value) || 0) * 12 + (Number($('[data-f=expiryMonthsRest]', row).value) || 0);
  }

  function updateRowPreview(row) {
    const j = judge(stockForm.prescribedDate.value, rowExpiry(row), $('[data-f=actualExpiry]', row).value);
    $('[data-r=preview]', row).innerHTML = j
      ? (j.actual ? '（実際の使用期限で判定）　' : '') +
        '<span class="chip yellow">黄色</span> ' + L.formatDate(j.yellow) + ' から　' +
        '<span class="chip red">赤色</span> ' + L.formatDate(j.red) + ' から'
      : '';
  }

  function resetStockForm() {
    editingId = '';
    stockForm.reset();
    stockForm.id.value = '';
    stockForm.prescribedDate.value = L.toISO(today());
    rowsBox.innerHTML = '';
    addDrugRow();
    $('#register-title').textContent = 'お守り薬登録';
  }

  function editStock(s) {
    resetStockForm();
    editingId = s.id;
    fillForm(stockForm, s);
    rowsBox.innerHTML = '';
    addDrugRow(s);
    $('#register-title').textContent = 'お守り薬の編集';
    showTab('register');
  }

  // 患者マスタにある患者名を選んだら、患者IDを自動で入れる
  stockForm.patientName.addEventListener('input', () => {
    const p = db.patients.find((x) => x.name === stockForm.patientName.value.trim());
    if (p && p.id) stockForm.patientId.value = p.id;
  });

  stockForm.prescribedDate.addEventListener('input', () => $$('.drug-row', rowsBox).forEach(updateRowPreview));

  rowsBox.addEventListener('input', (e) => {
    const row = e.target.closest('.drug-row');
    if (!row) return;
    const f = (n) => $('[data-f=' + n + ']', row);
    if (e.target === f('drugName')) {
      const d = findDrug(f('drugName').value);
      if (d) {
        f('category').value = d.category;
        f('expiryYears').value = Math.floor(d.expiryMonths / 12) || '';
        f('expiryMonthsRest').value = d.expiryMonths % 12 || '';
        if (d.unit) f('unit').value = d.unit;
        $('[data-r=hint]', row).textContent = '薬剤マスタ: ' + d.category + (d.spec ? ' / ' + d.spec : '') + ' / 有効期限 ' + L.monthsText(d.expiryMonths);
      } else {
        $('[data-r=hint]', row).textContent = f('drugName').value && db.drugs.length ? 'マスタに無い薬剤です（区分・有効期限を手入力してください）' : '';
      }
    }
    updateRowPreview(row);
    updateRowWarn(row);
  });

  rowsBox.addEventListener('click', (e) => {
    const link = e.target.closest('[data-act=open-master]');
    if (link) {
      e.preventDefault();
      $('#master-search').value = link.dataset.name;
      $('#master-unverified').checked = false;
      showTab('master');
      return;
    }
    const b = e.target.closest('[data-act=remove-row]');
    if (!b) return;
    b.closest('.drug-row').remove();
    renumberRows();
  });

  $('#drug-add').addEventListener('click', () => {
    addDrugRow().querySelector('[data-f=drugName]').focus();
  });

  stockForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = formData(stockForm);
    if (!L.parseDate(f.prescribedDate)) { alert('処方日を正しく入力してください。'); return; }
    const recs = [];
    const rows = $$('.drug-row', rowsBox);
    for (let i = 0; i < rows.length; i++) {
      const g = (n) => $('[data-f=' + n + ']', rows[i]).value.trim();
      const expiryMonths = rowExpiry(rows[i]);
      const actualExpiry = g('actualExpiry');
      if (!expiryMonths && !actualExpiry) { alert('薬剤 ' + (i + 1) + '：製造からの有効期限、または実際の使用期限を入力してください。'); return; }
      recs.push({
        patientName: f.patientName,
        patientId: f.patientId,
        drugName: g('drugName'),
        category: g('category'),
        quantity: g('quantity'),
        unit: g('unit'),
        prescribedDate: f.prescribedDate,
        expiryMonths: expiryMonths,
        actualExpiry: actualExpiry,
        prescriber: f.prescriber,
        note: g('note'),
      });
    }
    const unverified = Array.from(new Set(recs.map((r) => findDrug(r.drugName)).filter((d) => d && !d.verified).map((d) => d.name)));
    if (!editingId && unverified.length &&
        !confirm('次の薬剤は、有効期限をまだ確認していません。\n・' + unverified.join('\n・') + '\n\nこのまま登録しますか？\n（「キャンセル」で戻り、薬剤マスタで確認できます）')) return;
    if (editingId) {
      Object.assign(db.stocks.find((s) => s.id === editingId), recs[0]);
    } else {
      const now = new Date().toISOString();
      recs.forEach((r) => db.stocks.push(Object.assign({ id: uid(), state: '在庫', createdAt: now }, r)));
    }
    save();
    if (!editingId && recs.length > 1) alert(recs.length + ' 種類のお守り薬を登録しました。');
    resetStockForm();
    showTab('stock');
  });

  $('#stock-form-reset').addEventListener('click', resetStockForm);

  // ---------- 使用開始指示 ----------
  const useDialog = $('#use-dialog');
  const useForm = $('#use-form');

  function openUseDialog(stock, usage) {
    useForm.reset();
    useForm.stockId.value = stock ? stock.id : '';
    useForm.usageId.value = usage ? usage.id : '';
    const target = usage || {
      startDate: L.toISO(today()),
      quantity: stock.quantity,
      markUsed: true,
    };
    fillForm(useForm, target);
    const src = usage || stock;
    $('#use-target').innerHTML =
      '<b>' + esc(src.patientName) + '</b> 様　' + esc(src.drugName) +
      '（' + esc(src.category) + '）　お守り薬の処方日 ' + fmtISO(src.prescribedDate);
    $('#use-unit').textContent = src.unit || '';
    useForm.markUsed.closest('label').style.display = usage ? 'none' : '';
    useDialog.showModal();
  }

  useForm.addEventListener('submit', (e) => {
    const action = e.submitter ? e.submitter.value : 'save';
    if (action === 'cancel') return;
    e.preventDefault();
    const f = formData(useForm);
    f.markUsed = useForm.markUsed.checked;
    let usage;
    if (f.usageId) {
      usage = db.usages.find((u) => u.id === f.usageId);
      Object.assign(usage, {
        startDate: f.startDate, doctorName: f.doctorName, quantity: f.quantity,
        recorder: f.recorder, note: f.note,
      });
    } else {
      const s = db.stocks.find((x) => x.id === f.stockId);
      usage = {
        id: uid(),
        no: db.nextUsageNo++,
        stockId: s.id,
        patientName: s.patientName,
        patientId: s.patientId,
        drugName: s.drugName,
        category: s.category,
        unit: s.unit,
        prescribedDate: s.prescribedDate,
        prescriber: s.prescriber,
        startDate: f.startDate,
        doctorName: f.doctorName,
        quantity: f.quantity,
        recorder: f.recorder,
        note: f.note,
        memoIssued: false,
        memoIssuedAt: '',
        createdAt: new Date().toISOString(),
      };
      db.usages.push(usage);
      if (f.markUsed) s.state = '使用済';
    }
    save();
    useDialog.close();
    render();
    if (action === 'save') openMemo([usage]);
  });

  // ---------- 使用記録（データシート） ----------
  function renderUsage() {
    const q = $('#usage-search').value.trim();
    const memo = $('#usage-filter-memo').value;
    const rows = db.usages
      .filter((u) => {
        if (memo === 'yes' && !u.memoIssued) return false;
        if (memo === 'no' && u.memoIssued) return false;
        if (q && !(u.patientName + ' ' + u.doctorName + ' ' + u.drugName).includes(q)) return false;
        return true;
      })
      .sort((a, b) => b.no - a.no);

    $('#usage-table tbody').innerHTML = rows.map((u) =>
      '<tr class="' + (u.memoIssued ? '' : 'row-pending') + '">' +
      '<td class="num">' + u.no + '</td>' +
      '<td>' + esc(u.patientName) + '</td>' +
      '<td>' + fmtISO(u.startDate) + '</td>' +
      '<td>' + esc(u.doctorName) + '</td>' +
      '<td>' + esc(u.drugName) + '</td>' +
      '<td>' + (u.memoIssued
        ? '<span class="chip green">発行済</span><br><small>' + esc(fmtISO(u.memoIssuedAt.slice(0, 10))) + '</small>'
        : '<span class="chip red">未発行</span>') + '</td>' +
      '<td><div class="ops">' +
      '<button data-act="memo" data-id="' + u.id + '" class="primary small">' + (u.memoIssued ? '再印刷' : '処方メモ発行') + '</button>' +
      '<button data-act="edit" data-id="' + u.id + '" class="small">編集</button>' +
      (u.memoIssued ? '<button data-act="unissue" data-id="' + u.id + '" class="small">未発行に戻す</button>' : '') +
      '<button data-act="delete" data-id="' + u.id + '" class="small danger">削除</button>' +
      '</div></td></tr>'
    ).join('') || '<tr><td colspan="7" class="empty">使用記録はありません</td></tr>';
  }

  ['#usage-search', '#usage-filter-memo'].forEach((sel) => $(sel).addEventListener('input', renderUsage));

  $('#usage-table').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const u = db.usages.find((x) => x.id === b.dataset.id);
    if (!u) return;
    switch (b.dataset.act) {
      case 'memo': openMemo([u]); break;
      case 'edit': openUseDialog(null, u); break;
      case 'unissue': u.memoIssued = false; u.memoIssuedAt = ''; save(); render(); break;
      case 'delete':
        if (confirm('No.' + u.no + ' の使用記録を削除しますか？')) {
          db.usages = db.usages.filter((x) => x !== u); save(); render();
        }
        break;
    }
  });

  // データシート形式で Excel 出力 (患者名 / 使用開始日 / 開始指示医師 / 処方メモ発行 を先頭に配置)
  $('#usage-export').addEventListener('click', () => {
    const rows = db.usages.slice().sort((a, b) => a.no - b.no).map((u) => ({
      'No.': u.no,
      '患者名': u.patientName,
      '使用開始日': fmtISO(u.startDate),
      '開始指示医師': u.doctorName,
      '処方メモ発行': u.memoIssued ? '済' : '未',
      'メモ発行日': u.memoIssuedAt ? fmtISO(u.memoIssuedAt.slice(0, 10)) : '',
      '患者ID': u.patientId || '',
      '区分': u.category,
      '薬剤名': u.drugName,
      '数量': u.quantity ? u.quantity + (u.unit || '') : '',
      'お守り薬の処方日': fmtISO(u.prescribedDate),
      'お守り薬の処方医': u.prescriber || '',
      '記入者': u.recorder || '',
      '備考': u.note || '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ 'No.': '', '患者名': '', '使用開始日': '', '開始指示医師': '', '処方メモ発行': '' }]);
    ws['!cols'] = [6, 14, 12, 12, 10, 12, 10, 10, 24, 8, 6, 24, 12, 12, 10, 20].map((w) => ({ wch: w }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'データシート');
    XLSX.writeFile(wb, '在庫薬使用データシート_' + L.toISO(today()) + '.xlsx');
  });

  // ---------- 処方メモ ----------
  let memoTargets = [];

  function memoHTML(u) {
    const cell = (v) => esc(v) || '&nbsp;';
    return '<div class="memo">' +
      '<div class="memo-head">' +
        '<div class="memo-no">No. ' + u.no + '　発行日 ' + (u.memoIssued ? fmtISO(u.memoIssuedAt.slice(0, 10)) : L.formatDate(today())) + '</div>' +
      '</div>' +
      '<h2 class="memo-title">' + esc(db.settings.memoTitle) + '</h2>' +
      '<table class="memo-table">' +
        '<colgroup><col style="width:20%"><col style="width:30%"><col style="width:20%"><col style="width:30%"></colgroup>' +
        '<tr><th>患者名</th><td colspan="3" class="memo-patient">' + cell(u.patientName) + '　様' +
          (u.patientId ? '<span class="memo-pid">（ID: ' + esc(u.patientId) + '）</span>' : '') + '</td></tr>' +
        '<tr><th>使用開始日</th><td>' + fmtISO(u.startDate) + '</td>' +
            '<th>開始指示医師</th><td>' + cell(u.doctorName) + '</td></tr>' +
        '<tr><th class="memo-inst-th">指示内容</th><td colspan="3" class="memo-inst">&nbsp;</td></tr>' +
        '<tr><th>指示記入日</th><td colspan="3" class="memo-date">　　　　　年　　　月　　　日</td></tr>' +
      '</table>' +
    '</div>';
  }

  function openMemo(usages) {
    memoTargets = usages;
    $('#memo-sheet').innerHTML = usages.map(memoHTML).join('');
    document.body.classList.add('memo-open');
  }

  function closeMemo() {
    document.body.classList.remove('memo-open');
    memoTargets = [];
    render();
  }

  $('#memo-print').addEventListener('click', () => {
    window.print();
    if (!confirm('印刷できましたか？\n「OK」で処方メモを発行済として記録します。')) return;
    const now = new Date();
    const stamp = L.toISO(now) + 'T' + now.toTimeString().slice(0, 8);
    memoTargets.forEach((u) => {
      if (!u.memoIssued) { u.memoIssued = true; u.memoIssuedAt = stamp; }
    });
    save();
    closeMemo();
  });
  $('#memo-close').addEventListener('click', closeMemo);

  // ---------- 薬剤マスタ ----------
  // 見出しの表記ゆれを吸収して列を特定する
  const HEADER_ALIASES = {
    code: ['コード', '薬剤コード', 'yjコード', 'ｺｰﾄﾞ', '薬価基準収載医薬品コード'],
    category: ['対象区分', '区分', '分類', '種別', '薬効分類'],
    name: ['薬剤名', '医薬品名', '品名', '商品名', '名称', '薬品名'],
    spec: ['規格', '規格単位', '含量'],
    unit: ['単位'],
    dosage: ['用法用量', '用法・用量', '標準用法', '標準用法用量'],
  };

  function normHeader(h) {
    return String(h || '').replace(/[\s　()（）]/g, '').toLowerCase();
  }

  function normCategory(v) {
    const s = String(v || '');
    if (/抗菌|抗生/.test(s)) return '抗菌薬';
    if (/麻薬/.test(s)) return '麻薬';
    if (/解熱|鎮痛|NSAIDs|アセトアミノフェン/i.test(s)) return '解熱鎮痛薬';
    return '';
  }

  function parseMasterRows(rows) {
    if (!rows.length) return { drugs: [], skipped: 0 };
    const headers = Object.keys(rows[0]);
    const col = {};
    headers.forEach((h) => {
      const n = normHeader(h);
      Object.keys(HEADER_ALIASES).forEach((k) => {
        if (!col[k] && HEADER_ALIASES[k].some((a) => normHeader(a) === n)) col[k] = h;
      });
      if (/有効期限|有効期間|使用期限/.test(n)) {
        if (/月/.test(n)) col.expiryM = col.expiryM || h;
        else col.expiryY = col.expiryY || h; // 「有効期限(年)」「有効期限」は年として扱う
      }
    });
    // 「対象区分」列がある場合は最優先。その場合「区分」列(内用薬/外用薬)は剤形として扱う
    const explicit = headers.find((h) => normHeader(h) === '対象区分');
    if (explicit) col.category = explicit;
    const formCol = explicit ? headers.find((h) => normHeader(h) === '区分') : null;
    if (!col.name) throw new Error('「薬剤名」の列が見つかりません。');
    if (!col.expiryY && !col.expiryM) throw new Error('「有効期限(年)」または「有効期限(月)」の列が見つかりません。');

    let skipped = 0;
    const drugs = [];
    rows.forEach((r) => {
      const name = String(r[col.name] || '').trim().normalize('NFKC'); // 全角英数(２００ｍｇ)を半角に揃え、入力しやすくする
      if (!name) return;
      const years = col.expiryY ? parseFloat(String(r[col.expiryY]).replace(/[^\d.]/g, '')) || 0 : 0;
      const months = col.expiryM ? parseFloat(String(r[col.expiryM]).replace(/[^\d.]/g, '')) || 0 : 0;
      const expiryMonths = Math.round(years * 12 + months);
      const category = normCategory(col.category ? r[col.category] : '');
      if (explicit && !category) return; // 対象外の医薬品は黙って除外
      if (!expiryMonths || !category) { skipped++; return; }
      drugs.push({
        id: uid(),
        code: col.code ? String(r[col.code] || '').trim() : '',
        category: category,
        name: name,
        form: formCol ? String(r[formCol] || '').trim() : '',
        spec: col.spec ? String(r[col.spec] || '').trim().normalize('NFKC') : '',
        unit: col.unit ? String(r[col.unit] || '').trim() : '',
        dosage: col.dosage ? String(r[col.dosage] || '').trim() : '',
        expiryMonths: expiryMonths,
      });
    });
    return { drugs: drugs, skipped: skipped };
  }

  $('#master-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const name = ['薬剤マスタ', '医薬品マスタ'].find((n) => wb.SheetNames.includes(n)) ||
        wb.SheetNames.find((n) => /マスタ|master/i.test(n)) || wb.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '', raw: false });
      const result = parseMasterRows(rows);
      if (!result.drugs.length) throw new Error('取り込める薬剤がありませんでした。');
      if ($('#master-replace').checked) {
        const olds = new Map(db.drugs.map((x) => [x.name, x]));
        db.drugs = result.drugs.map((d) => carryVerified(d, olds.get(d.name)));
      } else {
        result.drugs.forEach((d) => {
          const i = db.drugs.findIndex((x) => x.name === d.name);
          if (i >= 0) db.drugs[i] = Object.assign(carryVerified(d, db.drugs[i]), { id: db.drugs[i].id });
          else db.drugs.push(d);
        });
      }
      save();
      render();
      alert('シート「' + name + '」から ' + result.drugs.length + ' 件を読み込みました。' +
        (result.skipped ? '\n区分または有効期限が読み取れない ' + result.skipped + ' 行はスキップしました。' : ''));
    } catch (err) {
      alert('薬剤マスタを読み込めませんでした。\n' + err.message);
    }
  });

  $('#master-template').addEventListener('click', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['コード', '区分', '薬剤名', '規格', '単位', '有効期限(年)', '有効期限(月)', '用法用量'],
      ['', '抗菌薬', '（例）〇〇錠250mg', '250mg', '錠', 3, '', '1回1錠 1日3回 毎食後'],
      ['', '解熱鎮痛薬', '（例）△△錠200mg', '200mg', '錠', 2, '', '1回1錠 発熱時'],
    ]);
    ws['!cols'] = [10, 12, 28, 10, 6, 12, 12, 26].map((w) => ({ wch: w }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '薬剤マスタ');
    XLSX.writeFile(wb, '薬剤マスタ_ひな形.xlsx');
  });

  $('#master-add').addEventListener('click', () => {
    db.drugs.push({ id: uid(), code: '', category: '抗菌薬', name: '', spec: '', unit: '', dosage: '', expiryMonths: 24, editing: true });
    renderMaster();
  });

  function verifiedLabel(d) {
    return d.verified
      ? '<span class="chip green">確認済</span><br><small>' + esc(fmtISO(d.verifiedAt)) + '</small>'
      : '<span class="chip yellow">未確認</span>';
  }

  // 薬剤マスタの再読み込みで確認済みの印が消えないよう、同名・同じ有効期限なら引き継ぐ
  function carryVerified(d, old) {
    if (old && old.verified && old.expiryMonths === d.expiryMonths) {
      d.verified = true;
      d.verifiedAt = old.verifiedAt;
    }
    return d;
  }

  const MASTER_LIMIT = 300;

  function renderMaster() {
    const q = $('#master-search').value.trim().normalize('NFKC');
    const onlyUnverified = $('#master-unverified').checked;
    const matched = db.drugs.filter((d) =>
      d.editing ||
      ((!q || (d.name + ' ' + d.code).includes(q)) && (!onlyUnverified || !d.verified)));
    const shown = matched.slice(0, MASTER_LIMIT);
    $('#master-summary').textContent = '薬剤マスタ ' + db.drugs.length + ' 件（未確認 ' + db.drugs.filter((d) => !d.verified).length + ' 件）' +
      (matched.length > MASTER_LIMIT ? '　該当 ' + matched.length + ' 件のうち先頭 ' + MASTER_LIMIT + ' 件を表示' : '');
    $('#master-table tbody').innerHTML = shown.map((d) => {
      if (d.editing) {
        return '<tr data-id="' + d.id + '" class="editing">' +
          '<td><input data-f="code" value="' + esc(d.code) + '" class="short"></td>' +
          '<td><select data-f="category">' + CATEGORIES.map((c) => '<option' + (c === d.category ? ' selected' : '') + '>' + c + '</option>').join('') + '</select></td>' +
          '<td><input data-f="name" value="' + esc(d.name) + '"></td>' +
          '<td><input data-f="spec" value="' + esc(d.spec) + '" class="short"></td>' +
          '<td><input data-f="unit" value="' + esc(d.unit) + '" class="short"></td>' +
          '<td><input data-f="expiryMonths" type="number" min="1" value="' + d.expiryMonths + '" class="short"> ヶ月</td>' +
          '<td>' + verifiedLabel(d) + '</td>' +
          '<td><div class="ops"><button data-act="ok" class="primary small">確定</button><button data-act="del" class="small danger">削除</button></div></td>' +
          '</tr>';
      }
      return '<tr data-id="' + d.id + '">' +
        '<td>' + esc(d.code) + '</td><td>' + esc(d.category) + '</td><td>' + esc(d.name) + '</td>' +
        '<td>' + esc(d.spec) + '</td><td>' + esc(d.unit) + '</td><td>' + L.monthsText(d.expiryMonths) + '</td>' +
        '<td>' + verifiedLabel(d) + '</td>' +
        '<td><div class="ops">' +
          (d.verified
            ? '<button data-act="unverify" class="small">未確認に戻す</button>'
            : '<button data-act="verify" class="primary small">確認済みにする</button>') +
          '<button data-act="edit" class="small">編集</button><button data-act="del" class="small danger">削除</button></div></td>' +
        '</tr>';
    }).join('') || '<tr><td colspan="8" class="empty">' + (db.drugs.length ? '該当する薬剤はありません' : '薬剤マスタが未登録です。Excelファイルを読み込んでください。') + '</td></tr>';
  }

  ['#master-search', '#master-unverified'].forEach((sel) => $(sel).addEventListener('input', renderMaster));

  $('#master-table').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const tr = b.closest('tr');
    const d = db.drugs.find((x) => x.id === tr.dataset.id);
    if (b.dataset.act === 'edit') {
      d.editing = true;
    } else if (b.dataset.act === 'verify') {
      d.verified = true;
      d.verifiedAt = L.toISO(today());
    } else if (b.dataset.act === 'unverify') {
      d.verified = false;
      d.verifiedAt = '';
    } else if (b.dataset.act === 'del') {
      if (!d.name || confirm('「' + d.name + '」をマスタから削除しますか？')) db.drugs = db.drugs.filter((x) => x !== d);
    } else if (b.dataset.act === 'ok') {
      $$('[data-f]', tr).forEach((el) => {
        d[el.dataset.f] = el.dataset.f === 'expiryMonths' ? Number(el.value) : el.value.trim();
      });
      if (!d.name || !(d.expiryMonths > 0)) { alert('薬剤名と有効期限を入力してください。'); return; }
      delete d.editing;
    }
    save();
    render();
  });

  // ---------- 患者マスタ ----------
  const PATIENT_ALIASES = {
    id: ['患者id', '患者番号', 'id', 'カルテ番号', '患者コード', '診察券番号'],
    name: ['患者名', '氏名', '名前', '患者氏名'],
    kana: ['カナ', 'フリガナ', 'ふりがな', '患者カナ', '氏名カナ', 'カナ氏名', '患者名カナ', '患者名(カナ)'],
  };

  function parsePatientRows(rows) {
    if (!rows.length) return [];
    const col = {};
    Object.keys(rows[0]).forEach((h) => {
      const n = normHeader(h);
      Object.keys(PATIENT_ALIASES).forEach((k) => {
        if (!col[k] && PATIENT_ALIASES[k].some((a) => normHeader(a) === n)) col[k] = h;
      });
    });
    if (!col.name) throw new Error('「患者名」（または氏名）の列が見つかりません。');
    const seen = new Set();
    const list = [];
    rows.forEach((r) => {
      const name = String(r[col.name] || '').trim();
      const id = col.id ? String(r[col.id] || '').trim() : '';
      if (!name) return;
      const key = id + '|' + name;
      if (seen.has(key)) return;
      seen.add(key);
      list.push({ id: id, name: name, kana: col.kana ? String(r[col.kana] || '').trim() : '' });
    });
    return list;
  }

  $('#patient-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const name = wb.SheetNames.find((n) => /患者/.test(n)) || wb.SheetNames[0];
      const list = parsePatientRows(XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '', raw: false }));
      if (!list.length) throw new Error('取り込める患者がありませんでした。');
      if ($('#patient-replace').checked) {
        db.patients = list;
      } else {
        list.forEach((p) => {
          const i = p.id ? db.patients.findIndex((x) => x.id === p.id) : -1;
          if (i >= 0) db.patients[i] = p; else db.patients.push(p);
        });
      }
      save();
      render();
      alert('シート「' + name + '」から ' + list.length + ' 名を読み込みました。');
    } catch (err) {
      alert('患者マスタを読み込めませんでした。\n' + err.message);
    }
  });

  $('#patient-template').addEventListener('click', () => {
    const ws = XLSX.utils.aoa_to_sheet([['患者ID', '患者名', 'カナ'], ['0001', '山田 太郎', 'ヤマダ タロウ']]);
    ws['!cols'] = [{ wch: 12 }, { wch: 20 }, { wch: 24 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '患者マスタ');
    XLSX.writeFile(wb, '患者マスタ_ひな形.xlsx');
  });

  $('#patient-clear').addEventListener('click', () => {
    if (db.patients.length && confirm('患者マスタ ' + db.patients.length + ' 名を削除します。お守り薬のデータには影響しません。よろしいですか？')) {
      db.patients = []; save(); render();
    }
  });

  $('#patient-search').addEventListener('input', renderPatients);

  function renderPatients() {
    const q = $('#patient-search').value.trim();
    const hits = db.patients.filter((p) => !q || (p.id + ' ' + p.name + ' ' + p.kana).includes(q));
    const LIMIT = 200;
    $('#patient-summary').textContent = '患者マスタ ' + db.patients.length + ' 名' + (hits.length > LIMIT ? '（' + hits.length + ' 名該当、先頭' + LIMIT + '名を表示）' : '');
    $('#patient-table tbody').innerHTML = hits.slice(0, LIMIT).map((p) =>
      '<tr><td>' + esc(p.id) + '</td><td>' + esc(p.name) + '</td><td>' + esc(p.kana) + '</td></tr>'
    ).join('') || '<tr><td colspan="3" class="empty">患者マスタが未登録です。Excelファイルを読み込んでください。</td></tr>';
  }

  // ---------- 設定・バックアップ ----------
  const settingsForm = $('#settings-form');

  function renderDoctors() {
    $('#doctor-list').innerHTML = db.settings.doctors.map((n, i) =>
      '<li><span>' + esc(n) + '</span><button type="button" class="small danger" data-i="' + i + '">削除</button></li>'
    ).join('') || '<li class="empty">登録されていません</li>';
  }

  function addDoctor() {
    const input = $('#doctor-input');
    const name = input.value.trim();
    if (!name) return;
    if (!db.settings.doctors.includes(name)) {
      db.settings.doctors.push(name);
      save();
    }
    input.value = '';
    render();
    input.focus();
  }

  $('#doctor-add').addEventListener('click', addDoctor);
  $('#doctor-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addDoctor(); }
  });
  $('#doctor-list').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    const name = db.settings.doctors[Number(b.dataset.i)];
    if (confirm('処方医「' + name + '」を削除しますか？（登録済みのお守り薬の処方医は変わりません）')) {
      db.settings.doctors.splice(Number(b.dataset.i), 1);
      save();
      render();
    }
  });

  function renderSettings() {
    fillForm(settingsForm, db.settings);
    renderDoctors();
  }

  settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = formData(settingsForm);
    db.settings = {
      memoTitle: f.memoTitle || DEFAULT_SETTINGS.memoTitle,
      doctors: db.settings.doctors,
    };
    save();
    render();
    alert('設定を保存しました。');
  });

  $('#backup-export').addEventListener('click', () => {
    downloadBlob(new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' }),
      '在庫管理バックアップ_' + L.toISO(today()) + '.json');
  });

  $('#backup-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.stocks) || !Array.isArray(data.usages)) throw new Error('バックアップファイルの形式が違います。');
      if (!confirm('現在のデータをバックアップの内容で置き換えます。よろしいですか？')) return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      db = load();
      render();
      alert('復元しました。');
    } catch (err) {
      alert('復元できませんでした。\n' + err.message);
    }
  });

  // ---------- 描画 ----------
  function render() {
    $('#today-label').textContent = L.formatDate(today());
    renderDatalists();
    renderStock();
    renderUsage();
    renderMaster();
    $$('.drug-row', rowsBox).forEach(updateRowWarn);
    renderPatients();
    renderSettings();
  }

  // 日付が変わったら色を更新する
  let lastDay = L.toISO(today());
  setInterval(() => {
    if (L.toISO(today()) !== lastDay) { lastDay = L.toISO(today()); render(); }
  }, 60000);

  resetStockForm();
  render();
})();
