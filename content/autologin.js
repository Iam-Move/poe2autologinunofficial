/* 카카오게임즈 / 카카오 로그인 단계별 자동 진행.
   한 페이지에서 "한 단계"만 수행하고, 페이지가 이동하면 다음 단계가 스스로 실행된다. */
(async () => {
  'use strict';

  const TAG = '[KakaoAutoLogin]';
  const D = window.__kalDom;
  const log = (...args) => console.log(TAG, ...args);

  const DEFAULTS = {
    enabled: true,
    kakaoEmail: '', // 설치 직후에는 비어 있다. 사용자가 팝업 설정에서 직접 입력한다.
    stepTimeoutMs: 8000,
    maxAttempts: 3,
  };

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          void chrome.runtime.lastError; // 서비스 워커가 잠들어 있을 때의 경고 무시
          resolve(response || {});
        });
      } catch (_) {
        resolve({});
      }
    });
  }

  const cfg = await chrome.storage.sync.get(DEFAULTS);
  if (!cfg.enabled) {
    log('설정에서 비활성화됨');
    return;
  }

  // Cloudflare 봇 검사 화면에서는 아무것도 하지 않는다.
  // (체크박스는 사람이 직접 눌러야 하며, 통과하면 페이지가 다시 로드되어 자동으로 이어진다)
  if (isBotCheckPage()) {
    log('보안 확인(Cloudflare) 페이지 - 개입하지 않고 대기합니다. 체크박스는 직접 눌러 주세요.');
    return;
  }

  const host = location.hostname;
  const isKakaogames = host === 'kakaogames.com' || host.endsWith('.kakaogames.com');
  const POE2_HOST = 'pathofexile2.kakaogames.com';

  // 계정이 설정되지 않았으면 클릭을 시작하지 않는다.
  // (계정 선택 화면에서 멈춰 버리므로, 아예 시작하지 않고 설정을 안내한다)
  if (!cfg.kakaoEmail) {
    log('카카오 계정이 설정되지 않았습니다. 확장 아이콘 > 설정 탭에서 이메일을 입력해 주세요.');
    if (isKakaogames) await send({ type: 'needsSetup' });
    return;
  }

  if (isKakaogames) {
    await handleKakaogames();
  } else if (host === 'accounts.kakao.com' || host === 'kauth.kakao.com') {
    await handleKakaoAccounts();
  }

  /** Cloudflare "보안 확인 수행 중" 같은 봇 검사 화면인지 판별. */
  function isBotCheckPage() {
    if (
      document.querySelector(
        '#challenge-form, #challenge-running, #cf-challenge-running, iframe[src*="challenges.cloudflare.com"]'
      )
    ) {
      return true;
    }
    return /just a moment|보안 확인|잠시만 기다/i.test(D.norm(document.title));
  }

  /* ---------- 1~2단계 + 성공 판정: *.kakaogames.com ---------- */

  async function handleKakaogames() {
    if (host === POE2_HOST) await dismissIntroModal();

    const hit = await D.waitFor(() => {
      // 로그인 완료 상태: 글로벌바에 로그아웃 버튼이 있다
      if (D.findClickableByText(['로그아웃'], { exact: true })) return { kind: 'loggedIn' };
      // 2단계: 카카오 로그인 버튼 (member.kakaogames.com 로그인 화면)
      const kakao =
        D.findClickableByAllText(['카카오', '로그인']) ||
        D.findClickableByAllText(['Kakao', 'Log in']) ||
        kakaoRowFallback();
      if (kakao) return { kind: 'kakaoLogin', el: kakao };
      // 1단계: 우측 상단 로그인 버튼 (또는 에러 페이지의 로그인 링크)
      const login =
        D.findClickableByText(['로그인'], { exact: true }) ||
        D.findClickableByText(['Login', 'Log in'], { exact: true });
      if (login) return { kind: 'login', el: login };
      return null;
    }, { timeout: cfg.stepTimeoutMs });

    if (!hit) {
      log('인식할 수 있는 로그인 요소가 없음:', location.pathname);
      return;
    }

    if (hit.kind === 'loggedIn') {
      await onLoggedIn();
      await maybeStartGame();
      return;
    }

    const res = await send({
      type: 'step',
      name: hit.kind,
      target: hit.kind === 'login' ? resolveTarget() : null,
      url: location.href,
    });
    if (res.allowed === false) {
      log('자동 진행 중단:', res.reason);
      return;
    }

    log(hit.kind === 'login' ? '1단계: 로그인 버튼 클릭' : '2단계: 카카오 로그인 버튼 클릭');
    const urlBeforeClick = location.href;
    D.clickElement(hit.el);

    // 클릭이 먹지 않은 경우(핸들러 없음 등) 1단계는 URL 로 우회한다.
    if (hit.kind === 'login') {
      setTimeout(() => {
        if (location.href !== urlBeforeClick) return; // 이미 이동했으면 아무것도 안 함
        if (/^\/login/.test(location.pathname)) return;
        log('클릭 후 이동이 없어 /login 으로 직접 이동');
        location.href = `${location.origin}/login`;
      }, 2500);
    }
  }

  /** 카카오 로그인 버튼이 a/button 이 아니라 div 로 그려진 경우의 폴백.
   *  엉뚱한 큰 컨테이너를 누르지 않도록 짧은 라벨일 때만 사용한다. */
  function kakaoRowFallback() {
    const row = D.findRowByText('카카오 로그인');
    if (!row) return null;
    return D.labelOf(row).length <= 30 ? row : null;
  }

  /** 로그인 후 돌아갈 원래 목적지. 로그인/에러 페이지 자체는 목적지로 삼지 않는다. */
  function resolveTarget() {
    const url = new URL(location.href);
    const redir = url.searchParams.get('redir') || url.searchParams.get('returnUrl');
    if (redir) {
      try {
        return new URL(redir, location.origin).href;
      } catch (_) {
        /* 무시 */
      }
    }
    if (/^\/login/.test(url.pathname)) return null;
    return location.href;
  }

  async function onLoggedIn() {
    const res = await send({ type: 'success', url: location.href });
    const target = res && res.target;
    if (!target) return;

    const here = location.origin + location.pathname + location.search;
    let dest;
    try {
      const t = new URL(target);
      dest = t.origin + t.pathname + t.search;
    } catch (_) {
      return;
    }
    if (dest === here) return;
    if (sessionStorage.getItem('kal_restored') === dest) return; // 왕복 루프 방지

    sessionStorage.setItem('kal_restored', dest);
    log('로그인 완료. 원래 목적지로 이동:', dest);
    location.replace(target);
  }

  /* ---------- POE2 메인: 인트로 팝업 닫기 + 게임 시작 ---------- */

  /** 인트로 팝업이 뜨면 [오늘 하루 그만 보기]를 누른다. 팝업이 없으면 잠깐 기다렸다 넘어간다. */
  async function dismissIntroModal() {
    const btn = await D.waitFor(() => {
      const modal = document.querySelector('.modal--intro');
      if (!modal || !D.isVisible(modal)) return null;
      const direct = modal.querySelector('.modal__button-block');
      if (direct && D.isVisible(direct)) return direct;
      for (const el of modal.querySelectorAll('button, a')) {
        const compact = D.labelOf(el).replace(/\s/g, '');
        if (compact.includes('오늘하루그만보기') && D.isVisible(el)) return el;
      }
      return null;
    }, { timeout: 2000 });

    if (!btn) return;
    log('인트로 팝업: 오늘 하루 그만 보기 클릭');
    D.clickElement(btn);
  }

  /** 팝업의 [게임 시작]으로 들어온 경우에만 메인의 게임 시작 버튼을 누른다. */
  async function maybeStartGame() {
    if (host !== POE2_HOST) return;
    if (!/^\/(main\/?)?$/.test(location.pathname)) return;

    const res = await send({ type: 'consumeLaunch' });
    if (!res.launch) return;

    const btn = await D.waitFor(() => {
      const link = document.querySelector('a.main-start__link');
      if (link && D.isVisible(link)) return link;
      return D.findClickableByText(['게임 시작', '게임시작'], { exact: true });
    }, { timeout: cfg.stepTimeoutMs });

    if (!btn) {
      log('게임 시작 버튼을 찾지 못함');
      return;
    }
    log('게임 시작 버튼 클릭');
    suppressJsHref(btn);
    D.clickElement(btn);
    await send({ type: 'gameStarted' });
  }

  /** javascript: 링크는 페이지 핸들러만 실행시키고, 기본 이동(확장 CSP 에 막혀 오류가 남)은 막는다.
   *  window 의 bubble 단계라 페이지 핸들러가 모두 끝난 뒤에 실행된다. */
  function suppressJsHref(el) {
    if (!/^\s*javascript:/i.test(el.getAttribute('href') || '')) return;
    window.addEventListener('click', (e) => {
      if (e.target === el || el.contains(e.target)) e.preventDefault();
    }, { once: true });
  }

  /* ---------- 3단계: accounts.kakao.com 계정 선택 ---------- */

  async function handleKakaoAccounts() {
    // 안전장치: 우리가 시작한 플로우이거나, URL 이 kakaogames 로 돌아가는 로그인일 때만 개입.
    const gate = await send({ type: 'isActive' });
    if (!gate.active && !urlMentionsKakaogames()) {
      log('카카오게임즈 로그인 플로우가 아니므로 개입하지 않음');
      return;
    }

    const hit = await D.waitFor(() => {
      const row = D.findRowByText(cfg.kakaoEmail);
      if (row) return { kind: 'account', el: row };
      const cont = D.findClickableByText(
        ['동의하고 계속하기', '계속하기', '전체 동의하기'],
        { exact: true }
      );
      if (cont) return { kind: 'continue', el: cont };
      return null;
    }, { timeout: cfg.stepTimeoutMs });

    if (!hit) {
      await reportKakaoFailure();
      return;
    }

    const res = await send({ type: 'step', name: hit.kind, url: location.href });
    if (res.allowed === false) {
      log('자동 진행 중단:', res.reason);
      return;
    }

    log(hit.kind === 'account' ? `3단계: ${cfg.kakaoEmail} 계정 클릭` : '동의/계속 버튼 클릭');
    D.clickElement(hit.el);
  }

  async function reportKakaoFailure() {
    const text = D.norm(document.body ? document.body.innerText : '');
    if (document.querySelector('input[type="password"]')) {
      await send({
        type: 'fail',
        reason: '저장된 간편로그인 정보가 없어 카카오 계정 입력이 필요합니다.',
      });
      return;
    }
    if (text.includes('카카오계정 선택') || text.includes('카카오계정으로 로그인')) {
      await send({
        type: 'fail',
        reason: `설정한 계정(${cfg.kakaoEmail})을 계정 목록에서 찾지 못했습니다.`,
      });
      return;
    }
    log('카카오 페이지지만 처리 대상 화면이 아님:', location.pathname);
  }

  /** URL(중첩 인코딩 포함)에 kakaogames 가 들어있는지 확인. */
  function urlMentionsKakaogames() {
    let s = location.href;
    for (let i = 0; i < 3; i += 1) {
      try {
        const decoded = decodeURIComponent(s);
        if (decoded === s) break;
        s = decoded;
      } catch (_) {
        break;
      }
    }
    return /kakaogames/i.test(s);
  }
})();
