(function () {
  const XHR = XMLHttpRequest.prototype;
  const originalOpen = XHR.open;
  const originalSend = XHR.send;

  // 페이지 이동 감지 (SPA 대응)
  // pushState, replaceState, popstate 이벤트를 훅하여 URL 변경 시 알림을 보냄
  const pushState = history.pushState;
  const replaceState = history.replaceState;

  function notifyUrlChange() {
    window.postMessage({ type: "CHZZK_URL_CHANGED" }, "*");
  }

  history.pushState = function () {
    pushState.apply(history, arguments);
    notifyUrlChange();
  };

  history.replaceState = function () {
    replaceState.apply(history, arguments);
    notifyUrlChange();
  };

  window.addEventListener("popstate", notifyUrlChange);

  // URL 저장을 위한 open 후킹
  XHR.open = function (method, url) {
    this._url = url;
    return originalOpen.apply(this, arguments);
  };

  // 데이터 로드 완료 감지를 위한 send 후킹
  XHR.send = function (body) {
    this.addEventListener("load", function () {
      const url = this._url ? this._url.toString() : "";

      // 댓글 API 감지
      if (url.includes("/comments") && url.includes("nng_comment_api")) {
        try {
          const data = JSON.parse(this.responseText);
          window.postMessage({ type: "CHZZK_XHR_DATA", payload: data }, "*");
        } catch (e) {
          // JSON 파싱 실패는 조용히 무시
        }
      }
    });
    return originalSend.apply(this, arguments);
  };
})();
