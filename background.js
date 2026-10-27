/* 플로우 상태(시도 횟수/목적지)를 세션 단위로 관리하고,
   팝업에 보여줄 실행 기록(마지막 결과 + 로그)을 남기며, 실패 시 배지 + 알림을 띄운다. */

'use strict';

const DEFAULTS = {
  enabled: true,
  kakaoEmail: '', // 설치 직후에는 비어 있다. 사용자가 팝업 설정에서 직접 입력한다.
  stepTimeoutMs: 8000,
  maxAttempts: 3,
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
  await chrome.action.setBadgeText({ text });
  if (text) await chrome.action.setBadgeBackgroundColor({ color });
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
