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

      // 1. 댓글 API 감지
      if (url.includes("/comments") && url.includes("nng_comment_api")) {
        try {
          const data = JSON.parse(this.responseText);
          window.postMessage({ type: "CHZZK_XHR_DATA", payload: data }, "*");
        } catch (e) {
          // JSON 파싱 실패는 조용히 무시
        }
      }

      // 2. 프로필 카드 API 감지
      if (url.includes("/profile-card") && url.includes("chatType=STREAMING")) {
        try {
          const data = JSON.parse(this.responseText);
          if (data.code === 200 && data.content) {
            window.postMessage(
              {
                type: "CHZZK_PROFILE_DATA",
                payload: data.content,
              },
              "*"
            );
          }
        } catch (e) {}
      }
    });
    return originalSend.apply(this, arguments);
  };

  // 차단된 유저 UID 목록 (content.js와 동기화)
  let blockedChatUsers = new Set();

  // content.js에서 차단 목록 업데이트 수신
  window.addEventListener("message", (event) => {
    if (event.data.type === "CHZZK_UPDATE_CHAT_BLOCK_LIST") {
      blockedChatUsers = new Set(event.data.payload);
    }
  });

  // JSON.parse 후킹: 데이터가 렌더링 되기 전에 가로채서 필터링
  const originalJSONParse = JSON.parse;
  JSON.parse = function (text, reviver) {
    const data = originalJSONParse(text, reviver);

    try {
      if (data && typeof data === "object") {
        // 1. 실시간 채팅 (CMD 93101)
        if (data.cmd === 93101 && Array.isArray(data.bdy)) {
          // 차단된 유저의 메시지는 배열에서 제외(filter)
          data.bdy = data.bdy.filter((msg) => !blockedChatUsers.has(msg.uid));
        }
        // 2. 과거 채팅 내역 (CMD 15101)
        else if (
          data.cmd === 15101 &&
          data.bdy &&
          Array.isArray(data.bdy.messageList)
        ) {
          data.bdy.messageList = data.bdy.messageList.filter((msg) => {
            // userId 혹은 profile 문자열 내부의 userIdHash 확인
            const uid =
              msg.userId ||
              (msg.profile ? originalJSONParse(msg.profile).userIdHash : null);
            return !blockedChatUsers.has(uid);
          });
        }
      }
    } catch (e) {
      // 파싱 중 에러 발생 시 무시하고 원본 데이터 반환
    }

    return data;
  };

  // 3. 클립 메타데이터 API 감지
  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    // 원본 요청 수행
    const response = await originalFetch(...args);

    // 응답 복제 전에 URL부터 확인
    if (
      response.url &&
      response.url.includes("/shortformhub") &&
      response.url.includes("/card") &&
      response.url.includes("seedType=SPECIFIC")
    ) {
      // 타겟 API인 경우에만 복제(clone) 수행
      // clone()을 해야 원본 사이트의 동작(body 읽기)을 방해하지 않고 읽을 수 있음
      try {
        const clone = response.clone();
        clone
          .json()
          .then((data) => {
            try {
              if (data && data.card) {
                const payload = {
                  streamerName:
                    data.card.interaction?.subscription?.name || "알 수 없음",
                  title: data.card.content?.title || "제목 없음",
                  clipId: data.card.content?.contentId || "",
                };

                // content.js로 데이터 전송
                window.postMessage(
                  { type: "CHZZK_CLIP_METADATA", payload: payload },
                  "*"
                );
              }
            } catch (e) {
              // 내부 처리 에러도 무시
            }
          })
          .catch(() => {
            // JSON 파싱 실패도 완전히 무시
          });
      } catch (e) {
        // clone 실패 시에도 무시
      }
    }

    // 원본 응답은 건드리지 않고 즉시 반환
    return response;
  };
})();
