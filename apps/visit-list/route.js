/* 訪問ルート（地図表示・訪問順の計算）
 * 外部へ送るのは「住所の文字列」（国土地理院の住所検索）と地図タイルの取得のみ。
 * 訪問順の計算はブラウザ内で行う（直線距離）。
 */
(function () {
  'use strict';

  const GEO_KEY = 'visitPatientList.geo.v1';
  const GSI_SEARCH_URL = 'https://msearch.gsi.go.jp/address-search/AddressSearch?q=';
  const TILE_URL = 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png';
  const TILE_ATTRIBUTION = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>';
  const GEOCODE_INTERVAL_MS = 300;
  const EXACT_SOLVE_MAX = 8; // 訪問先がこの数以下なら全通りを調べて最短を求める
  const GMAPS_MAX_WAYPOINTS = 9; // GoogleマップのURLで指定できる経由地の上限
  const DEFAULT_CENTER = [35.681, 139.767];

  // cache: 住所 → { lat, lng, title, manual }（title は住所検索で見つかった地名）
  // startTime: 出発時刻、serviceMin: 1件の滞在時間（分）、speedKmh: 移動の速さ（直線距離に対して）
  const geo = { cache: {}, officeAddress: '', roundTrip: true, route: null, startTime: '09:30', serviceMin: 15, speedKmh: 20 };
  let map = null;
  let markerLayer = null;
  let pickAddr = null; // 地図クリックで位置を指定する住所
  let busy = false;

  const $ = (sel) => document.querySelector(sel);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function addrKey(addr) {
    return String(addr || '').normalize('NFKC').replace(/\s+/g, '').trim();
  }

  // 位置検索に使う住所（建物名などの「住所（続き）」は含めない）
  function patientAddr(p) {
    return (p.addr1 || p.address || '').trim();
  }

  // ---------- 保存 ----------
  function saveGeo() {
    try {
      localStorage.setItem(GEO_KEY, JSON.stringify(geo));
    } catch (e) {
      console.warn(e);
    }
  }

  function loadGeo() {
    try {
      Object.assign(geo, JSON.parse(localStorage.getItem(GEO_KEY) || '{}'));
    } catch (e) {
      console.warn(e);
    }
  }

  function pointOf(addr) {
    return addr ? geo.cache[addrKey(addr)] || null : null;
  }

  // ---------- 住所 → 位置（国土地理院 住所検索） ----------
  async function searchGsi(query) {
    const res = await fetch(GSI_SEARCH_URL + encodeURIComponent(query));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) return null;
    const [lng, lat] = list[0].geometry.coordinates;
    return { lat, lng, title: list[0].properties.title || '' };
  }

  // 見つからない場合は番地までに切り詰めて再検索する
  async function geocode(addr) {
    const full = addr.normalize('NFKC').replace(/\s+/g, '');
    const hit = await searchGsi(full);
    if (hit) return hit;
    const m = full.match(/^\D*\d+(?:(?:丁目|番地|番|号|の|-|‐|－|ー|−)\d+)*/);
    if (m && m[0] !== full) return searchGsi(m[0]);
    return null;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function geocodeMissing() {
    if (busy) return;
    const targets = new Set();
    if (geo.officeAddress && !pointOf(geo.officeAddress)) targets.add(geo.officeAddress);
    // 訪問先ごとに1件（同じグループホームは代表の住所のみ）
    buildStops().forEach((s) => {
      if (s.addr && !s.point) targets.add(s.addr);
    });
    if (!targets.size) {
      setStatus('位置を取得していない住所はありません。');
      return;
    }
    busy = true;
    renderButtons();
    const failed = [];
    let i = 0;
    for (const addr of targets) {
      i += 1;
      setStatus(`住所から位置を取得しています… ${i} / ${targets.size}`);
      try {
        const hit = await geocode(addr);
        if (hit) geo.cache[addrKey(addr)] = Object.assign(hit, { manual: false });
        else failed.push(addr);
      } catch (e) {
        busy = false;
        saveGeo();
        render();
        setStatus('国土地理院の住所検索に接続できませんでした。インターネット接続を確認してください。地図をクリックして手動で位置を指定することもできます。', true);
        return;
      }
      if (i < targets.size) await sleep(GEOCODE_INTERVAL_MS);
    }
    busy = false;
    saveGeo();
    render();
    fitAll();
    setStatus(failed.length
      ? `${targets.size - failed.length}件の位置を取得しました。${failed.length}件は見つかりませんでした（右の一覧の「地図で指定」から指定してください）。`
      : `${targets.size}件の位置を取得しました。位置がずれている場合はピンをドラッグして直せます。`, failed.length > 0);
  }

  // ---------- 訪問先（同じグループホーム・同じ住所は1か所にまとめる） ----------
  function buildStops() {
    const stops = new Map();
    window.VisitApp.todayPatients().forEach((p) => {
      const addr = patientAddr(p);
      const id = p.gh ? `gh:${p.gh}` : `addr:${addrKey(addr) || p.key}`;
      if (!stops.has(id)) stops.set(id, { id, gh: p.gh, addr, patients: [] });
      stops.get(id).patients.push(p);
    });
    return [...stops.values()].map((s) => Object.assign(s, { point: pointOf(s.addr) }));
  }

  function memoOf(p) {
    return window.VisitApp.memoOf(p.key);
  }

  function rulesOf(p) {
    return window.VisitApp.rulesOf(p.key);
  }

  function stopHasMemo(s) {
    return s.patients.some((p) => memoOf(p) || rulesOf(p).length);
  }

  // 訪問先で訪問できる時間帯（全員の条件を満たす時間）。条件なしなら null
  function stopIntervals(s) {
    return window.VisitSchedule.intervalsOfStop(s.patients.map(rulesOf));
  }

  function hasTimeRules(stops) {
    return stops.some((s) => stopIntervals(s) != null);
  }

  function scheduleSettings() {
    const start = window.VisitSchedule.parseHM(geo.startTime);
    return {
      start: start == null ? 9 * 60 + 30 : start,
      svc: Math.max(0, Number(geo.serviceMin) || 0),
      speed: Math.max(1, Number(geo.speedKmh) || 20),
    };
  }

  // points[0] が事業所（hasDepot のとき）。各地点の時間帯と移動時間（分）
  function scheduleContext(points, stopsOfPoints, hasDepot) {
    const { start, svc, speed } = scheduleSettings();
    const D = points.map((a) => points.map((b) => distKm(a, b) / speed * 60));
    const intervals = points.map((_, i) => (hasDepot && i === 0 ? null : stopIntervals(stopsOfPoints[i - (hasDepot ? 1 : 0)])));
    return { travel: (i, j) => D[i][j], start, svc, intervals, hasDepot, roundTrip: geo.roundTrip };
  }

  // 並び順どおりに回ったときの予定時刻。{ byId: Map(訪問先id → {begin, wait, late}), end, lateCount }
  function scheduleOf(ordered) {
    const office = pointOf(geo.officeAddress);
    const points = (office ? [office] : []).concat(ordered.map((x) => x.point));
    const ctx = scheduleContext(points, ordered, !!office);
    const order = points.map((_, i) => i);
    const sim = window.VisitSchedule.simulate(order, ctx);
    const byId = new Map();
    sim.visits.forEach((v) => byId.set(ordered[v.idx - (office ? 1 : 0)].id, v));
    return { byId, end: sim.end, lateCount: sim.visits.filter((v) => v.late > 0).length, withOffice: !!office };
  }

  // 「10:05頃（待ち20分）」
  function visitTimeText(v) {
    if (!v) return '';
    const wait = Math.round(v.wait);
    return window.VisitSchedule.fmtAbout(v.begin) + (wait >= 5 ? `（待ち${wait}分）` : '');
  }

  function endText(sch) {
    const S = window.VisitSchedule;
    if (sch.withOffice && geo.roundTrip) return `帰着予定 ${S.fmtAbout(sch.end)}`;
    return `最後の訪問の終了予定 ${S.fmtAbout(sch.end)}`;
  }

  // 番号を付ける順番（位置のわかる訪問先のみ）。
  // 計算した順番を当日リストに反映済み（訪問ルート順）なら、↑↓で手直しした当日リストの順に従う。
  // 計算前・当日リストが変わった後は null
  function orderedStops(stops, route) {
    if (!route || route.stale) return null;
    if (window.VisitApp.isRouteOrder()) return stops.filter((s) => s.point);
    return route.stops;
  }

  // 並び順に沿った直線距離の合計（km）
  function pathKm(ordered) {
    const pts = ordered.map((s) => s.point);
    const office = pointOf(geo.officeAddress);
    if (office && pts.length) {
      pts.unshift(office);
      if (geo.roundTrip) pts.push(office);
    }
    let km = 0;
    for (let i = 0; i < pts.length - 1; i++) km += distKm(pts[i], pts[i + 1]);
    return km;
  }

  // 患者ごとの表示用：時間の条件の文字、メモ
  function patientNotes(p) {
    return [window.VisitSchedule.rulesText(rulesOf(p)), memoOf(p)].filter(Boolean);
  }

  function stopLabel(s) {
    if (s.gh) return `${s.gh}（${s.patients.length}名）`;
    return s.patients.map((p) => p.name || p.id).join('、');
  }

  // ---------- 訪問順の計算（直線距離） ----------
  function distKm(a, b) {
    const R = 6371;
    const r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r;
    const dLng = (b.lng - a.lng) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // points[0] が出発地（hasDepot のとき）。返り値は points の添字の並び
  function solveRoute(points, hasDepot, roundTrip) {
    const n = points.length;
    const D = points.map((a) => points.map((b) => distKm(a, b)));
    const closed = hasDepot && roundTrip;
    const cost = (t) => {
      let c = 0;
      for (let i = 0; i < t.length - 1; i++) c += D[t[i]][t[i + 1]];
      return closed ? c + D[t[t.length - 1]][t[0]] : c;
    };
    const fixed = hasDepot ? 1 : 0;
    const free = [];
    for (let i = fixed; i < n; i++) free.push(i);
    const head = hasDepot ? [0] : [];

    if (free.length <= EXACT_SOLVE_MAX) {
      let best = null;
      let bestCost = Infinity;
      permute(free, (perm) => {
        const t = head.concat(perm);
        const c = cost(t);
        if (c < bestCost - 1e-9) { bestCost = c; best = t; }
      });
      return { order: best, km: bestCost };
    }

    // 訪問先が多い場合：最近傍法と無作為な初期解を 2-opt / 1点移動 で改善し、最良のものを採用
    const starts = [];
    const nearest = (from, rest) => {
      const t = [from];
      const left = new Set(rest);
      while (left.size) {
        const cur = t[t.length - 1];
        let nx = null;
        left.forEach((j) => { if (nx == null || D[cur][j] < D[cur][nx]) nx = j; });
        t.push(nx);
        left.delete(nx);
      }
      return t;
    };
    if (hasDepot) starts.push(nearest(0, free));
    else free.forEach((s) => starts.push(nearest(s, free.filter((x) => x !== s))));
    for (let k = 0; k < 30; k++) {
      const shuffled = free.slice().sort(() => Math.random() - 0.5);
      starts.push(head.concat(shuffled));
    }
    let best = null;
    let bestCost = Infinity;
    for (const st of starts) {
      const t = improve(st, cost, fixed);
      const c = cost(t);
      if (c < bestCost - 1e-9) { bestCost = c; best = t; }
    }
    return { order: best, km: bestCost };
  }

  function improve(tour, cost, fixed) {
    let t = tour.slice();
    let c = cost(t);
    let improved = true;
    while (improved) {
      improved = false;
      // 2-opt：区間を反転
      for (let i = fixed; i < t.length - 1; i++) {
        for (let k = i + 1; k < t.length; k++) {
          const cand = t.slice(0, i).concat(t.slice(i, k + 1).reverse(), t.slice(k + 1));
          const cc = cost(cand);
          if (cc < c - 1e-9) { t = cand; c = cc; improved = true; }
        }
      }
      // 1点を別の位置へ移動
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

  function computeRoute() {
    const stops = buildStops();
    const located = stops.filter((s) => s.point);
    if (located.length < 1) {
      setStatus('位置がわかる訪問先がありません。先に「住所から位置を取得」を押してください。', true);
      return;
    }
    const office = pointOf(geo.officeAddress);
    if (geo.officeAddress && !office) {
      setStatus('事業所の位置がまだ取得できていません。「住所から位置を取得」を押すか、「地図で指定」で事業所の位置を指定してください。', true);
      return;
    }
    const points = (office ? [office] : []).concat(located.map((s) => s.point));
    let { order, km } = solveRoute(points, !!office, geo.roundTrip);
    const timed = hasTimeRules(located);
    if (timed) {
      // 時間の条件がある場合：条件を守り、帰着（終了）が最も早くなる順番にする
      const ctx = scheduleContext(points, located, !!office);
      order = window.VisitSchedule.solveTimed(points.length, ctx, order).order;
    }
    const stopOrder = order.filter((i) => !office || i !== 0).map((i) => located[i - (office ? 1 : 0)].id);
    geo.route = { stopIds: stopOrder, km, withOffice: !!office, roundTrip: geo.roundTrip, signature: signature(stops) };
    saveGeo();
    render();
    const missing = stops.length - located.length;
    const ordered = stopOrder.map((id) => located.find((x) => x.id === id));
    const sch = scheduleOf(ordered);
    const lateMsg = sch.lateCount ? `時間の条件に間に合わない見込みの訪問先が${sch.lateCount}か所あります（一覧の赤字）。出発時刻を早める・条件を見直すなどしてください。` : '';
    setStatus(`訪問順を計算しました（${timed ? '時間の条件を考慮。' : ''}直線距離 合計 約${pathKm(ordered).toFixed(1)}km、${endText(sch)}）。${lateMsg}${missing ? `位置が未設定の${missing}か所は含まれていません。` : ''}「この順番を当日リストに反映」で当日リスト・印刷の並びになります。`, missing > 0 || sch.lateCount > 0);
  }

  // 当日リストの訪問先が変わったかを判定するための値
  function signature(stops) {
    return stops.map((s) => s.id + ':' + (s.point ? `${s.point.lat},${s.point.lng}` : '')).sort().join('|')
      + `#${geo.officeAddress}#${geo.roundTrip}`
      // 時間の条件・出発時刻などが変わったら計算し直す
      + `#${stops.map((s) => s.id + JSON.stringify(stopIntervals(s))).sort().join('|')}#${geo.startTime}#${geo.serviceMin}#${geo.speedKmh}`;
  }

  function currentRoute(stops) {
    if (!geo.route) return null;
    if (geo.route.signature !== signature(stops)) return { stale: true };
    const byId = new Map(stops.map((s) => [s.id, s]));
    const ordered = geo.route.stopIds.map((id) => byId.get(id)).filter(Boolean);
    return { stale: false, stops: ordered, km: geo.route.km };
  }

  function applyRoute() {
    const stops = buildStops();
    const r = currentRoute(stops);
    if (!r || r.stale) return;
    const keys = r.stops.flatMap((s) => s.patients.map((p) => p.key));
    window.VisitApp.applyRouteOrder(keys);
    setStatus('訪問順を当日リストに反映しました。印刷もこの順番になります（グループホームの患者の直前にホーム名の行が入ります）。');
  }

  // ---------- Googleマップで経路を開く（住所のみを渡す） ----------
  function gmapsParam(addr) {
    const pt = pointOf(addr);
    if (pt && pt.manual) return `${pt.lat.toFixed(6)},${pt.lng.toFixed(6)}`;
    return addr;
  }

  function gmapsLinks(orderedStops) {
    const pts = orderedStops.map((s) => gmapsParam(s.addr));
    if (geo.officeAddress && pointOf(geo.officeAddress)) {
      pts.unshift(gmapsParam(geo.officeAddress));
      if (geo.roundTrip) pts.push(gmapsParam(geo.officeAddress));
    }
    if (pts.length < 2) return [];
    const links = [];
    const per = GMAPS_MAX_WAYPOINTS + 1; // 1区間で進める地点数
    for (let s = 0; s < pts.length - 1; s += per) {
      const seg = pts.slice(s, s + per + 1);
      const q = new URLSearchParams({ api: '1', origin: seg[0], destination: seg[seg.length - 1], travelmode: 'driving' });
      if (seg.length > 2) q.set('waypoints', seg.slice(1, -1).join('|'));
      links.push('https://www.google.com/maps/dir/?' + q.toString());
    }
    return links;
  }

  // ---------- 地図 ----------
  function ensureMap() {
    if (map || typeof L === 'undefined') return;
    map = L.map('route-map', { zoomControl: true }).setView(DEFAULT_CENTER, 11);
    L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 18 }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    map.on('click', (e) => {
      if (!pickAddr) return;
      geo.cache[addrKey(pickAddr)] = { lat: e.latlng.lat, lng: e.latlng.lng, title: '地図で指定', manual: true };
      pickAddr = null;
      $('#route-map').classList.remove('picking');
      saveGeo();
      render();
      setStatus('位置を指定しました。');
    });
  }

  function pinIcon(text, cls) {
    return L.divIcon({ className: `route-pin ${cls || ''}`, html: `<span>${esc(text)}</span>`, iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -14] });
  }

  function addMarker(addr, latlng, icon, popupHtml) {
    const m = L.marker(latlng, { icon, draggable: true }).addTo(markerLayer);
    m.bindPopup(popupHtml);
    m.on('dragend', () => {
      const ll = m.getLatLng();
      geo.cache[addrKey(addr)] = { lat: ll.lat, lng: ll.lng, title: 'ピンで調整', manual: true };
      saveGeo();
      render();
      setStatus('位置を修正しました。訪問順を再計算してください。');
    });
  }

  function pinClass(s, v) {
    return [s.gh ? 'gh' : '', stopHasMemo(s) ? 'has-memo' : '', v && v.late > 0 ? 'late' : ''].filter(Boolean).join(' ');
  }

  function routeLine(ordered) {
    const office = pointOf(geo.officeAddress);
    const line = ordered.map((s) => [s.point.lat, s.point.lng]);
    if (office && line.length) {
      line.unshift([office.lat, office.lng]);
      if (geo.roundTrip) line.push([office.lat, office.lng]);
    }
    return line;
  }

  function renderMap(stops, ordered, sch) {
    ensureMap();
    if (!map) return;
    markerLayer.clearLayers();
    const office = pointOf(geo.officeAddress);
    if (office) addMarker(geo.officeAddress, [office.lat, office.lng], pinIcon('事', 'office'), `<b>事業所（出発地）</b><br>${esc(geo.officeAddress)}`);
    const numberOf = new Map();
    if (ordered) ordered.forEach((s, i) => numberOf.set(s.id, i + 1));
    stops.forEach((s) => {
      if (!s.point) return;
      const no = numberOf.get(s.id);
      const names = s.patients.map((p) => esc(p.name || p.id) + patientNotes(p).map((t) => ` <span class="popup-memo">［${esc(t)}］</span>`).join('')).join('<br>');
      const v = sch && sch.byId.get(s.id);
      const popup = `<b>${no ? `${no}. ` : ''}${esc(s.gh || '居宅')}</b>${v ? ` <span class="popup-memo">${esc(visitTimeText(v))}</span>` : ''}<br>${names}<br><span class="popup-addr">${esc(s.addr)}</span>`
        + `<br><span class="popup-hit">検索結果: ${esc(s.point.title)}</span>`;
      addMarker(s.addr, [s.point.lat, s.point.lng], pinIcon(no || '・', pinClass(s, v)), popup);
    });
    if (ordered && ordered.length) {
      L.polyline(routeLine(ordered), { color: '#1f6feb', weight: 3, opacity: 0.7, dashArray: '6 6' }).addTo(markerLayer);
    }
  }

  function fitAll() {
    if (!map) return;
    const pts = [];
    markerLayer.eachLayer((l) => { if (l.getLatLng) pts.push(l.getLatLng()); });
    if (pts.length === 1) map.setView(pts[0], 15);
    else if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.15));
  }

  // ---------- 一覧・ボタン ----------
  function setStatus(text, warn) {
    const el = $('#route-status');
    el.textContent = text;
    el.classList.toggle('is-warn', !!warn);
  }

  function renderButtons(stops, route) {
    stops = stops || buildStops();
    route = route === undefined ? currentRoute(stops) : route;
    const hasToday = stops.length > 0;
    $('#btn-geocode').disabled = busy || !hasToday;
    $('#btn-optimize').disabled = busy || !stops.some((s) => s.point);
    $('#btn-apply-route').disabled = busy || !route || route.stale;
    $('#btn-print-map').disabled = busy || !stops.some((s) => s.point);
    $('#btn-route-question').disabled = !stops.length;
  }

  function render() {
    if (!window.VisitApp) return;
    const stops = buildStops();
    const route = currentRoute(stops);
    const ordered = orderedStops(stops, route);
    const sch = ordered && ordered.length ? scheduleOf(ordered) : null;
    renderButtons(stops, route);
    renderMap(stops, ordered, sch);

    const list = [];
    const office = pointOf(geo.officeAddress);
    if (geo.officeAddress) {
      list.push(`<li class="office">${office ? '' : '<span class="tag">位置未設定</span>'}事業所（出発）${office ? '' : ` <button type="button" class="btn small" data-pick="${esc(geo.officeAddress)}">地図で指定</button>`}</li>`);
    }
    const numbered = ordered || [];
    const unordered = stops.filter((s) => !numbered.includes(s));
    numbered.concat(unordered).forEach((s) => {
      const no = numbered.includes(s) ? `${numbered.indexOf(s) + 1}.` : '';
      const tag = s.point ? '' : '<span class="tag">位置未設定</span>';
      const pick = s.point ? '' : ` <button type="button" class="btn small" data-pick="${esc(s.addr)}"${s.addr ? '' : ' disabled'}>地図で指定</button>`;
      const memos = s.patients.filter((p) => patientNotes(p).length)
        .map((p) => `<div class="route-memo">${s.patients.length > 1 ? `${esc(p.name || p.id)}: ` : ''}${esc(patientNotes(p).join(' ／ '))}</div>`).join('');
      const v = sch && sch.byId.get(s.id);
      const time = v ? ` <span class="route-time${v.late > 0 ? ' late' : ''}">${esc(visitTimeText(v))}${v.late > 0 ? ' 時間の条件に間に合わない見込み' : ''}</span>` : '';
      list.push(`<li class="${s.gh ? 'gh' : ''}"><b>${no}</b> ${tag}${esc(stopLabel(s))}${time}${pick}${memos}<div class="route-addr">${esc(s.addr || '（住所なし）')}</div></li>`);
    });
    if (geo.officeAddress && geo.roundTrip && route && !route.stale) list.push(`<li class="office">事業所（帰着）${sch ? ` <span class="route-time">${esc(window.VisitSchedule.fmtAbout(sch.end))}</span>` : ''}</li>`);
    $('#route-list').innerHTML = list.join('') || '<li class="empty">当日リストに患者を追加すると表示されます</li>';

    const summary = ordered
      ? `直線距離 合計 約${pathKm(ordered).toFixed(1)}km（実際の道のりはこれより長くなります）。${sch ? `${endText(sch)}（目安）。` : ''}${sch && sch.lateCount ? `時間の条件に間に合わない見込み: ${sch.lateCount}か所。` : ''}`
      : route && route.stale ? '当日リスト・位置・時間の条件などが変わりました。「訪問順を計算」をもう一度押してください。' : '';
    $('#route-summary').textContent = summary;

    const links = ordered ? gmapsLinks(ordered) : [];
    $('#gmaps-links').innerHTML = links.length
      ? links.map((u, i) => `<a class="btn" href="${esc(u)}" target="_blank" rel="noopener noreferrer">Googleマップで経路を開く${links.length > 1 ? `（${i + 1}/${links.length}）` : ''}</a>`).join('')
        + '<p class="hint">Googleマップには住所（地図で指定した地点は座標）だけを渡します。</p>'
      : '';
  }

  // ---------- 地図の印刷（A4 横：左に地図、右に番号と患者・時間メモの一覧） ----------
  const PRINT_TILE_WAIT_MS = 15000;
  let printMap = null;

  function printRows(numbered, unlocated, sch) {
    const rows = [];
    const office = pointOf(geo.officeAddress);
    if (office) rows.push(`<tr class="office"><td class="no"><span class="mp-pin office">事</span></td><td colspan="2"><b>事業所（出発${geo.roundTrip ? '・帰着' : ''}）</b><div class="mp-addr">${esc(geo.officeAddress)}</div></td></tr>`);
    const stopRows = (s, no) => {
      const v = sch && sch.byId.get(s.id);
      const timeHtml = v ? `<div class="mp-time${v.late > 0 ? ' late' : ''}">${esc(window.VisitSchedule.fmtAbout(v.begin).replace('頃', ''))}</div>` : '';
      const noCell = (span) => `<td class="no"${span > 1 ? ` rowspan="${span}"` : ''}>${no ? `<span class="mp-pin ${pinClass(s, v)}">${no}</span>` : '－'}${timeHtml}</td>`;
      const memoCell = (p) => {
        const rule = window.VisitSchedule.rulesText(rulesOf(p));
        const late = v && v.late > 0 && rule ? '<div class="mp-late">※時間に間に合わない見込み</div>' : '';
        const ruleLines = rulesOf(p).filter(window.VisitSchedule.validRule).map((r) => `<div class="mp-rule">${esc(window.VisitSchedule.ruleText(r))}</div>`).join('');
        return `<td class="memo">${ruleLines}${memoOf(p) ? `<div>${esc(memoOf(p))}</div>` : ''}${late}</td>`;
      };
      const rowCls = (p) => (patientNotes(p).length ? ' class="has-memo"' : '');
      if (s.gh) {
        rows.push(`<tr class="gh-head">${noCell(s.patients.length + 1)}<td colspan="2"><b>${esc(s.gh)}</b>（${s.patients.length}名）<div class="mp-addr">${esc(s.addr || '（住所なし）')}</div></td></tr>`);
        s.patients.forEach((p) => rows.push(`<tr${rowCls(p)}><td class="name gh-member">${esc(p.name || p.id)}</td>${memoCell(p)}</tr>`));
        return;
      }
      s.patients.forEach((p, i) => {
        rows.push(`<tr${rowCls(p)}>${i === 0 ? noCell(s.patients.length) : ''}<td class="name"><b>${esc(p.name || p.id)}</b><div class="mp-addr">${esc(p.address || s.addr || '（住所なし）')}</div></td>${memoCell(p)}</tr>`);
      });
    };
    numbered.forEach((s, i) => stopRows(s, i + 1));
    if (unlocated.length) {
      rows.push('<tr class="sep"><td colspan="3">地図に位置が無い訪問先</td></tr>');
      unlocated.forEach((s) => stopRows(s, null));
    }
    return rows.join('');
  }

  function finishPrintMap() {
    document.body.classList.remove('printing-map');
    if (printMap) { printMap.remove(); printMap = null; }
  }

  async function startPrintMap() {
    if (busy) return;
    const stops = buildStops();
    const located = stops.filter((s) => s.point);
    if (!located.length) {
      setStatus('地図に表示できる訪問先がありません。先に「① 住所から位置を取得」を押してください。', true);
      return;
    }
    const route = currentRoute(stops);
    const ordered = orderedStops(stops, route);
    const numbered = ordered || located; // 未計算なら当日リストの順に番号を付ける
    const unlocated = stops.filter((s) => !numbered.includes(s));
    const people = stops.reduce((n, s) => n + s.patients.length, 0);
    const sch = ordered && ordered.length ? scheduleOf(ordered) : null;
    const set = scheduleSettings();

    $('#map-print-h1').textContent = '訪問ルート';
    $('#map-print-meta').textContent = `訪問日: ${window.VisitApp.visitDateText()}　${stops.length}か所・${people}名`
      + (ordered ? `　直線距離 約${pathKm(ordered).toFixed(1)}km` : '　（番号は当日リストの順）')
      + (sch ? `\n${window.VisitSchedule.fmtHM(set.start)}出発・${endText(sch)}（予定時刻は1件${set.svc}分・時速${set.speed}kmで計算した目安）` : '');
    $('#map-print-rows').innerHTML = printRows(numbered, unlocated, sch);
    $('#page-style').textContent = '@page { size: A4 landscape; margin: 10mm; }';

    busy = true;
    renderButtons();
    setStatus('印刷用の地図を準備しています…');
    finishPrintMap();
    document.body.classList.add('printing-map');
    printMap = L.map('map-print-map', {
      zoomControl: false, zoomSnap: 0.25, fadeAnimation: false, zoomAnimation: false, markerZoomAnimation: false,
      inertia: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false,
    });
    const tiles = L.tileLayer(TILE_URL, { attribution: '出典：地理院タイル', maxZoom: 18 });
    let tileErrors = 0;
    tiles.on('tileerror', () => { tileErrors += 1; });
    const tilesLoaded = new Promise((resolve) => tiles.once('load', () => resolve(true)));
    tiles.addTo(printMap);
    const layer = L.layerGroup().addTo(printMap);
    const pts = [];
    const office = pointOf(geo.officeAddress);
    if (office) {
      L.marker([office.lat, office.lng], { icon: pinIcon('事', 'office'), interactive: false }).addTo(layer);
      pts.push([office.lat, office.lng]);
    }
    if (ordered && ordered.length) {
      L.polyline(routeLine(ordered), { color: '#1f6feb', weight: 3, opacity: 0.85, dashArray: '7 5', interactive: false }).addTo(layer);
    }
    numbered.forEach((s, i) => {
      L.marker([s.point.lat, s.point.lng], { icon: pinIcon(i + 1, pinClass(s, sch && sch.byId.get(s.id))), interactive: false, zIndexOffset: 1000 - i }).addTo(layer);
      pts.push([s.point.lat, s.point.lng]);
    });
    if (pts.length === 1) printMap.setView(pts[0], 16);
    else printMap.fitBounds(L.latLngBounds(pts), { padding: [28, 28], maxZoom: 17 });

    const ok = (await Promise.race([tilesLoaded, sleep(PRINT_TILE_WAIT_MS).then(() => false)])) && tileErrors === 0;
    busy = false;
    renderButtons();
    setStatus(ok ? '' : '地図の画像の一部または全部を読み込めませんでした（インターネット接続を確認してください）。読み込めた分だけで印刷します。', !ok);
    // 印刷が終わったら（キャンセルでも）印刷用の地図を片付ける
    window.addEventListener('afterprint', finishPrintMap, { once: true });
    window.print();
  }

  // ---------- 経路の相談文（住所と時間の条件を並べた文章。氏名・IDは入れない） ----------
  function questionText() {
    const S = window.VisitSchedule;
    const stops = buildStops();
    const office = geo.officeAddress || '（事業所の住所）';
    const { start, svc } = scheduleSettings();
    const head = geo.roundTrip
      ? `開始地点、終了地点は${office}として、経由地は以下の通り。`
      : `開始地点は${office}、終了地点は最後の経由地として、経由地は以下の通り。`;
    const lines = [
      head + '住所の横に付随した時間の制限があるものとして、時間指定の条件を満たしながら、最短で回るのはどのような順番で回るのが良いか？',
      `（出発時刻は${S.fmtHM(start)}、各経由地での滞在時間は${svc}分とします。）`,
      '',
    ];
    let noAddr = 0;
    stops.forEach((s) => {
      if (!s.addr) { noAddr += 1; return; }
      const cond = S.stopRulesShort(s.patients.map(rulesOf));
      lines.push(cond ? `${s.addr}　${cond}` : s.addr);
    });
    return { text: lines.join('\n'), count: stops.length - noAddr, noAddr };
  }

  function openQuestion() {
    const { text, count, noAddr } = questionText();
    const warns = [];
    if (!geo.officeAddress) warns.push('「事業所（出発地）の住所」が未入力です。入力すると文章の開始・終了地点に入ります。');
    if (!count) warns.push('当日リストに住所のある訪問先がありません。');
    if (noAddr) warns.push(`住所が空欄の${noAddr}名は文章に入っていません。`);
    $('#question-warn').textContent = warns.join(' ');
    $('#question-warn').hidden = !warns.length;
    $('#question-text').value = text;
    $('#question-status').textContent = '';
    $('#question-dialog').showModal();
  }

  async function copyQuestion() {
    const ta = $('#question-text');
    const text = ta.value;
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (e) {
      ok = false;
    }
    if (!ok) {
      // まとめ画面のタブの中などで使えない場合の代わり
      ta.focus();
      ta.select();
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    }
    const st = $('#question-status');
    st.textContent = ok ? 'コピーしました。貼り付けたい所で Ctrl + V を押してください。' : 'コピーできませんでした。文章を選んで Ctrl + C でコピーしてください。';
    st.classList.toggle('is-warn', !ok);
  }

  function clearStorage() {
    localStorage.removeItem(GEO_KEY);
    geo.cache = {};
    geo.route = null;
    geo.officeAddress = '';
    $('#office-address').value = '';
    render();
  }

  function init() {
    loadGeo();
    $('#office-address').value = geo.officeAddress;
    $('#trip-mode').value = geo.roundTrip ? 'round' : 'oneway';
    $('#office-address').addEventListener('change', (e) => {
      geo.officeAddress = e.target.value.trim();
      saveGeo();
      render();
    });
    [['#start-time', 'startTime'], ['#service-min', 'serviceMin'], ['#speed-kmh', 'speedKmh']].forEach(([sel, key]) => {
      const el = $(sel);
      el.value = geo[key];
      el.addEventListener('change', () => {
        geo[key] = el.type === 'number' ? Number(el.value) || geo[key] : (el.value || geo[key]);
        el.value = geo[key];
        saveGeo();
        render();
      });
    });
    $('#trip-mode').addEventListener('change', (e) => {
      geo.roundTrip = e.target.value === 'round';
      saveGeo();
      render();
    });
    $('#btn-geocode').addEventListener('click', geocodeMissing);
    $('#btn-optimize').addEventListener('click', () => { computeRoute(); fitAll(); });
    $('#btn-apply-route').addEventListener('click', applyRoute);
    $('#btn-fit').addEventListener('click', fitAll);
    $('#btn-print-map').addEventListener('click', startPrintMap);
    $('#btn-route-question').addEventListener('click', openQuestion);
    $('#question-copy').addEventListener('click', copyQuestion);
    $('#question-close').addEventListener('click', () => $('#question-dialog').close());
    $('#route-list').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-pick]');
      if (!b) return;
      pickAddr = b.dataset.pick;
      $('#route-map').classList.add('picking');
      setStatus(`地図上をクリックして「${pickAddr}」の位置を指定してください。`);
    });
    render();
    fitAll();
  }

  window.VisitRoute = { refresh: render, clearStorage };
  document.addEventListener('DOMContentLoaded', init);
})();
