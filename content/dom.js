/* 공용 DOM 헬퍼. autologin.js 보다 먼저 주입된다.
   클래스명은 사이트 리뉴얼 때마다 바뀌므로 "눈에 보이는 텍스트" 기준으로 찾는다. */
(() => {
  'use strict';

  const CLICKABLE =
    'a, button, [role="button"], input[type="submit"], input[type="button"]';

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  }

  function labelOf(el) {
    return norm(el.innerText || el.textContent || el.value || el.getAttribute('aria-label'));
  }

  /** 조건이 참(truthy)을 반환할 때까지 기다린다. DOM 변경 감시 + 폴링 + 타임아웃. */
  function waitFor(fn, { timeout = 8000, interval = 200 } = {}) {
    return new Promise((resolve) => {
      let finished = false;
      const observer = new MutationObserver(tick);
      const timer = setInterval(tick, interval);
      const deadline = setTimeout(() => finish(null), timeout);

      function cleanup() {
        observer.disconnect();
        clearInterval(timer);
        clearTimeout(deadline);
      }
      function finish(value) {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(value || null);
      }
      function tick() {
        if (finished) return;
        let value = null;
        try {
          value = fn();
        } catch (_) {
          /* 렌더링 중 예외는 무시하고 다음 tick 에 재시도 */
        }
        if (value) finish(value);
      }

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      tick();
    });
  }

  /** 보이는 클릭 요소 중 라벨이 texts 중 하나와 일치하는 첫 요소. */
  function findClickableByText(texts, { exact = false, root = document } = {}) {
    const wanted = texts.map(norm);
    for (const el of root.querySelectorAll(CLICKABLE)) {
      if (!isVisible(el)) continue;
      const label = labelOf(el);
      if (!label) continue;
      if (wanted.some((w) => (exact ? label === w : label.includes(w)))) return el;
    }
    return null;
  }

  /** 라벨에 texts 가 "모두" 들어있는 클릭 요소 (예: 카카오 + 로그인). */
  function findClickableByAllText(texts, { root = document } = {}) {
    const wanted = texts.map(norm);
    for (const el of root.querySelectorAll(CLICKABLE)) {
      if (!isVisible(el)) continue;
      const label = labelOf(el);
      if (label && wanted.every((w) => label.includes(w))) return el;
    }
    return null;
  }

  /** 특정 문자열(예: 이메일)이 적힌 행 자체를 클릭 대상으로 찾는다.
   *  텍스트 노드 -> 가장 가까운 클릭 가능 조상 -> 없으면 cursor:pointer 조상 -> 없으면 li/행 컨테이너. */
  function findRowByText(text) {
    const needle = norm(text).toLowerCase();
    if (!needle) return null;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!norm(node.nodeValue).toLowerCase().includes(needle)) continue;

      let el = node.parentElement;
      // 1) 가장 가까운 클릭 가능 조상 (삭제 버튼 류는 제외)
      const clickable = el && el.closest(CLICKABLE);
      if (clickable && isVisible(clickable) && !isDismissControl(clickable)) return clickable;

      // 2) cursor: pointer 인 조상 (div 에 click 핸들러가 달린 경우)
      let cur = el;
      for (let depth = 0; cur && depth < 6; depth += 1, cur = cur.parentElement) {
        if (!isVisible(cur)) continue;
        if (getComputedStyle(cur).cursor === 'pointer' && !isDismissControl(cur)) return cur;
      }

      // 3) 최후 수단: li 나 한 단계 위 컨테이너
      const li = el && el.closest('li');
      if (li && isVisible(li)) return li;
      if (el && el.parentElement && isVisible(el.parentElement)) return el.parentElement;
    }
    return null;
  }

  /** 계정 삭제(x) 같은 "지우기" 컨트롤인지 판별 -> 절대 클릭하면 안 되는 요소. */
  function isDismissControl(el) {
    const hint = [
      el.className && String(el.className),
      el.getAttribute && (el.getAttribute('aria-label') || ''),
      el.getAttribute && (el.getAttribute('title') || ''),
    ].join(' ').toLowerCase();
    return /close|delete|remove|del_|btn_del|삭제|닫기/.test(hint);
  }

  /** 요소 클릭. 요소 단위 click() 이므로 내부의 다른 버튼(x)에는 전달되지 않는다. */
  function clickElement(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ block: 'center' });
    } catch (_) {
      /* 무시 */
    }
    el.click();
    return true;
  }

  window.__kalDom = {
    norm,
    isVisible,
    labelOf,
    waitFor,
    findClickableByText,
    findClickableByAllText,
    findRowByText,
    clickElement,
  };
})();
