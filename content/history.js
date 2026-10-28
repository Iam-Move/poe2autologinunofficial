/* 웹 거래소에서 사라진 거래 내역(History) 버튼을 되살린다.
   /api/trade2/history/<리그> 는 아직 살아 있으므로, 우측 상단 메뉴에 버튼을 붙이고
   누르면 판매 내역 목록 + 아이템 툴팁을 Shadow DOM 창으로 보여준다. */
(() => {
  'use strict';

  const TAG = '[KakaoAutoLogin]';
  const CDN = 'https://web.poecdn.com';
  const log = (...args) => console.log(TAG, ...args);

  // 리그 드롭다운 표시명 -> API 리그 ID (URL 에서 리그를 못 읽었을 때의 폴백)
  const LEAGUE_IDS = {
    '금단의 의식': 'Forbidden Rites',
    '금단의 의식(하드코어)': 'HC Forbidden Rites',
    '알두르의 룬': 'Runes of Aldur',
    '알두르의 룬(하드코어)': 'HC Runes of Aldur',
    스탠다드: 'Standard',
    하드코어: 'Hardcore',
  };

  const RARITY_COLORS = {
    Unique: '#af6025',
    Rare: '#ffff77',
    Magic: '#8888ff',
    Normal: '#c8c8c8',
    Gem: '#1ba29b',
    Currency: '#aa9e82',
  };

  /* ---------- 유틸 ---------- */

  /** "[Tag|표시]" -> "표시", "[표시]" -> "표시" */
  const stripMarkup = (s) =>
    String(s == null ? '' : s)
      .replace(/\[([^\]|]*)\|([^\]]*)\]/g, '$2')
      .replace(/\[([^\]]*)\]/g, '$1')
      .replace(/\r/g, '');

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text; // API 문자열은 항상 textContent 로만 넣는다
    return node;
  }

  function relativeTime(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(diff)) return '';
    const min = Math.floor(diff / 60000);
    if (min < 1) return '방금';
    if (min < 60) return `${min}분전`;
    const hour = Math.floor(min / 60);
    if (hour < 24) return `${hour}시간전`;
    return `${Math.floor(hour / 24)}일전`;
  }

  function rarityOf(item) {
    if (item.rarity && RARITY_COLORS[item.rarity]) return item.rarity;
    if (item.frameType === 4) return 'Gem';
    if (item.frameType === 5) return 'Currency';
    return 'Normal';
  }

  function itemTitle(item) {
    return stripMarkup(item.name || item.typeLine || item.baseType || '(알 수 없음)');
  }

  /* ---------- 리그 ---------- */

  function currentLeague() {
    const parts = location.pathname.split('/');
    const i = parts.indexOf('poe2');
    if (i !== -1 && parts[i + 1]) {
      try {
        return decodeURIComponent(parts[i + 1]);
      } catch (_) {
        /* 무시하고 드롭다운으로 */
      }
    }
    for (const span of document.querySelectorAll('.multiselect__single')) {
      const name = span.textContent.replace(/^PoE2\s*-\s*/i, '').replace(/\s+/g, '').trim();
      for (const [label, id] of Object.entries(LEAGUE_IDS)) {
        if (label.replace(/\s+/g, '') === name) return id;
      }
    }
    return null;
  }

  /* ---------- API ---------- */

  let currencyCache = null;

  async function loadCurrencies() {
    if (currencyCache) return currencyCache;
    const saved = ssGet(CURRENCY_KEY);
    if (saved) return (currencyCache = saved);
    const map = {};
    try {
      const res = await fetch('/api/trade2/data/static', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const groups = (json && json.result) || [];
      for (const group of groups) {
        if (group.id !== 'Currency') continue;
        for (const entry of group.entries || []) map[entry.id] = entry;
      }
      currencyCache = map;
      ssSet(CURRENCY_KEY, map);
    } catch (err) {
      console.warn(TAG, '화폐 목록을 불러오지 못함', err);
    }
    return map;
  }

  /* 거래소 API 는 요청 횟수 제한(429)이 빡빡하다.
     -> 내역은 리그별로 CACHE_TTL_MS 동안 재사용하고, 429 를 받으면 Retry-After 동안 요청하지 않는다.
     (sessionStorage 라 탭을 새로고침해도 유지된다) */
  const CACHE_TTL_MS = 5 * 60000; // 판매 내역은 자주 바뀌지 않는다. 새로 보려면 ↻
  const DEFAULT_RETRY_SEC = 60;
  const BLOCK_KEY = 'kal_history_block';
  const CURRENCY_KEY = 'kal_currencies';
  const cacheKey = (league) => `kal_history_${league}`;

  function ssGet(key) {
    try {
      return JSON.parse(sessionStorage.getItem(key) || 'null');
    } catch (_) {
      return null;
    }
  }

  function ssSet(key, value) {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
      /* 저장 실패는 무시 (캐시가 없을 뿐) */
    }
  }

  function rateLimitError(until, cached) {
    const err = new Error('HTTP 429');
    err.status = 429;
    err.until = until;
    err.cached = cached;
    return err;
  }

  /** GGG 식 레이트 리밋 헤더를 읽어, 한도에 닿기 직전이면 스스로 요청을 멈춘다.
   *  한도를 넘기면 서버가 긴 벌칙(예: 3600초)을 주므로, 넘기기 전에 쉬는 편이 훨씬 낫다.
   *    X-Rate-Limit-Rules: Account,Ip
   *    X-Rate-Limit-Account: 최대:구간초:벌칙초,...        (예: 5:60:3600)
   *    X-Rate-Limit-Account-State: 현재횟수:구간초:남은벌칙,... */
  function throttleFromHeaders(headers) {
    const rules = (headers.get('X-Rate-Limit-Rules') || '').split(',').map((s) => s.trim());
    let waitSec = 0;
    for (const rule of rules.filter(Boolean)) {
      const limits = (headers.get(`X-Rate-Limit-${rule}`) || '').split(',');
      const states = (headers.get(`X-Rate-Limit-${rule}-State`) || '').split(',');
      limits.forEach((limit, i) => {
        const [max, period] = limit.split(':').map(Number);
        const [hits] = (states[i] || '').split(':').map(Number);
        if (!max || !period || !Number.isFinite(hits)) return;
        // 남은 횟수가 1번 이하면 그 구간이 끝날 때까지 쉰다
        if (hits >= max - 1) waitSec = Math.max(waitSec, period);
      });
    }
    if (!waitSec) return;
    ssSet(BLOCK_KEY, { until: Date.now() + waitSec * 1000 });
    log(`거래 내역 요청 한도에 가까워 ${waitSec}초 동안 새로 불러오지 않습니다.`);
  }

  /** @returns {{ rows: object[], at: number, fromCache: boolean }} */
  async function loadHistory(league, { force = false } = {}) {
    const now = Date.now();
    const cached = ssGet(cacheKey(league));
    if (!force && cached && now - cached.at < CACHE_TTL_MS) {
      return { rows: cached.rows, at: cached.at, fromCache: true };
    }

    const block = ssGet(BLOCK_KEY);
    if (block && now < block.until) throw rateLimitError(block.until, cached);

    const res = await fetch(`/api/trade2/history/${encodeURIComponent(league)}`, {
      credentials: 'include',
    });
    if (res.status === 429) {
      const sec = parseInt(res.headers.get('Retry-After'), 10) || DEFAULT_RETRY_SEC;
      const until = Date.now() + sec * 1000;
      ssSet(BLOCK_KEY, { until });
      log(`거래 내역 요청 제한(429) - ${sec}초 대기`);
      throw rateLimitError(until, cached);
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    throttleFromHeaders(res.headers);
    const json = await res.json();
    const rows = (json && json.result) || [];
    const at = Date.now();
    ssSet(cacheKey(league), { at, rows });
    return { rows, at, fromCache: false };
  }

  /* ---------- 창 (Shadow DOM) ---------- */

  const STYLE = `
    :host { all: initial; }
    .overlay {
      position: fixed; inset: 0; z-index: 2147483000;
      background: rgba(0, 0, 0, .6);
      display: flex; align-items: center; justify-content: center;
      font: 13px/1.4 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; color: #c8c8c8;
    }
    .panel {
      width: min(1080px, calc(100vw - 32px)); height: min(86vh, 1000px);
      display: flex; flex-direction: column;
      background: #161616; border: 1px solid #333; border-radius: 6px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, .7);
    }
    .head {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 14px; border-bottom: 1px solid #2a2a2a;
    }
    .title { flex: 1; font-size: 15px; font-weight: 700; color: #e05a5a; }
    .league { color: #888; font-size: 12px; font-weight: 400; margin-left: 6px; }
    .iconbtn {
      width: 30px; height: 30px; border: 1px solid #444; border-radius: 4px;
      background: #1e1e1e; color: #ccc; cursor: pointer; font-size: 15px;
    }
    .iconbtn:hover { background: #2a2a2a; color: #fff; }
    .body { flex: 1; overflow-y: auto; padding: 6px; }
    .msg { padding: 40px 0; text-align: center; color: #999; }
    .msg button {
      margin-top: 10px; padding: 6px 14px; border: 1px solid #555; border-radius: 4px;
      background: #222; color: #ddd; cursor: pointer;
    }
    .notice {
      margin: 2px 2px 6px; padding: 7px 10px; border-radius: 4px;
      font-size: 12px; background: #1f1f1f; color: #aaa;
    }
    .notice--warn { background: #2a2214; color: #d8b26a; border: 1px solid #4a3a1c; }
    .row {
      display: flex; align-items: center; gap: 10px;
      padding: 7px 8px; border-bottom: 1px solid #262626;
    }
    .row:hover { background: #1e1e1e; }
    .row--new { background: rgba(217, 48, 37, .08); box-shadow: inset 3px 0 0 #d93025; }
    .row--new:hover { background: rgba(217, 48, 37, .14); }
    .new, .newcount {
      flex: none; padding: 1px 6px; border-radius: 9px;
      background: #d93025; color: #fff; font-size: 10.5px; font-weight: 700; line-height: 16px;
    }
    .newcount { margin-left: 8px; font-size: 11px; vertical-align: 2px; }
    .sold { color: #888; font-size: 12px; flex: none; }
    .name { font-weight: 700; cursor: default; flex: none; }
    .price { display: flex; align-items: center; gap: 4px; color: #bbb; flex: none; }
    .price img { width: 20px; height: 20px; }
    .cur { color: #c8a86a; }
    .time { margin-left: auto; color: #888; font-size: 12px; flex: none; }

    .tip {
      position: fixed; z-index: 2147483001; pointer-events: none;
      width: 380px; max-width: calc(100vw - 24px);
      background: rgba(8, 8, 8, .97); border: 1px solid; border-radius: 3px;
      text-align: center; font-size: 13px; line-height: 1.45;
    }
    .tip[hidden] { display: none; }
    .tip__head { padding: 8px 10px; border-bottom: 1px solid; }
    .tip__head img { max-width: 64px; max-height: 96px; display: block; margin: 0 auto 6px; }
    .tip__name { font-size: 15px; font-weight: 700; }
    .tip__base { font-size: 14px; }
    .tip__sec { padding: 6px 10px; border-top: 1px solid #3a2f22; }
    .tip__sec:first-of-type { border-top: 0; }
    .prop { color: #7f7f7f; }
    .prop b { color: #fff; font-weight: 400; }
    .enchant { color: #b4b4ff; }
    .rune { color: #8bd1e0; }
    .mod { color: #8888ff; }
    .skill { color: #c8c8c8; }
    .corrupted { color: #d20000; }
    .unid { color: #d20000; }
    .flavour { color: #af6025; font-style: italic; }
  `;

  let host = null;
  let ui = null;

  function buildUi() {
    host = document.createElement('div');
    host.id = 'kal-history-host';
    const root = host.attachShadow({ mode: 'open' });

    const style = el('style');
    style.textContent = STYLE;

    const overlay = el('div', 'overlay');
    const panel = el('div', 'panel');
    const head = el('div', 'head');
    const title = el('div', 'title');
    const refresh = el('button', 'iconbtn', '↻');
    refresh.title = '새로고침';
    const close = el('button', 'iconbtn', '✕');
    close.title = '닫기';
    head.append(title, refresh, close);
    const body = el('div', 'body');
    panel.append(head, body);
    overlay.append(panel);

    const tip = el('div', 'tip');
    tip.hidden = true;

    root.append(style, overlay, tip);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeUi();
    });
    close.addEventListener('click', closeUi);
    refresh.addEventListener('click', () => render({ force: true }));

    ui = { root, overlay, title, body, tip };
  }

  function onKeydown(e) {
    if (e.key === 'Escape') closeUi();
  }

  // 창을 연 시점의 '마지막으로 본 판매 시각'. 열자마자 markSeen() 이 갱신하므로 미리 떠 둔다.
  // 창이 열려 있는 동안(↻ 포함)은 같은 값을 써서 NEW 표시가 사라지지 않게 한다.
  let newSince = null;

  async function openUi() {
    if (!host) buildUi();
    if (!host.isConnected) document.body.append(host);
    document.addEventListener('keydown', onKeydown, true);
    newSince = null;
    try {
      const { sales } = await chrome.storage.local.get({ sales: null });
      if (sales && sales.seenTime > 0) newSince = { league: sales.league, seenTime: sales.seenTime };
    } catch (_) {
      /* 확장이 새로고침된 직후라 연결이 끊긴 경우 - NEW 표시 없이 연다 */
    }
    render();
  }

  function closeUi() {
    newSince = null;
    clearInterval(countdownTimer);
    if (host) host.remove();
    if (ui) ui.tip.hidden = true;
    document.removeEventListener('keydown', onKeydown, true);
  }

  function setTitle(count, league) {
    ui.title.textContent = count == null ? '거래 내역' : `거래 내역 (${count})`;
    if (league) ui.title.append(el('span', 'league', league));
  }

  function showMessage(text, retry) {
    clearInterval(countdownTimer);
    ui.body.textContent = '';
    const box = el('div', 'msg', text);
    if (retry) {
      box.append(el('br'));
      const btn = el('button', null, '다시 시도');
      btn.addEventListener('click', () => render({ force: true }));
      box.append(btn);
    }
    ui.body.append(box);
  }

  /* 요청 제한 중 남은 시간 표시. 끝나면 [다시 시도] 를 활성화한다. */
  let countdownTimer = null;

  function startCountdown(node, until, onDone) {
    clearInterval(countdownTimer);
    const tick = () => {
      const left = Math.ceil((until - Date.now()) / 1000);
      if (left <= 0) {
        clearInterval(countdownTimer);
        onDone();
        return;
      }
      node.textContent = `요청이 너무 많아 잠시 막혔습니다. ${left}초 후 다시 불러올 수 있습니다.`;
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  function retryButton() {
    const btn = el('button', null, '다시 시도');
    btn.addEventListener('click', () => render({ force: true }));
    return btn;
  }

  function showRateLimited(until) {
    showMessage('');
    const box = ui.body.firstChild;
    const text = el('span');
    box.append(text);
    startCountdown(text, until, () => {
      text.textContent = '이제 다시 불러올 수 있습니다.';
      box.append(el('br'), retryButton());
    });
  }

  function notice(className, text) {
    const bar = el('div', `notice ${className}`, text);
    ui.body.prepend(bar);
    return bar;
  }

  let renderSeq = 0;

  async function render({ force = false } = {}) {
    const seq = ++renderSeq;
    const league = currentLeague();
    setTitle(null, league);
    if (!league) {
      showMessage('현재 리그를 알 수 없습니다. 거래소 검색 화면에서 다시 시도해 주세요.');
      return;
    }
    showMessage('불러오는 중…');

    let result;
    let currencies;
    try {
      [result, currencies] = await Promise.all([loadHistory(league, { force }), loadCurrencies()]);
    } catch (err) {
      if (seq !== renderSeq) return;
      if (err.status === 429) {
        // 예전에 받아 둔 내역이 있으면 그거라도 보여준다
        if (err.cached && err.cached.rows) {
          currencies = await loadCurrencies();
          if (seq !== renderSeq) return;
          renderRows(err.cached.rows, currencies, league);
          markSeen(league, err.cached.rows);
          const bar = notice('notice--warn', '');
          startCountdown(bar, err.until, () => {
            bar.textContent = `${relativeTime(new Date(err.cached.at).toISOString())} 받아 둔 내역입니다. ↻ 로 새로 불러올 수 있습니다.`;
          });
        } else {
          showRateLimited(err.until);
        }
        return;
      }
      if (err.status === 401 || err.status === 403) showMessage('로그인이 필요합니다.');
      else showMessage(`불러오지 못했습니다 (${err.message})`, true);
      return;
    }
    if (seq !== renderSeq) return; // 더 최근 요청이 있으면 버린다

    renderRows(result.rows, currencies, league);
    markSeen(league, result.rows);
  }

  /** 내역을 봤다고 background 에 알린다 -> 새 판매 배지를 0으로, 이 리그를 감시 대상으로. */
  function markSeen(league, rows) {
    const latest = rows.reduce((max, r) => Math.max(max, Date.parse(r.time) || 0), 0);
    try {
      chrome.runtime.sendMessage({ type: 'historySeen', league, latest }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {
      /* 확장이 새로고침된 직후라 연결이 끊긴 경우 - 무시 */
    }
  }

  function renderRows(rows, currencies, league) {
    clearInterval(countdownTimer);
    setTitle(rows.length, league);
    if (!rows.length) {
      showMessage('거래 내역이 없습니다.');
      return;
    }
    ui.body.textContent = '';
    const since = newSince && newSince.league === league ? newSince.seenTime : 0;
    let newCount = 0;
    for (const entry of rows) {
      const isNew = since > 0 && Date.parse(entry.time) > since;
      if (isNew) newCount += 1;
      ui.body.append(buildRow(entry, currencies, isNew));
    }
    if (newCount) ui.title.append(el('span', 'newcount', `새 판매 ${newCount}`));
  }

  function buildRow(entry, currencies, isNew) {
    const item = entry.item || {};
    const row = el('div', isNew ? 'row row--new' : 'row');
    if (isNew) row.append(el('span', 'new', 'NEW'));
    row.append(el('span', 'sold', '판매됨'));

    const name = el('span', 'name', itemTitle(item));
    name.style.color = RARITY_COLORS[rarityOf(item)];
    name.addEventListener('mouseenter', (e) => showTip(item, e));
    name.addEventListener('mousemove', moveTip);
    name.addEventListener('mouseleave', hideTip);
    row.append(name);

    const price = el('span', 'price');
    if (entry.price) {
      const cur = currencies[entry.price.currency];
      price.append(document.createTextNode(`가격: ${entry.price.amount}x`));
      if (cur && cur.image) {
        const img = el('img');
        img.src = /^https?:/.test(cur.image) ? cur.image : CDN + cur.image;
        img.alt = '';
        price.append(img);
      }
      price.append(el('span', 'cur', cur ? cur.text : entry.price.currency));
    }
    row.append(price);

    const time = el('span', 'time', relativeTime(entry.time));
    time.title = new Date(entry.time).toLocaleString();
    row.append(time);
    return row;
  }

  /* ---------- 아이템 툴팁 ---------- */

  const modText = (m) => stripMarkup(typeof m === 'string' ? m : m && m.description);

  /** { name, values: [[값, 타입]], displayMode } -> "이름: 값" (displayMode 3 은 {0} 자리 채우기) */
  function propText(p) {
    const name = stripMarkup(p.name);
    const values = (p.values || []).map((v) => stripMarkup(Array.isArray(v) ? v[0] : v));
    if (p.displayMode === 3) return name.replace(/\{(\d+)\}/g, (_, i) => values[i] || '');
    if (!values.length) return name;
    return { name, value: values.join(', ') };
  }

  function appendProp(sec, p) {
    const t = typeof p === 'string' ? p : propText(p);
    const line = el('div', 'prop');
    if (typeof t === 'string') {
      line.textContent = t;
    } else {
      line.append(document.createTextNode(`${t.name}: `), el('b', null, t.value));
    }
    sec.append(line);
  }

  function section(tip) {
    const sec = el('div', 'tip__sec');
    tip.append(sec);
    return sec;
  }

  function addLines(tip, list, className, fmt = modText) {
    if (!Array.isArray(list) || !list.length) return;
    const sec = section(tip);
    for (const entry of list) {
      const text = fmt(entry);
      if (text) sec.append(el('div', className, text));
    }
  }

  function showTip(item, e) {
    const tip = ui.tip;
    tip.textContent = '';
    const color = RARITY_COLORS[rarityOf(item)];
    tip.style.borderColor = color;

    const head = el('div', 'tip__head');
    head.style.borderBottomColor = color;
    if (item.icon) {
      const img = el('img');
      img.src = item.icon;
      img.alt = '';
      head.append(img);
    }
    if (item.name) head.append(el('div', 'tip__name', stripMarkup(item.name)));
    const base = el('div', item.name ? 'tip__base' : 'tip__name', stripMarkup(item.typeLine || item.baseType));
    head.append(base);
    head.style.color = color;
    tip.append(head);

    if (Array.isArray(item.properties) && item.properties.length) {
      const sec = section(tip);
      item.properties.forEach((p) => appendProp(sec, p));
    }

    const reqs = Array.isArray(item.requirements) ? item.requirements : [];
    if (item.ilvl || reqs.length) {
      const sec = section(tip);
      if (item.ilvl) appendProp(sec, { name: '아이템 레벨', values: [[String(item.ilvl), 0]] });
      if (reqs.length) {
        const parts = reqs.map((r) => {
          const t = propText(r);
          return typeof t === 'string' ? t : `${t.name} ${t.value}`;
        });
        appendProp(sec, { name: '요구 사항', values: [[parts.join(', '), 0]] });
      }
    }

    addLines(tip, item.enchantMods, 'enchant');
    addLines(tip, item.runeMods, 'rune');
    addLines(tip, item.implicitMods, 'mod');
    addLines(tip, item.explicitMods, 'mod');
    addLines(tip, item.grantedSkills, 'skill', (s) => {
      const t = propText(s);
      return typeof t === 'string' ? t : `${t.name}: ${t.value}`;
    });

    if (item.identified === false || item.corrupted) {
      const sec = section(tip);
      if (item.identified === false) sec.append(el('div', 'unid', '미확인'));
      if (item.corrupted) sec.append(el('div', 'corrupted', '타락'));
    }

    addLines(tip, item.flavourText, 'flavour', stripMarkup);

    tip.hidden = false;
    moveTip(e);
  }

  function moveTip(e) {
    const tip = ui.tip;
    if (tip.hidden) return;
    const pad = 12;
    const rect = tip.getBoundingClientRect();
    let x = e.clientX + 18;
    let y = e.clientY + 18;
    if (x + rect.width > innerWidth - pad) x = Math.max(pad, e.clientX - rect.width - 18);
    if (y + rect.height > innerHeight - pad) y = Math.max(pad, innerHeight - rect.height - pad);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }

  function hideTip() {
    if (ui) ui.tip.hidden = true;
  }

  /* ---------- 메뉴 버튼 주입 ---------- */

  let enabled = false; // 팝업 설정의 '거래소 History 버튼'
  let saleCount = 0; // background 가 30분마다 센 새 판매 개수 (chrome.storage.local.sales.count)

  /** History 버튼 좌측 상단의 빨간 숫자 배지. 버튼을 다시 붙일 때도 호출된다. */
  function updateButtonBadge() {
    const a = document.querySelector('li.menu-history > a');
    if (!a) return;
    let badge = a.querySelector('.kal-history-badge');
    if (!badge) {
      badge = el('span', 'kal-history-badge');
      // 페이지 DOM 이라 사이트 CSS 와 섞이지 않게 inline 으로 지정한다
      badge.style.cssText =
        'position:absolute;top:2px;left:2px;min-width:16px;height:16px;padding:0 4px;' +
        'box-sizing:border-box;border-radius:8px;background:#d93025;color:#fff;' +
        'font:700 10px/16px sans-serif;text-align:center;pointer-events:none;';
      a.style.position = 'relative';
      a.append(badge);
    }
    badge.textContent = saleCount > 99 ? '99+' : String(saleCount);
    badge.style.display = saleCount > 0 ? '' : 'none';
    a.title = saleCount > 0 ? `거래 내역 · 새 판매 ${saleCount}건` : '거래 내역';
  }

  function injectButton() {
    if (!enabled) return;
    const menu = document.querySelector('ul.nav.nav-tabs.account');
    if (!menu || menu.querySelector('li.menu-history')) return;

    const li = el('li', 'menu-history');
    li.setAttribute('role', 'presentation');
    const a = el('a');
    a.href = '#';
    a.title = '거래 내역';
    a.append(el('span', null, 'History'));
    li.append(a);

    // li 가 float:right 라 DOM 끝에 붙이면 화면에서는 [설정] 왼쪽에 놓인다
    menu.append(li);
    updateButtonBadge();
    log('History 버튼 추가');
  }

  function removeButton() {
    document.querySelectorAll('li.menu-history').forEach((li) => li.remove());
    closeUi();
  }

  function apply(on) {
    enabled = on;
    if (on) injectButton();
    else removeButton();
  }

  // 사이트(Vue)가 마운트하면서 메뉴 DOM 을 템플릿째 다시 만들기 때문에,
  // 버튼에 직접 단 리스너는 사라진다 -> document 캡처 단계에서 위임 처리한다.
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!enabled || !target || !target.closest('li.menu-history')) return;
      e.preventDefault();
      e.stopPropagation(); // 사이트의 탭 전환 핸들러로 넘기지 않는다
      openUi();
    },
    true
  );

  chrome.storage.sync.get({ historyEnabled: true }, (cfg) => apply(cfg.historyEnabled !== false));
  // 팝업에서 토글하면 열린 탭에도 바로 반영한다
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.historyEnabled) apply(changes.historyEnabled.newValue !== false);
    if (area === 'local' && changes.sales) {
      saleCount = (changes.sales.newValue && changes.sales.newValue.count) || 0;
      updateButtonBadge();
    }
  });
  chrome.storage.local.get({ sales: null }, ({ sales }) => {
    saleCount = (sales && sales.count) || 0;
    updateButtonBadge();
  });
  // 거래소는 SPA 라 메뉴가 다시 그려질 수 있다 -> 사라지면 다시 붙인다
  new MutationObserver(injectButton).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
