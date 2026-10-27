/* 플로우 상태(시도 횟수/목적지)를 세션 단위로 관리하고,
   팝업에 보여줄 실행 기록(마지막 결과 + 로그)을 남기며, 실패 시 배지 + 알림을 띄운다. */

'use strict';

const DEFAULTS = {
  enabled: true,
  kakaoEmail: '', // 설치 직후에는 비어 있다. 사용자가 팝업 설정에서 직접 입력한다.
  stepTimeoutMs: 8000,
  maxAttempts: 3,
  historyEnabled: true, // 웹 거래소에 History 버튼 표시
  saleBadgeEnabled: false, // 주기적으로 판매 내역을 확인해 새 판매 개수를 배지에 표시
};
const FLOW_TTL_MS = 120000; // 이 시간이 지나면 새 플로우로 간주
const LAUNCH_TTL_MS = 180000; // 게임 시작 요청 유효 시간 (로그인 왕복 포함)
const NOTIFICATION_ID = 'kal-manual-login';
const SETUP_NOTIFICATION_ID = 'kal-needs-setup';
const MAX_LOGS = 30;

const STEP_LABELS = {
  login: '1단계 · 로그인 버튼 클릭',
  kakaoLogin: '2단계 · 카카오 로그인 버튼 클릭',
  account: '3단계 · 카카오 계정 선택',
  continue: '동의/계속 버튼 클릭',
};

/* ---------- 팝업 허용 ---------- */

// 자동 클릭은 사용자 클릭이 아니라서 사이트가 여는 게임 실행 창이 팝업 차단에 걸린다.
// POE2 사이트 한 곳에만 "팝업 및 리디렉션 허용"을 걸어 둔다.
const POE2_POPUP_PATTERN = 'https://pathofexile2.kakaogames.com/*';

async function allowPoe2Popups() {
  try {
    await chrome.contentSettings.popups.set({
      primaryPattern: POE2_POPUP_PATTERN,
      setting: 'allow',
    });
  } catch (err) {
    console.warn('[KakaoAutoLogin] 팝업 허용 설정 실패', err);
  }
}

chrome.runtime.onInstalled.addListener(allowPoe2Popups);
chrome.runtime.onStartup.addListener(allowPoe2Popups);

/* ---------- 상태 저장소 ---------- */

async function getFlow() {
  const { flow } = await chrome.storage.session.get({ flow: null });
  return flow;
}

async function setFlow(flow) {
  await chrome.storage.session.set({ flow });
}

function newFlow(now) {
  return { startedAt: now, total: 0, counts: {}, target: null, aborted: false };
}

async function addLog(level, text) {
  const { logs } = await chrome.storage.local.get({ logs: [] });
  logs.push({ at: Date.now(), level, text });
  await chrome.storage.local.set({ logs: logs.slice(-MAX_LOGS) });
}

async function setLastResult(result) {
  await chrome.storage.local.set({ lastResult: { at: Date.now(), ...result } });
}

/* ---------- 배지 / 알림 ---------- */

/** 배지 문구 지정. 빈 문자열이면 배지를 지운다. */
async function setBadge(text, color = '#d93025') {
  // 로그인 상태 배지(! / ?)가 없을 때는 새 판매 개수를 보여준다
  if (!text) {
    const { sales } = await chrome.storage.local.get({ sales: null });
    if (sales && sales.count > 0) {
      text = sales.count > 99 ? '99+' : String(sales.count);
      color = SALE_BADGE_COLOR;
    }
  }
  await chrome.action.setBadgeText({ text });
  if (text) await chrome.action.setBadgeBackgroundColor({ color });
}

/** 판매 개수만 바뀌었을 때: ! / ? 가 떠 있으면 그대로 두고, 아니면 숫자를 갱신한다. */
async function refreshSaleBadge() {
  const badge = await chrome.action.getBadgeText({});
  if (badge === '!' || badge === '?') return;
  await setBadge('');
}

async function notify(id, title, message) {
  try {
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
      priority: 2,
    });
  } catch (err) {
    console.warn('[KakaoAutoLogin] 알림 실패', err);
  }
}

async function notifyFailure(reason) {
  await setBadge('!');
  await notify(NOTIFICATION_ID, 'POE 자동 로그인 실패', `${reason}\n수동으로 로그인해 주세요.`);
}

async function abortFlow(flow, reason) {
  const aborted = { ...(flow || newFlow(Date.now())), aborted: true };
  await setFlow(aborted);
  console.warn('[KakaoAutoLogin] 중단:', reason);
  await addLog('error', reason);
  await setLastResult({ status: 'fail', reason, steps: aborted.total });
  await notifyFailure(reason);
}

/** 중단 상태 해제: 배지 · 알림 · 플로우 초기화 */
async function resetFlow({ log = true } = {}) {
  await chrome.storage.session.remove('flow');
  await setBadge('');
  try {
    await chrome.notifications.clear(NOTIFICATION_ID);
  } catch (_) {
    /* 무시 */
  }
  if (log) await addLog('info', '중단 상태를 초기화했습니다. 다시 시도할 수 있습니다.');
}

/* ---------- 새 판매 배지 ---------- */

// 거래소 API 는 요청 한도가 빡빡하다 -> 30분에 1회만 확인한다.
const SALE_ALARM = 'kal-sale-check';
const SALE_PERIOD_MIN = 30;
const SALE_BADGE_COLOR = '#188038';
const HISTORY_API = 'https://poe.kakaogames.com/api/trade2/history/';
const DEFAULT_RETRY_SEC = 60;

/** { league, seenTime(ms), count, blockedUntil(ms) } */
async function getSales() {
  const { sales } = await chrome.storage.local.get({ sales: null });
  return { league: null, seenTime: 0, count: 0, blockedUntil: 0, ...(sales || {}) };
}

async function setSales(sales) {
  await chrome.storage.local.set({ sales });
}

/** 배지 알림 설정에 맞춰 알람을 켜거나 끈다. */
async function syncSaleAlarm() {
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  if (cfg.historyEnabled && cfg.saleBadgeEnabled) {
    const alarm = await chrome.alarms.get(SALE_ALARM);
    if (!alarm) await chrome.alarms.create(SALE_ALARM, { periodInMinutes: SALE_PERIOD_MIN });
    return;
  }
  await chrome.alarms.clear(SALE_ALARM);
  const sales = await getSales();
  if (sales.count) {
    await setSales({ ...sales, count: 0 });
    await refreshSaleBadge();
  }
}

/** content/history.js 의 throttleFromHeaders 와 같은 규칙: 남은 횟수가 1번 이하면 그 구간만큼 쉰다. */
function rateLimitWaitSec(headers) {
  const rules = (headers.get('X-Rate-Limit-Rules') || '').split(',').map((s) => s.trim());
  let waitSec = 0;
  for (const rule of rules.filter(Boolean)) {
    const limits = (headers.get(`X-Rate-Limit-${rule}`) || '').split(',');
    const states = (headers.get(`X-Rate-Limit-${rule}-State`) || '').split(',');
    limits.forEach((limit, i) => {
      const [max, period] = limit.split(':').map(Number);
      const [hits] = (states[i] || '').split(':').map(Number);
      if (!max || !period || !Number.isFinite(hits)) return;
      if (hits >= max - 1) waitSec = Math.max(waitSec, period);
    });
  }
  return waitSec;
}

async function checkSales() {
  const sales = await getSales();
  // 거래소에서 History 를 한 번도 열지 않았으면 어느 리그를 볼지 모른다
  if (!sales.league || Date.now() < sales.blockedUntil) return;

  let res;
  try {
    res = await fetch(HISTORY_API + encodeURIComponent(sales.league), { credentials: 'include' });
  } catch (err) {
    console.warn('[KakaoAutoLogin] 판매 내역 확인 실패', err);
    return;
  }
  if (res.status === 429) {
    const sec = parseInt(res.headers.get('Retry-After'), 10) || DEFAULT_RETRY_SEC;
    await setSales({ ...sales, blockedUntil: Date.now() + sec * 1000 });
    console.warn(`[KakaoAutoLogin] 판매 내역 요청 제한(429) - ${sec}초 대기`);
    return;
  }
  if (!res.ok) {
    // 401/403 은 로그아웃 상태 -> 조용히 다음 확인을 기다린다
    console.log('[KakaoAutoLogin] 판매 내역 확인 건너뜀: HTTP', res.status);
    return;
  }

  const waitSec = rateLimitWaitSec(res.headers);
  let rows;
  try {
    rows = (await res.json()).result || [];
  } catch (err) {
    console.warn('[KakaoAutoLogin] 판매 내역 응답을 읽지 못함', err);
    return;
  }
  // 누적하지 않고 매번 다시 센다 (최근 100건 안에서 계산하므로 중복이 없다)
  const count = rows.filter((r) => Date.parse(r.time) > sales.seenTime).length;
  await setSales({
    ...sales,
    count,
    blockedUntil: waitSec ? Date.now() + waitSec * 1000 : 0,
  });
  await refreshSaleBadge();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SALE_ALARM) checkSales();
});

chrome.runtime.onInstalled.addListener(syncSaleAlarm);
chrome.runtime.onStartup.addListener(syncSaleAlarm);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.historyEnabled || changes.saleBadgeEnabled)) syncSaleAlarm();
});

/* ---------- 메시지 처리 ---------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true; // 비동기 응답
});

async function handleMessage(message, sender) {
  const now = Date.now();
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  let flow = await getFlow();

  // 오래된 플로우는 폐기하고 새로 시작 (중단 상태도 함께 해제)
  if (flow && now - flow.startedAt > FLOW_TTL_MS) flow = null;

  switch (message.type) {
    case 'isActive':
      return { active: !!(flow && !flow.aborted), target: flow ? flow.target : null };

    case 'step': {
      if (flow && flow.aborted) return { allowed: false, reason: 'aborted' };
      if (!flow) flow = newFlow(now);

      flow.total += 1;
      flow.counts[message.name] = (flow.counts[message.name] || 0) + 1;
      if (message.target) flow.target = message.target;

      const tooManyOfOne = flow.counts[message.name] > cfg.maxAttempts;
      const tooManyTotal = flow.total > cfg.maxAttempts * 4;
      if (tooManyOfOne || tooManyTotal) {
        await abortFlow(flow, '자동 로그인 단계가 반복해서 실패했습니다.');
        return { allowed: false, reason: 'maxAttempts' };
      }

      await setFlow(flow);
      await setBadge('');
      const label = STEP_LABELS[message.name] || message.name;
      console.log('[KakaoAutoLogin] 단계:', label);
      await addLog('step', label);
      await setLastResult({ status: 'running', step: label, steps: flow.total });
      return { allowed: true, target: flow.target };
    }

    case 'fail':
      await abortFlow(flow, message.reason || '자동 로그인에 실패했습니다.');
      return { allowed: false, reason: 'failed' };

    /** 카카오 계정이 아직 설정되지 않음 — 세션당 한 번만 알린다. */
    case 'needsSetup': {
      await setBadge('?', '#b26a00');
      await setLastResult({ status: 'setup' });
      const { setupNotified } = await chrome.storage.session.get({ setupNotified: false });
      if (!setupNotified) {
        await chrome.storage.session.set({ setupNotified: true });
        await addLog('error', '카카오 계정이 설정되지 않아 자동 로그인을 시작하지 않았습니다.');
        await notify(
          SETUP_NOTIFICATION_ID,
          'POE 자동 로그인 · 설정 필요',
          '확장 아이콘을 눌러 [설정] 탭에서 카카오 계정 이메일을 입력해 주세요.'
        );
      }
      return { allowed: false, reason: 'needsSetup' };
    }

    case 'success': {
      const target = flow && !flow.aborted ? flow.target : null;
      const steps = flow ? flow.total : 0;
      await resetFlow({ log: false });
      if (steps > 0) {
        console.log('[KakaoAutoLogin] 로그인 완료. 복귀 목적지:', target);
        await addLog('success', `로그인 완료 (${steps}단계)`);
        await setLastResult({ status: 'success', steps });
      }
      return { target };
    }

    /* ---- 게임 시작 ---- */

    /** 팝업의 [게임 시작] — 메인 페이지에서 한 번만 게임 시작 버튼을 누르도록 표시해 둔다. */
    case 'launchGame':
      await allowPoe2Popups(); // 사용자가 사이트 설정에서 되돌렸어도 다시 허용
      await chrome.storage.session.set({ launch: { at: now } });
      await addLog('info', '게임 시작 요청');
      return { ok: true };

    /** 요청이 유효하면 소비(삭제)하고 true. 평소 메인 접속 때는 false. */
    case 'consumeLaunch': {
      const { launch } = await chrome.storage.session.get({ launch: null });
      if (!launch) return { launch: false };
      await chrome.storage.session.remove('launch');
      return { launch: now - launch.at <= LAUNCH_TTL_MS };
    }

    case 'gameStarted':
      await addLog('success', '게임 시작 버튼 클릭');
      return { ok: true };

    /* ---- 거래 내역 ---- */

    /** 거래소에서 History 창을 열어 내역을 봤다 -> 그 리그를 감시하고 배지를 0으로. */
    case 'historySeen': {
      const sales = await getSales();
      const league = message.league || sales.league;
      const latest = Number(message.latest) || 0;
      await setSales({
        ...sales,
        league,
        // 같은 리그면 더 최근 시각을 유지 (캐시된 오래된 목록을 봐도 뒤로 가지 않게)
        seenTime: league === sales.league ? Math.max(sales.seenTime, latest) : latest,
        count: 0,
      });
      await refreshSaleBadge();
      await syncSaleAlarm();
      return { ok: true };
    }

    /* ---- 팝업 전용 ---- */

    case 'getState': {
      const { lastResult, logs } = await chrome.storage.local.get({
        lastResult: null,
        logs: [],
      });
      return {
        config: cfg,
        lastResult,
        logs,
        flowActive: !!(flow && !flow.aborted),
        aborted: !!(flow && flow.aborted),
        needsSetup: !cfg.kakaoEmail,
      };
    }

    case 'reset':
      await resetFlow();
      await setLastResult({ status: 'idle' });
      return { ok: true };

    /** 팝업에서 설정을 저장했을 때: 계정이 채워졌으면 '설정 필요' 상태를 푼다. */
    case 'configUpdated': {
      if (!cfg.kakaoEmail) return { ok: true, needsSetup: true };
      await chrome.storage.session.remove('setupNotified');
      try {
        await chrome.notifications.clear(SETUP_NOTIFICATION_ID);
      } catch (_) {
        /* 무시 */
      }
      const badge = await chrome.action.getBadgeText({});
      if (badge === '?') await setBadge('');
      return { ok: true, needsSetup: false };
    }

    case 'clearLogs':
      await chrome.storage.local.set({ logs: [] });
      return { ok: true };

    default:
      return {};
  }
}

chrome.notifications.onClicked.addListener(async (id) => {
  if (id !== NOTIFICATION_ID && id !== SETUP_NOTIFICATION_ID) return;
  try {
    await chrome.action.openPopup();
  } catch (_) {
    chrome.runtime.openOptionsPage();
  }
});
