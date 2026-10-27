'use strict';

const DEFAULTS = {
  enabled: true,
  kakaoEmail: '', // 설치 직후에는 비어 있다. 사용자가 설정 탭에서 직접 입력한다.
  stepTimeoutMs: 8000,
  maxAttempts: 3,
};
const TRADE_URL = 'https://poe.kakaogames.com/trade2';
const GAME_URL = 'https://pathofexile2.kakaogames.com/main';

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

['enabled', 'kakaoEmail', 'stepTimeoutMs', 'maxAttempts'].forEach((id) => {
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
