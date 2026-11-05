'use strict';

const DEFAULTS = {
  enabled: true,
  kakaoEmail: '', // 설치 직후에는 비어 있다. 사용자가 설정 탭에서 직접 입력한다.
  stepTimeoutMs: 8000,
  maxAttempts: 3,
  historyEnabled: true,
  saleBadgeEnabled: false,
};
const TRADE_URL = 'https://poe.kakaogames.com/trade2';
const GAME_URL = 'https://pathofexile2.kakaogames.com/main';
const CONTACT_URL = 'https://open.kakao.com/me/iammove'; // 문의 · 건의 (카카오톡 오픈채팅)

const $ = (id) => document.getElementById(id);

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      void chrome.runtime.lastError;
      resolve(response || {});
    });
  });
}

/* ---------- 표시용 유틸 ---------- */

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatWhen(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const yesterday = new Date(today.getTime() - 86400000).toDateString() === d.toDateString();
  const time = formatTime(ts);
  if (sameDay) return `오늘 ${time}`;
  if (yesterday) return `어제 ${time}`;
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${time}`;
}

/* ---------- 렌더링 ---------- */

function renderStatus(state) {
  const card = $('statusCard');
  const result = state.lastResult;
  const text = $('statusText');
  const sub = $('statusSub');
  const resetBtn = $('resetBtn');

  card.classList.remove('is-ok', 'is-fail', 'is-running', 'is-setup');
  resetBtn.hidden = !state.aborted;
  $('setupBtn').hidden = !state.needsSetup;

  // 계정이 아직 비어 있으면 그것부터 안내한다 (설치 직후 상태)
  if (state.needsSetup) {
    card.classList.add('is-setup');
    text.textContent = '설정이 필요합니다';
    sub.textContent = '어떤 카카오 계정으로 로그인할지 아직 입력하지 않았습니다.';
    return;
  }

  if (state.flowActive) {
    card.classList.add('is-running');
    text.textContent = '자동 로그인 진행 중';
    sub.textContent = result && result.step ? result.step : '단계를 진행하고 있습니다.';
    return;
  }

  if (!result || result.status === 'idle') {
    text.textContent = state.aborted ? '중단됨' : '기록 없음';
    sub.textContent = state.aborted
      ? '재시도 한도를 넘어 멈춰 있습니다.'
      : '아직 자동 로그인을 실행한 적이 없습니다.';
    if (state.aborted) card.classList.add('is-fail');
    return;
  }

  if (result.status === 'success') {
    card.classList.add('is-ok');
    text.textContent = '마지막 로그인 성공';
    sub.textContent = `${formatWhen(result.at)} · ${result.steps || 0}단계 완료`;
    return;
  }

  if (result.status === 'fail') {
    card.classList.add('is-fail');
    text.textContent = '마지막 로그인 실패';
    sub.textContent = `${formatWhen(result.at)} · ${result.reason || '원인을 알 수 없습니다.'}`;
    return;
  }

  // running 상태로 남아있지만 플로우가 이미 끝난 경우
  text.textContent = '진행 중이던 기록';
  sub.textContent = `${formatWhen(result.at)} · ${result.step || ''}`;
}

function renderLogs(logs) {
  const list = $('logList');
  list.textContent = '';
  if (!logs.length) {
    const li = document.createElement('li');
    li.className = 'logs__empty';
    li.textContent = '기록이 없습니다.';
    list.append(li);
    return;
  }
  for (const entry of [...logs].reverse()) {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = formatTime(entry.at);
    const span = document.createElement('span');
    span.className = `lv-${entry.level}`;
    span.textContent = entry.text;
    li.append(time, span);
    list.append(li);
  }
}

function renderSettings(cfg) {
  $('enabled').checked = cfg.enabled;
  $('kakaoEmail').value = cfg.kakaoEmail;
  $('stepTimeoutMs').value = cfg.stepTimeoutMs;
  $('maxAttempts').value = cfg.maxAttempts;
  $('historyEnabled').checked = cfg.historyEnabled;
  $('saleBadgeEnabled').checked = cfg.saleBadgeEnabled;
  $('saleBadgeEnabled').disabled = !cfg.historyEnabled; // History 를 끄면 배지도 동작하지 않는다
  $('accountText').textContent = cfg.kakaoEmail || '(설정되지 않음)';
}

async function refresh() {
  const state = await send({ type: 'getState' });
  const cfg = { ...DEFAULTS, ...(state.config || {}) };
  renderSettings(cfg);
  renderStatus(state);
  renderLogs(state.logs || []);
}

/* ---------- 설정 저장 ---------- */

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

let savedTimer = null;
function flashSaved() {
  const msg = $('savedMsg');
  msg.classList.add('is-on');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => msg.classList.remove('is-on'), 1500);
}

async function saveSettings() {
  const cfg = {
    enabled: $('enabled').checked,
    kakaoEmail: $('kakaoEmail').value.trim(),
    stepTimeoutMs: clamp($('stepTimeoutMs').value, 1000, 30000, DEFAULTS.stepTimeoutMs),
    maxAttempts: clamp($('maxAttempts').value, 1, 10, DEFAULTS.maxAttempts),
    historyEnabled: $('historyEnabled').checked,
    saleBadgeEnabled: $('saleBadgeEnabled').checked,
  };
  await chrome.storage.sync.set(cfg);
  await send({ type: 'configUpdated' }); // 계정을 채웠으면 '설정 필요' 배지를 해제
  renderSettings(cfg);
  flashSaved();
  await refresh();
}

/* ---------- 이벤트 ---------- */

function selectTab(name) {
  document.querySelectorAll('.tabs__btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.tab === name);
  });
  document.querySelectorAll('.panel').forEach((p) => {
    p.classList.toggle('is-active', p.dataset.panel === name);
  });
}

document.querySelectorAll('.tabs__btn').forEach((btn) => {
  btn.addEventListener('click', () => selectTab(btn.dataset.tab));
});

$('setupBtn').addEventListener('click', () => {
  selectTab('settings');
  $('kakaoEmail').focus();
});

['enabled', 'kakaoEmail', 'stepTimeoutMs', 'maxAttempts', 'historyEnabled', 'saleBadgeEnabled'].forEach((id) => {
  $(id).addEventListener('change', saveSettings);
});

$('openTradeBtn').addEventListener('click', async () => {
  await chrome.tabs.create({ url: TRADE_URL });
  window.close();
});

$('startGameBtn').addEventListener('click', async () => {
  await send({ type: 'launchGame' }); // 메인 페이지에서 게임 시작 버튼을 한 번 누르도록 표시
  await chrome.tabs.create({ url: GAME_URL });
  window.close();
});

async function openContact() {
  await chrome.tabs.create({ url: CONTACT_URL });
  window.close();
}
$('contactLink').addEventListener('click', openContact);
$('contactBtn').addEventListener('click', openContact);

/* ---------- 버전 / 업데이트 ---------- */

// 새 버전을 낼 때 맨 위에 한 줄씩 추가한다.
const CHANGELOG = [
  { v: '1.1.5', date: '2026-11-05', items: [
    '카카오 계정 선택 화면에서 가끔 클릭이 먹지 않던 문제 수정 (반응이 없으면 다시 클릭)',
    '버전 탭 추가: 현재/최신 버전, 업데이트 확인, 업데이트 내역',
  ] },
  { v: '1.1.4', date: '2026-11-05', items: ['창이 좁을 때 GAME START 버튼을 못 찾던 문제 수정'] },
  { v: '1.1.3', date: '2026-11-05', items: ['POE2 메인 화면 개편 대응 (GAME START 버튼, 공지 팝업)'] },
  { v: '1.1.2', date: '2026-10-28', items: [
    '거래소 History 버튼에 새 판매 개수 표시',
    'History 창에서 새로 팔린 아이템에 NEW 표시',
    '문의 · 건의 (카카오톡 오픈채팅) 버튼 추가',
  ] },
  { v: '1.1.1', date: '2026-10-27', items: ['History 버튼 켜기/끄기 설정', '새 판매 배지 알림 (30분마다 확인)'] },
  { v: '1.1.0', date: '2026-10-27', items: ['첫 공개: 카카오 자동 로그인, 게임 시작, 거래소 History 버튼'] },
];

const CUR_VERSION = chrome.runtime.getManifest().version;
// 웹 스토어에서 설치하면 크롬이 manifest 에 update_url 을 넣어 준다. 없으면 개발자 모드(압축해제) 설치.
const FROM_STORE = 'update_url' in chrome.runtime.getManifest();
const AUTO_CHECK_MS = 60 * 60 * 1000; // 버전 탭을 열 때 1시간에 한 번만 자동 확인 (크롬이 잦은 확인을 막는다)

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function renderChangelog() {
  const list = $('changelog');
  list.textContent = '';
  for (const entry of CHANGELOG) {
    const li = document.createElement('li');
    if (entry.v === CUR_VERSION) li.className = 'is-current';
    const head = document.createElement('div');
    head.className = 'changelog__head';
    const strong = document.createElement('strong');
    strong.textContent = `v${entry.v}`;
    const time = document.createElement('time');
    time.textContent = entry.date;
    head.append(strong, time);
    const ul = document.createElement('ul');
    for (const text of entry.items) {
      const item = document.createElement('li');
      item.textContent = text;
      ul.append(item);
    }
    li.append(head, ul);
    list.append(li);
  }
}

function showLatest(latest) {
  const dd = $('latestVersion');
  if (!latest) {
    dd.textContent = '확인 전';
    dd.classList.remove('is-new');
    return;
  }
  const newer = cmpVersion(latest, CUR_VERSION) > 0;
  dd.textContent = `v${latest}`;
  dd.classList.toggle('is-new', newer);
}

function setUpdateMsg(text) {
  $('updateMsg').textContent = text;
}

async function checkUpdate() {
  const btn = $('checkUpdateBtn');
  if (!FROM_STORE) {
    showLatest(null);
    $('latestVersion').textContent = '-';
    setUpdateMsg('개발자 모드(압축해제)로 설치되어 있어 웹 스토어 업데이트 대상이 아닙니다.');
    btn.disabled = true;
    return;
  }

  btn.disabled = true;
  setUpdateMsg('웹 스토어에서 확인하는 중…');
  let result;
  try {
    result = await chrome.runtime.requestUpdateCheck();
  } catch (e) {
    setUpdateMsg('업데이트를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    btn.disabled = false;
    return;
  }
  btn.disabled = false;

  const status = result && result.status;
  if (status === 'update_available') {
    const latest = result.version || '';
    showLatest(latest);
    await chrome.storage.local.set({ updateInfo: { latest, checkedAt: Date.now() } });
    setUpdateMsg('새 버전을 내려받는 중입니다. 잠시 후 [지금 업데이트] 버튼이 나타납니다.');
  } else if (status === 'no_update') {
    showLatest(CUR_VERSION);
    await chrome.storage.local.set({ updateInfo: { latest: CUR_VERSION, checkedAt: Date.now() } });
    setUpdateMsg('최신 버전을 사용 중입니다.');
  } else if (status === 'throttled') {
    setUpdateMsg('짧은 시간에 너무 자주 확인했습니다. 몇 분 뒤에 다시 눌러 주세요.');
  } else {
    setUpdateMsg('업데이트 상태를 알 수 없습니다.');
  }
}

// 새 버전 다운로드가 끝나면 알려준다. (팝업을 닫아도 크롬이 쉬는 시간에 알아서 적용한다)
chrome.runtime.onUpdateAvailable.addListener((details) => {
  showLatest(details.version);
  setUpdateMsg(`v${details.version} 준비 완료. [지금 업데이트]를 누르면 바로 적용됩니다.`);
  $('applyUpdateBtn').hidden = false;
});

$('applyUpdateBtn').addEventListener('click', () => {
  chrome.runtime.reload(); // 확장을 다시 시작하면서 새 버전이 적용된다 (팝업은 닫힌다)
});

$('checkUpdateBtn').addEventListener('click', checkUpdate);

async function initVersionTab() {
  $('curVersion').textContent = `v${CUR_VERSION}`;
  renderChangelog();
  if (!FROM_STORE) {
    $('latestVersion').textContent = '-';
    setUpdateMsg('개발자 모드(압축해제)로 설치되어 있어 웹 스토어 업데이트 대상이 아닙니다.');
    $('checkUpdateBtn').disabled = true;
    return;
  }
  const { updateInfo } = await chrome.storage.local.get('updateInfo');
  // 저장된 "최신"이 지금 버전보다 낮으면(이미 업데이트됨) 현재 버전으로 본다
  if (updateInfo && updateInfo.latest) {
    showLatest(cmpVersion(updateInfo.latest, CUR_VERSION) > 0 ? updateInfo.latest : CUR_VERSION);
  }
}

let versionTabOpened = false;
document.querySelector('.tabs__btn[data-tab="version"]').addEventListener('click', async () => {
  if (versionTabOpened || !FROM_STORE) return;
  versionTabOpened = true;
  const { updateInfo } = await chrome.storage.local.get('updateInfo');
  if (!updateInfo || Date.now() - updateInfo.checkedAt > AUTO_CHECK_MS) await checkUpdate();
});

initVersionTab();

$('toggleLogBtn').addEventListener('click', () => {
  const box = $('logBox');
  box.hidden = !box.hidden;
  $('toggleLogBtn').textContent = box.hidden ? '로그 보기' : '로그 닫기';
});

$('clearLogBtn').addEventListener('click', async () => {
  await send({ type: 'clearLogs' });
  renderLogs([]);
});

$('resetBtn').addEventListener('click', async () => {
  await send({ type: 'reset' });
  await refresh();
});

refresh();
