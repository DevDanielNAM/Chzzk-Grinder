const script = document.createElement("script");
script.src = chrome.runtime.getURL("inject.js");
(document.head || document.documentElement).appendChild(script);

// 데이터 및 설정
const commentHashMap = new Map();
const STORAGE_KEY = "CHZZK_REPLY_BLOCKED_USERS";
const STORAGE_DETAILS_KEY = "CHZZK_BLOCKED_DETAILS";
const STORAGE_IMAGES_KEY = "CHZZK_BLOCKED_IMAGES";

const CHZZK_API_BASE = "https://comm-api.game.naver.com/nng_main/v1";

let domUpdateTimer = null;
let currentMenuTargetHash = null; // '더보기' 메뉴가 열린 대상 유저의 Hash 저장용
let pendingTargetId = null; // 포커싱해야 할 댓글 ID

// 토스트 메시지 표시 함수
function showToast(message, type = "info", duration = 3000) {
  // 컨테이너가 없으면 생성
  let container = document.querySelector(".chzzk-toast-container");
  if (!container) {
    container = document.createElement("div");
    container.className = "chzzk-toast-container";
    document.body.appendChild(container);
  }

  // 토스트 요소 생성
  const toast = document.createElement("div");
  toast.className = `chzzk-toast ${type}`;

  // 아이콘 설정
  let icon = "ℹ️";
  if (type === "success") icon = "✅";
  if (type === "error") icon = "⚠️";

  toast.innerHTML = `<span class="chzzk-toast-icon">${icon}</span><span>${message}</span>`;
  container.appendChild(toast);

  // 애니메이션 적용 (약간의 지연 후 클래스 추가)
  requestAnimationFrame(() => {
    toast.classList.add("show");
  });

  // 자동 삭제
  setTimeout(() => {
    toast.classList.remove("show");
    toast.addEventListener("transitionend", () => {
      toast.remove();
      // 컨테이너가 비었으면 컨테이너도 삭제
      if (container.children.length === 0) container.remove();
    });
  }, duration);
}

// 1. 전역 변수로 차단 목록 캐시 생성
let blockedUsersCache = [];
let blockedDetailsCache = {};
let blockedImagesCache = {};

let isDataLoaded = false; // 데이터가 로드되었는지 확인하는 변수

// 2. 초기화: 저장된 데이터 불러오기 (비동기)
function initBlockedUsers() {
  chrome.storage.local.get(
    [STORAGE_KEY, STORAGE_DETAILS_KEY, STORAGE_IMAGES_KEY],
    (result) => {
      blockedUsersCache = result[STORAGE_KEY] || [];
      blockedDetailsCache = result[STORAGE_DETAILS_KEY] || {};
      blockedImagesCache = result[STORAGE_IMAGES_KEY] || {};

      // 로드 완료 플래그 설정
      isDataLoaded = true;

      // 데이터 로드 후 버튼 생성
      createExportButton();

      updateExportButtonUI();

      // 데이터 로드 완료 후 화면 갱신
      startObserver();
    }
  );
}

// 3. 차단 목록 가져오기 (동기 - 캐시된 값 반환)
function getBlockedUsers() {
  return blockedUsersCache;
}

// 4. 차단 토글
function toggleBlockUser(hash, metaData = null) {
  // 데이터가 로드되지 않았다면 저장하지 않음 (덮어쓰기 방지)
  if (!isDataLoaded) {
    showToast(
      "데이터를 불러오는 중입니다. 잠시 후 다시 시도해주세요.",
      "error"
    );
    return;
  }

  const isBlocking = !blockedUsersCache.includes(hash);

  if (isBlocking) {
    // [차단 시] 목록에 추가하고 상세 정보도 저장
    blockedUsersCache.push(hash);
    if (metaData) {
      blockedDetailsCache[hash] = {
        uid: hash,
        blockDate: new Date().toLocaleString(), // 차단 일시
        createdAt: Date.now(), // 정렬용 타임스탬프
        ...metaData, // 닉네임, 방송명, 댓글 내용 등
      };
    }
    showToast("유저가 차단되었습니다.", "success");
  } else {
    // [해제 시] 목록에서 제거하고 상세 정보도 삭제
    blockedUsersCache = blockedUsersCache.filter((h) => h !== hash);
    delete blockedDetailsCache[hash];
    showToast("유저 차단이 해제되었습니다.", "info");
  }

  // A. 화면 즉시 갱신 (반응성 확보)
  scheduleUpdateDom();

  // B. 확장 프로그램 저장소에 비동기 저장
  chrome.storage.local.set({
    [STORAGE_KEY]: blockedUsersCache,
    [STORAGE_DETAILS_KEY]: blockedDetailsCache,
  });

  // C. 우측 하단 버튼 UI 갱신
  updateExportButtonUI();
}

// 데이터 및 UI 초기화 함수 (페이지 이동 시 호출)
function resetDataAndUI() {
  // 1. 수집된 해시 데이터 초기화 (새 페이지 댓글을 다시 수집하기 위함)
  commentHashMap.clear();

  // 2. 기존에 주입된 모든 확장프로그램 UI 제거
  document.querySelectorAll(".chzzk-btn-group").forEach((el) => el.remove());
  document.querySelectorAll(".chzzk-tooltip-text").forEach((el) => el.remove());

  const modal = document.querySelector(".chzzk-modal-overlay");
  if (modal) modal.remove();

  // 3. 주입 플래그 및 블러 제거
  document.querySelectorAll("[data-ui-injected]").forEach((el) => {
    delete el.dataset.uiInjected;
  });
  document.querySelectorAll(".chzzk-blur-content").forEach((el) => {
    el.classList.remove("chzzk-blur-content");
    delete el.dataset.clickEvent;
    delete el.dataset.tempUnblur;
  });

  toggleExportButtonVisibility();
}

// 텍스트를 이미지(DataURL)로 변환하는 헬퍼 함수 (PDF 한글 깨짐 방지용)
function textToImageDataURL(text, fontSize = 12, color = "#000000") {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  // 캔버스 크기 예비 계산
  ctx.font = `${fontSize}px 'Malgun Gothic', 'Noto Sans KR', sans-serif`;
  const textMetrics = ctx.measureText(text);

  canvas.width = textMetrics.width + 10; // 여유 공간
  canvas.height = fontSize * 1.5;

  // 배경 투명, 텍스트 그리기
  ctx.font = `${fontSize}px 'Malgun Gothic', 'Noto Sans KR', sans-serif`;
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(text, 0, canvas.height / 2);

  return canvas.toDataURL("image/png");
}

// 댓글 박스 캡처 함수
function captureCommentBox(commentBoxElement, commentId, buttonElement, mode) {
  // 버튼 전체가 아니라 텍스트 라벨만 찾아서 조작
  const labelEl = buttonElement.querySelector(".btn-label");

  // 만약 라벨이 없으면(예외 상황) 그냥 버튼 자체를 씀
  const targetEl = labelEl || buttonElement;

  // 1. UI 피드백 (로딩 표시)
  const originalText = targetEl.innerText;
  targetEl.innerText = "⏳ 캡처 중...";

  buttonElement.style.cursor = "wait";
  buttonElement.style.opacity = "0.7";

  // 2. 블러 제거
  const blurredElements = commentBoxElement.querySelectorAll(
    ".chzzk-blur-content"
  );
  blurredElements.forEach((el) => el.classList.remove("chzzk-blur-content"));

  // 3. 불필요한 버튼 숨기기
  const buttonsToHide = commentBoxElement.querySelectorAll(
    ".chzzk-capture-btn, .chzzk-collect-btn, .chzzk-block-btn"
  );
  buttonsToHide.forEach((btn) => (btn.style.display = "none"));

  // 대댓글 및 답글 관련 영역 숨기기
  const repliesToHide = commentBoxElement.querySelectorAll(
    'div[class*="comment_item_is_replied"]'
  );
  repliesToHide.forEach((el) => (el.style.display = "none"));

  // 잘림 방지를 위한 스타일 보정
  // 대댓글 컨테이너가 margin 때문에 밖으로 나가는 것을 막음
  // 'comment_item_is_replied'로 시작하는 클래스를 가진 요소를 찾음
  const repliedContainers = commentBoxElement.parentElement.querySelectorAll(
    '[class*="comment_item_is_replied"]'
  );

  // 원래 스타일을 저장해둘 맵 (복구를 위해)
  const originalStyles = new Map();

  repliedContainers.forEach((el) => {
    // 1. 원래 마진 저장
    originalStyles.set(el, el.style.margin);

    // 2. 캡처용 마진 적용 (여백을 0으로 하거나, 잘리지 않게 조정)
    el.style.margin = "12px 6px 7px 8px";
  });

  // 부모 박스(commentBoxElement) 자체의 여백 확보
  // 내용물이 꽉 차서 테두리가 잘리는 경우를 대비해 임시로 패딩 추가
  const originalPadding = commentBoxElement.style.padding;
  commentBoxElement.style.padding = "10px";

  const originalBoxSizing = commentBoxElement.style.boxSizing;
  commentBoxElement.style.boxSizing = "border-box";

  const channelName =
    document.querySelector(
      'div[class*="video_information_name"] span[class*="name_text"]'
    )?.textContent ||
    document.querySelector(
      'div[class*="community_detail_name"] span[class*="name_text"]'
    )?.textContent ||
    "알 수 없음";

  const title =
    document.querySelector('h2[class*="video_information_title"]')
      ?.textContent ||
    (document.querySelector(
      'div[class*="community_detail_name"] span[class*="name_text"]'
    ) == null
      ? "제목 없음"
      : "커뮤니티");

  const content =
    commentBoxElement.querySelector(
      'div[class*="comment_item_content"] [class*="comment_item_text"]'
    )?.lastChild.textContent ||
    (commentBoxElement.querySelector(
      'div[class*="comment_item_attachment"] img'
    ) == null
      ? ""
      : "(이미지/스티커)");

  const nickname = commentBoxElement.querySelector(
    'span[class*="name_text"]'
  ).textContent;

  const userHash = commentHashMap.get(commentId);

  let isDarkMode = document.documentElement.className === "theme_dark";
  let bgColor = isDarkMode ? "#1c1d1f" : "#f9f9f9";

  // 2. 캡처 실행
  htmlToImage
    .toPng(commentBoxElement, {
      backgroundColor: bgColor, // 배경 투명
      skipFonts: true, // 폰트 로딩 에러 방지
      cacheBust: true, // 캐시 문제 방지
      filter: (node) => {
        // 스타일시트 링크 태그 제외 (에러 방지)
        if (node.tagName === "LINK" && node.rel === "stylesheet") return false;

        return true;
      },
    })
    .then(function (dataUrl) {
      // 3. 성공 시 백그라운드로 전송
      // [분기 처리] 모드에 따라 다른 동작
      if (mode === "download") {
        // [모드 1] 즉시 다운로드
        chrome.runtime.sendMessage({
          type: "DOWNLOAD_IMAGE",
          dataUrl: dataUrl,
          filename: `chzzk_${channelName}_comment_${nickname}_${userHash}_${commentId}_${new Date()
            .toISOString()
            .slice(0, 10)}.png`,
        });

        // 다운로드 모드는 잠시 체크 표시 후 원래 아이콘(📷)으로 복구
        targetEl.innerText = "✅";
        setTimeout(() => {
          targetEl.innerText = "📷";
        }, 1000);
      } else if (mode === "collect") {
        // [모드 2] PDF 수집함 저장
        blockedImagesCache[commentId] = {
          commentId: commentId,
          dataUrl: dataUrl,
          timestamp: new Date().toLocaleString(),
          createdAt: Date.now(),
          nickname: nickname,
          uid: userHash,
          streamer: channelName,
          title: title,
          content: content,
          pageUrl: window.location.href,
        };

        if (isDataLoaded) {
          chrome.storage.local.set({
            [STORAGE_IMAGES_KEY]: blockedImagesCache,
          });
          updateExportButtonUI(); // 하단 버튼 개수 갱신
        }

        // 수집 모드는 '완료' 상태로 영구 변경 (시각적 표시)
        targetEl.innerText = "📥 담기 완료";
        buttonElement.classList.add("is-captured");

        showToast("PDF 생성 목록에 담겼습니다.", "success");

        // 툴팁 텍스트 변경
        const tooltip = buttonElement.querySelector(".chzzk-tooltip-text");
        if (tooltip) tooltip.innerText = "목록에서 제거";
      }

      buttonElement.style.cursor = "pointer";
      buttonElement.style.opacity = "1";
    })
    .catch(function (error) {
      console.error("캡처 실패:", error);
      showToast("캡처 중 오류가 발생했습니다.", "error");

      // UI 복구
      targetEl.innerText = originalText;
      buttonElement.style.cursor = "pointer";
      buttonElement.style.opacity = "1";
    })
    .finally(function () {
      // 5. [원상 복구] 변경했던 스타일 모두 되돌리기
      // A. 블러 다시 적용
      blurredElements.forEach((el) => el.classList.add("chzzk-blur-content"));

      // B. 버튼 다시 표시 (빈 문자열을 주면 inline style이 제거되어 클래스 스타일로 돌아감)
      buttonsToHide.forEach((btn) => (btn.style.display = ""));

      // C. 대댓글 영역 다시 보이기
      repliesToHide.forEach((el) => (el.style.display = ""));

      // 스타일 보정 복구
      repliedContainers.forEach((el) => {
        el.style.margin = originalStyles.get(el) || "";
      });

      // 부모 박스 패딩 복구
      commentBoxElement.style.padding = originalPadding;
      commentBoxElement.style.boxSizing = originalBoxSizing;
    });
}

// 캡처 취소(삭제) 함수
function removeCapture(commentId, buttonElement) {
  // 1. 데이터 삭제
  if (blockedImagesCache[commentId]) {
    delete blockedImagesCache[commentId];

    if (isDataLoaded) {
      chrome.storage.local.set({ [STORAGE_IMAGES_KEY]: blockedImagesCache });
      updateExportButtonUI(); // 우측 하단 버튼 갱신
    }
  }

  // 2. UI 복구 (버튼 스타일 초기화)
  // 버튼이 전달되지 않았으면 ID로 찾음
  if (!buttonElement) {
    const box = document.getElementById(`commentBox-${commentId}`);
    if (box) buttonElement = box.querySelector(".chzzk-collect-btn");
  }

  if (buttonElement) {
    buttonElement.classList.remove("is-captured");

    const label = buttonElement.querySelector(".btn-label");
    if (label) label.innerText = "📥";

    // 툴팁 텍스트 복구
    const tooltip = buttonElement.querySelector(".chzzk-tooltip-text");
    if (tooltip) tooltip.innerText = "PDF 목록에 담기";

    showToast("목록에서 제거되었습니다.", "success");
  }
}

// 차단 목록 관리 모달
function openBlockListModal() {
  // 1. 데이터 준비 및 통합
  const blockEntries = Object.values(blockedDetailsCache).map((item) => ({
    ...item,
    dataType: "block", // 구분값
    displayType: "🚫 차단",
    sortTime: item.createdAt || new Date(Date(item.blockDate)).getTime(), // 정렬용 시간
    targetUrl: item.url, // 이동할 주소
  }));

  const captureEntries = Object.values(blockedImagesCache).map((item) => ({
    ...item,
    dataType: "capture",
    displayType: "📥 수집",
    sortTime: item.createdAt || new Date(Date(item.timestamp)).getTime(),
    targetUrl: item.pageUrl,
  }));

  // 두 배열 합치기
  let allEntries = [...blockEntries, ...captureEntries];
  // 차단 목록 데이터 준비
  // const blockEntries = Object.values(blockedDetailsCache);

  if (allEntries.length === 0) {
    showToast("저장된 데이터(차단/수집)가 없습니다.", "info");
    return;
  }

  // 모달 생성
  const overlay = document.createElement("div");
  overlay.className = "chzzk-modal-overlay";

  const content = document.createElement("div");
  content.className = "chzzk-modal-content";

  // 헤더
  const header = document.createElement("div");
  header.className = "chzzk-modal-header";
  header.innerHTML = `
    <div class="chzzk-modal-title">
      차단 유저 관리 (<span id="chzzk-block-count" style="color:#e74c3c;">${allEntries.length}</span>명)
    </div>
  `;

  const closeBtn = document.createElement("span");
  closeBtn.className = "chzzk-modal-close";
  closeBtn.innerHTML = "&times;";
  closeBtn.onclick = () => overlay.remove();
  header.appendChild(closeBtn);

  // 바디
  const body = document.createElement("div");
  body.className = "chzzk-modal-body";

  // 리스트 컨테이너
  const listContainer = document.createElement("div");
  body.appendChild(listContainer);

  // 리스트 렌더링
  const renderList = () => {
    listContainer.innerHTML = "";

    // 최신순(내림차순) 정렬: 날짜 문자열 비교
    allEntries.sort((a, b) => b.sortTime - a.sortTime);

    allEntries.forEach((user) => {
      const item = document.createElement("div");
      item.className = "chzzk-block-item";

      // 클릭 시 해당 페이지로 이동
      item.onclick = (e) => {
        // 버튼 클릭 시에는 이동하지 않음
        if (e.target.tagName === "BUTTON") return;
        if (user.targetUrl) {
          const urlObj = new URL(user.targetUrl);
          if (user.commentId) {
            urlObj.searchParams.set("chzzk_target", user.commentId);
          }

          window.open(urlObj.toString(), "_blank");
        } else {
          showToast("URL 정보가 없습니다.", "error");
        }
      };

      const badgeColor = user.dataType === "block" ? "#e74c3c" : "#2ecc71";

      item.innerHTML = `
        <div class="chzzk-block-info">
            <div class="meta"><span style="font-weight:bold; color:${badgeColor}; margin-right:5px;">[${
        user.displayType
      }]</span>${user.blockDate || user.timestamp} | ${
        user.streamerName || user.streamer
      }</div>
            <div style="font-weight:bold;">${
              user.nickname
            } <span style="font-weight:normal; font-size:11px; color:#999;">(${
        user.uid
      })</span></div>
            <div class="content">${user.content || "내용 없음"}</div>
        </div>
      `;

      // 툴팁 추가
      addTooltip(item, "클릭하여 해당 페이지 열기");

      // 차단 해제 버튼
      const unblockBtn = document.createElement("button");
      unblockBtn.className = "chzzk-unblock-btn";

      if (user.dataType === "block") {
        unblockBtn.innerText = "차단 해제";
        unblockBtn.onclick = () => {
          // 차단 해제 로직 호출
          toggleBlockUser(user.uid);

          // 리스트에서 제거 및 UI 갱신
          allEntries = allEntries.filter(
            (e) => e.uid !== user.uid || e.dataType !== "block"
          );
          renderList();
          updateCount();
        };
      } else {
        unblockBtn.innerText = "수집 삭제";
        unblockBtn.onclick = () => {
          // 캡처 삭제 로직 호출
          delete blockedImagesCache[user.commentId];
          if (isDataLoaded) {
            chrome.storage.local.set({
              [STORAGE_IMAGES_KEY]: blockedImagesCache,
            });
            updateExportButtonUI();

            // 메인 화면 버튼 복구 (해당 댓글이 화면에 있다면)
            const box = document.getElementById(`commentBox-${user.commentId}`);
            if (box) {
              const btn = box.querySelector(".chzzk-collect-btn");
              if (btn) {
                btn.classList.remove("is-captured");
                const label = btn.querySelector(".btn-label");
                if (label) label.innerText = "📥";
              }
            }

            // 리스트에서 제거 및 UI 갱신
            allEntries = allEntries.filter(
              (e) => e.commentId !== user.commentId || e.dataType !== "capture"
            );
            renderList();
            updateCount();
          }
        };
      }
      item.appendChild(unblockBtn);
      listContainer.appendChild(item);
    });
  };

  // 카운트 갱신
  const updateCount = () => {
    document.querySelectorAll(".chzzk-block-item").length; // 현재 리스트 개수로 확인
    const countSpan = header.querySelector("#chzzk-block-count");
    if (countSpan) countSpan.innerText = allEntries.length;

    if (updateCount === 0) {
      showToast("목록이 비었습니다.", "info");
      overlay.remove();
    }
  };

  // 푸터
  const footer = document.createElement("div");
  footer.className = "chzzk-modal-footer";

  const closeFooterBtn = document.createElement("button");
  closeFooterBtn.className = "chzzk-btn chzzk-btn-secondary";
  closeFooterBtn.innerText = "닫기";
  closeFooterBtn.onclick = () => overlay.remove();

  // CSV 다운로드 버튼
  const downloadBtn = document.createElement("button");
  downloadBtn.className = "chzzk-btn chzzk-btn-primary chzzk-csv-btn";
  downloadBtn.innerHTML = "💾 CSV 파일로 저장";
  downloadBtn.onclick = () => {
    exportToCSV();
    overlay.remove();
  };

  footer.appendChild(closeFooterBtn);
  footer.appendChild(downloadBtn);

  content.appendChild(header);
  content.appendChild(body);
  content.appendChild(footer);
  overlay.appendChild(content);
  document.body.appendChild(overlay);

  // 초기 렌더링
  renderList();
}

// PDF 생성 모달 띄우기
function openPdfModal() {
  // 1. 데이터 준비 (객체 -> 배열)
  let images = Object.entries(blockedImagesCache).map(([key, value]) => ({
    ...value,
    id: key,
  }));

  if (images.length === 0) {
    showToast("저장된 캡처 이미지가 없습니다.", "info");
    return;
  }

  // 모달 기본 구조 생성
  const overlay = document.createElement("div");
  overlay.className = "chzzk-modal-overlay";

  const content = document.createElement("div");
  content.className = "chzzk-modal-content";

  // --- 헤더  ---
  const header = document.createElement("div");
  header.className = "chzzk-modal-header";
  header.innerHTML = `
    <div style="display:flex; align-items:center; gap:10px">
      <span class="chzzk-modal-title">PDF 생성 목록</span>
      <select id="chzzk-sort-select" class="chzzk-sort-select">
        <option value="desc">최신순</option>
        <option value="asc">오래된순</option>
      </select>
      <div style="font-size:13px;">
        선택 <span id="chzzk-selected-count" style="color:#e74c3c; font-weight:bold;">0</span> / 
        전체 <span id="chzzk-total-count">0</span>
      </div>
    </div>
  `;

  const closeBtn = document.createElement("span");
  closeBtn.className = "chzzk-modal-close";
  closeBtn.innerHTML = "&times;";
  closeBtn.style.marginLeft = "15px";
  closeBtn.onclick = () => overlay.remove();
  header.appendChild(closeBtn);

  // --- 바디 (리스트 컨테이너) ---
  const body = document.createElement("div");
  body.className = "chzzk-modal-body";

  // 컨트롤 바 (전체 선택 + 전체 삭제)
  const controlBar = document.createElement("div");
  controlBar.className = "chzzk-modal-controls";

  // 1. 전체 선택 체크박스
  const selectAllLabel = document.createElement("label");
  selectAllLabel.style.cssText =
    "cursor:pointer; user-select:none; font-size:13px;";
  selectAllLabel.innerHTML = `<input type="checkbox" id="chzzk-select-all" checked> 전체 선택`;

  // 2. 전체 삭제 버튼
  const deleteAllBtn = document.createElement("button");
  deleteAllBtn.className = "chzzk-delete-all-text-btn";
  deleteAllBtn.innerText = "🗑️ 목록 전체 비우기";

  // 전체 삭제 이벤트
  deleteAllBtn.onclick = () => {
    const count = Object.keys(blockedImagesCache).length;
    // 데이터 초기화
    blockedImagesCache = {};
    chrome.storage.local.remove([STORAGE_IMAGES_KEY]);

    // UI 및 상태 복구
    updateExportButtonUI();
    resetCaptureButtons();

    // 모달 닫기
    overlay.remove();
    showToast("목록이 모두 삭제되었습니다.", "success");
  };

  controlBar.appendChild(selectAllLabel);
  controlBar.appendChild(deleteAllBtn);
  body.appendChild(controlBar);

  // 리스트 아이템이 들어갈 영역
  const listContainer = document.createElement("div");
  body.appendChild(listContainer);

  // [내부 함수] 개수 갱신
  const updateCountUI = () => {
    const total = listContainer.querySelectorAll(".chzzk-capture-item").length;
    const selected = listContainer.querySelectorAll(
      ".chzzk-pdf-checkbox:checked"
    ).length;

    header.querySelector("#chzzk-total-count").innerText = total;
    header.querySelector("#chzzk-selected-count").innerText = selected;
  };

  // [내부 함수] 리스트 렌더링 (정렬 로직 포함)
  const renderList = (sortType) => {
    listContainer.innerHTML = ""; // 기존 목록 초기화

    // 정렬 실행
    images.sort((a, b) => {
      // createdAt(숫자) 우선 비교, 없으면 timestamp(문자열) 비교
      const timeA = a.createdAt || 0;
      const timeB = b.createdAt || 0;

      if (sortType === "asc") {
        // 오래된순 (작은게 위로)
        return (
          timeA - timeB ||
          String(a.timestamp).localeCompare(String(b.timestamp))
        );
      } else {
        // 최신순 (큰게 위로)
        return (
          timeB - timeA ||
          String(b.timestamp).localeCompare(String(a.timestamp))
        );
      }
    });

    // 아이템 생성 루프
    images.forEach((img) => {
      const item = document.createElement("div");
      item.className = "chzzk-capture-item";
      item.dataset.id = img.id;

      item.innerHTML = `
        <input type="checkbox" class="chzzk-pdf-checkbox" value="${img.id}" checked>
        <img src="${img.dataUrl}" class="chzzk-capture-thumb">
        <div class="chzzk-capture-info">
          <div>${img.streamer} - ${img.title}</div>
          <strong>${img.nickname} (${img.uid})</strong>
          <span>${img.content}</span>
          <span style="color:#888;">${img.timestamp}</span>
        </div>
        <button class="chzzk-item-delete-btn" title="삭제">❌</button>
      `;

      // 영역 클릭 시 체크박스 토글
      item.onclick = (e) => {
        if (
          e.target.type !== "checkbox" &&
          !e.target.classList.contains("chzzk-item-delete-btn")
        ) {
          const cb = item.querySelector(".chzzk-pdf-checkbox");
          cb.checked = !cb.checked;
          updateCountUI();
        } else if (e.target.type === "checkbox") {
          updateCountUI();
        }
      };

      // 삭제 버튼
      const deleteBtn = item.querySelector(".chzzk-item-delete-btn");
      deleteBtn.onclick = (e) => {
        e.stopPropagation();

        delete blockedImagesCache[img.id];
        showToast("목록에서 제거되었습니다.", "success");

        if (isDataLoaded) {
          chrome.storage.local.set({
            [STORAGE_IMAGES_KEY]: blockedImagesCache,
          });
          updateExportButtonUI();
        }

        // 배열에서도 제거 (재정렬 시 안 나오게)
        images = images.filter((i) => i.id !== img.id);

        item.remove();
        updateCountUI();

        // 메인 화면 버튼 복구
        const commentBox = document.getElementById(`commentBox-${img.id}`);
        if (commentBox) {
          const collectBtn = commentBox.querySelector(".chzzk-collect-btn");
          if (collectBtn) {
            collectBtn.classList.remove("is-captured");
            const label = collectBtn.querySelector(".btn-label");
            if (label) label.innerText = "📥";
            const tooltip = collectBtn.querySelector(".chzzk-tooltip-text");
            if (tooltip) tooltip.innerText = "PDF 목록에 담기";
          }
        }

        if (images.length === 0) {
          overlay.remove();
          showToast("목록이 비었습니다.", "info");
        }
      };

      listContainer.appendChild(item);
    });

    // 전체 선택 체크박스 초기화 (항상 체크된 상태로 시작)
    const selectAllCb = selectAllLabel.querySelector("#chzzk-select-all");
    selectAllCb.checked = true;
    updateCountUI();
  };

  // --- 푸터 (버튼) ---
  const footer = document.createElement("div");
  footer.className = "chzzk-modal-footer";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "chzzk-btn chzzk-btn-secondary";
  cancelBtn.innerText = "닫기";
  cancelBtn.onclick = () => overlay.remove();

  const createBtn = document.createElement("button");
  createBtn.className = "chzzk-btn chzzk-btn-primary";
  createBtn.innerText = "PDF 생성하기";
  createBtn.onclick = () => {
    const checkedIds = Array.from(
      listContainer.querySelectorAll(".chzzk-pdf-checkbox:checked")
    ).map((cb) => cb.value);
    if (checkedIds.length === 0) {
      showToast("선택된 항목이 없습니다.", "error");
      return;
    }
    // 현재 정렬된 순서 그대로 PDF 생성에 전달
    const selectedImages = images.filter((img) => checkedIds.includes(img.id));
    generatePDF(selectedImages);
    overlay.remove();
  };

  footer.appendChild(cancelBtn);
  footer.appendChild(createBtn);

  // 조립
  content.appendChild(header);
  content.appendChild(body);
  content.appendChild(footer);
  overlay.appendChild(content);
  document.body.appendChild(overlay);

  // 이벤트 연결
  // 1. 정렬 변경 이벤트
  const sortSelect = header.querySelector("#chzzk-sort-select");
  sortSelect.onchange = (e) => {
    renderList(e.target.value);
  };

  // 2. 전체 선택 이벤트
  const selectAllCb = selectAllLabel.querySelector("#chzzk-select-all");
  selectAllCb.onchange = (e) => {
    listContainer.querySelectorAll(".chzzk-pdf-checkbox").forEach((cb) => {
      cb.checked = e.target.checked;
    });
    updateCountUI();
  };

  // 초기 렌더링 (기본: 최신순)
  renderList("desc");
}

// 실제 PDF 생성 로직 (모달에서 호출)
function generatePDF(selectedImages) {
  if (!selectedImages || selectedImages.length === 0) {
    console.error("PDF 생성 데이터가 없습니다.");
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  let yPos = 10;

  selectedImages.forEach((imgData, index) => {
    if (yPos > 250) {
      doc.addPage();
      yPos = 10;
    }

    // 데이터 유효성 검사 및 기본값 처리
    const streamer = imgData.streamer || "알 수 없음";
    const title = imgData.title || "제목 없음";
    const pageUrl = imgData.pageUrl || "";
    const timestamp = imgData.timestamp || "";
    const nickname = imgData.nickname || "알 수 없음";
    const uid = imgData.uid || "";

    const line1Text = `[${index + 1}] ${streamer} | ${title} | URL: ${pageUrl}`;
    const line2Text = `캡처일: ${timestamp}`;
    const line3Text = `User: ${nickname} (UID: ${uid})`;

    // 텍스트 이미지 변환
    const line1Img = textToImageDataURL(line1Text, 12);
    const line2Img = textToImageDataURL(line2Text, 12);
    const line3Img = textToImageDataURL(line3Text, 12);

    doc.addImage(line1Img, "PNG", 10, yPos, 0, 4);
    doc.addImage(line2Img, "PNG", 10, yPos + 5, 0, 3);
    doc.addImage(line3Img, "PNG", 10, yPos + 9, 0, 4);

    // 캡처 이미지 추가
    if (imgData.dataUrl) {
      try {
        const imgProps = doc.getImageProperties(imgData.dataUrl);
        const pdfWidth = 180;
        const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;
        doc.addImage(
          imgData.dataUrl,
          "PNG",
          10,
          yPos + 15,
          pdfWidth,
          pdfHeight
        );
        yPos += pdfHeight + 25;
      } catch (e) {
        console.error("이미지 추가 실패:", e);
        yPos += 20; // 에러 시 여백만 추가하고 넘어감
      }
    }
  });

  // Blob으로 변환 후 Background로 전송 (위치 지정 가능)
  const pdfBlob = doc.output("blob");

  // Blob을 Data URL로 변환 (메시지 전송을 위해)
  const reader = new FileReader();
  reader.readAsDataURL(pdfBlob);
  reader.onloadend = function () {
    const base64data = reader.result;

    chrome.runtime.sendMessage({
      type: "DOWNLOAD_PDF",
      dataUrl: base64data,
      filename: `chzzk_comment_report_${new Date()
        .toISOString()
        .slice(0, 10)}.pdf`,
    });
  };
}

function clearImages() {
  const count = Object.keys(blockedImagesCache).length;
  if (count === 0) {
    showToast("비울 내용이 없습니다.", "error");
    return;
  }

  // 1. 데이터 초기화
  blockedImagesCache = {};
  chrome.storage.local.remove([STORAGE_IMAGES_KEY]);

  // 2. UI 갱신 (우측 하단 버튼)
  updateExportButtonUI();

  // 3. 화면 내 캡처 완료 버튼들 원상 복구
  resetCaptureButtons();

  showToast("목록이 모두 삭제되었습니다.", "success");
}

// 화면 내 모든 캡처 버튼 상태 초기화 함수
function resetCaptureButtons() {
  const capturedBtns = document.querySelectorAll(
    ".chzzk-collect-btn.is-captured"
  );

  capturedBtns.forEach((btn) => {
    btn.classList.remove("is-captured");
    const label = btn.querySelector(".btn-label");
    if (label) label.innerText = "📥";

    const tooltip = btn.querySelector(".chzzk-tooltip-text");
    if (tooltip) tooltip.innerText = "PDF 목록에 담기";
  });
}

// 우측 하단 버튼 UI 갱신 함수
function updateExportButtonUI() {
  const csvBtn = document.getElementById("chzzk-csv-btn");
  const pdfBtn = document.getElementById("chzzk-pdf-btn");
  const clearBtn = document.getElementById("chzzk-clear-btn");

  // 1. 캡처 이미지 개수 (PDF용)
  const imgCount = Object.keys(blockedImagesCache).length;

  // 2. 차단 유저 개수
  const blockCount = Object.keys(blockedDetailsCache).length;

  // 3. CSV용 총 개수 (차단 + 수집)
  const totalCsvCount = blockCount + imgCount;

  // 4. 용량 계산 (근사치)
  // 문자열 길이를 바이트로 환산 (UTF-16 기준 대략적 계산이거나 단순히 길이로 계산)
  const jsonString = JSON.stringify(blockedImagesCache);
  const bytes = new Blob([jsonString]).size; // Blob을 이용해 정확한 바이트 계산
  const kbytes = bytes / 1024;
  const mbytes = kbytes / 1024;

  let sizeText = "";
  if (mbytes >= 1) {
    sizeText = `${mbytes.toFixed(1)}MB`;
  } else if (kbytes >= 1) {
    sizeText = `${kbytes.toFixed(0)}KB`;
  } else {
    sizeText = `${bytes}B`;
  }

  if (csvBtn) {
    csvBtn.innerText = `💾 [CSV] 차단/수집 목록 (${totalCsvCount})`;
  }

  if (pdfBtn && clearBtn) {
    pdfBtn.innerText = `📄 [PDF] 캡처 모음 (${imgCount})`;

    if (imgCount > 0) {
      clearBtn.innerText = `🗑️ 캡처 비우기 (${imgCount}개 / ${sizeText})`;
    } else {
      clearBtn.innerText = `🗑️ 캡처 비우기`;
    }
  }
}

function parseComments(list) {
  list.forEach((item) => {
    if (item.comment && item.user) {
      commentHashMap.set(
        item.comment.commentId.toString(),
        item.user.userIdHash
      );
    }
    if (item.replyComments) parseComments(item.replyComments);
  });
}

// --- DOM 업데이트 ---
function scheduleUpdateDom() {
  if (domUpdateTimer) clearTimeout(domUpdateTimer);
  domUpdateTimer = setTimeout(() => {
    updateDom();
  }, 200); // 반응성을 위해 0.2초로 단축
}

function updateDom() {
  const blockedUsers = getBlockedUsers();
  const commentBoxes = document.querySelectorAll('[id^="commentBox-"]');

  commentBoxes.forEach((box) => {
    const parts = box.id.split("-");
    const commentId = parts[parts.length - 1];

    // 타겟 댓글 포커싱 로직
    if (pendingTargetId && pendingTargetId === commentId) {
      // 아직 강조 표시가 안 되어 있다면 실행
      if (!box.classList.contains("chzzk-target-highlight")) {
        // 1. 스타일 적용
        box.classList.add("chzzk-target-highlight");

        // 2. 스크롤 이동 (약간의 지연을 주어 렌더링 후 이동 보장)
        setTimeout(() => {
          box.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 500);

        // 3. 찾았다고 바로 pendingTargetId를 null로 만들지 않음
        // (스크롤 이동 중에 다른 로직이 간섭할 수 있으므로 유지하되, 중복 실행은 classList 체크로 방지)

        // 4. 알림
        showToast("선택한 댓글 위치로 이동했습니다.", "success");
      }
    }

    if (commentHashMap.has(commentId)) {
      const userHash = commentHashMap.get(commentId);
      const isBlocked = blockedUsers.includes(userHash);

      // 1. 버튼 그룹 UI 생성 및 검증 (재사용된 요소인지 확인)
      const existingGroup = box.querySelector(".chzzk-btn-group");

      // 이미 버튼 그룹이 있지만, 현재 데이터(userHash)와 다른 해시를 가지고 있다면?
      // -> 재사용된 DOM이므로 기존 버튼을 삭제해야 함
      if (existingGroup && existingGroup.dataset.ownerHash !== userHash) {
        existingGroup.remove();
        delete box.dataset.uiInjected;

        // 이전에 붙은 툴팁 제거
        const oldTooltips = box.querySelectorAll(".chzzk-tooltip-text");
        oldTooltips.forEach((t) => t.remove());
      }

      if (!box.dataset.uiInjected) {
        const nicknameEl = box.querySelector('span[class*="name_text"]');
        // 닉네임 옆에 아직 버튼 그룹(.chzzk-btn-group)이 없는 경우에만 추가
        if (nicknameEl && !box.querySelector(".chzzk-btn-group")) {
          injectButtonGroup(nicknameEl, userHash, box, commentId);
          box.dataset.uiInjected = "true";
        }
      }

      // 2. 내용 블러 처리 로직
      const contentEl = box.querySelector('div[class*="comment_item_content"]');
      // 툴팁 위치 잡기를 위해 부모 요소에 relative 설정
      if (contentEl && contentEl.parentElement) {
        contentEl.parentElement.style.position = "relative";
      }

      if (contentEl) {
        if (isBlocked) {
          // 블러 처리가 필요한데 안 되어 있다면 적용
          // [최적화] 이미 블러 처리된 상태라면 건드리지 않음
          if (
            !contentEl.classList.contains("chzzk-blur-content") &&
            !contentEl.dataset.tempUnblur
          ) {
            contentEl.classList.add("chzzk-blur-content");

            // 1. 이미 형제 툴팁이 있는지 확인
            let tooltip = contentEl.parentNode.querySelector(
              ".chzzk-tooltip-text.for-blur"
            );

            // 2. 없으면 생성해서 contentEl 바로 뒤에 삽입
            if (!tooltip) {
              tooltip = document.createElement("span");
              tooltip.className = "chzzk-tooltip-text for-blur";
              tooltip.innerText = "차단된 댓글입니다. 클릭하여 잠시 확인";

              tooltip.style.bottom = "100%";
              tooltip.style.left = "50%";

              contentEl.after(tooltip); // 자식(appendChild)이 아니라 형제(after)로 삽입
            }
          }

          // 클릭 이벤트 (한 번만 등록)
          if (!contentEl.dataset.clickEvent) {
            contentEl.onclick = (e) => {
              if (contentEl.classList.contains("chzzk-blur-content")) {
                e.preventDefault();
                e.stopPropagation();

                // A. 블러 해제
                contentEl.classList.remove("chzzk-blur-content");
                contentEl.dataset.tempUnblur = "true"; // 임시 해제 상태 플래그

                // 블러 해제 시 형제 툴팁도 숨김 (제거하거나 스타일로 숨김)
                const siblingTooltip = contentEl.parentNode.querySelector(
                  ".chzzk-tooltip-text.for-blur"
                );
                if (siblingTooltip) siblingTooltip.style.display = "none";

                // B. 3초 뒤 다시 블러 처리 (타이머)
                setTimeout(() => {
                  // 3초 뒤에도 여전히 임시 해제 상태라면 (그 사이 차단 해제 안 했다면)
                  if (contentEl.dataset.tempUnblur === "true") {
                    contentEl.classList.add("chzzk-blur-content");
                    delete contentEl.dataset.tempUnblur; // 플래그 삭제

                    // 다시 블러될 때 툴팁 복구
                    if (siblingTooltip) siblingTooltip.style.display = "";
                  }
                }, 3000);
              }
            };
            contentEl.dataset.clickEvent = "true";
          }
        } else {
          // 차단 해제 상태라면 원상 복구
          // 차단 해제 상태인데, 아직 클래스가 남아있다면 제거
          if (contentEl.classList.contains("chzzk-blur-content")) {
            contentEl.classList.remove("chzzk-blur-content");

            // 형제 툴팁 제거
            const siblingTooltip = contentEl.parentNode.querySelector(
              ".chzzk-tooltip-text.for-blur"
            );
            if (siblingTooltip) siblingTooltip.remove();

            contentEl.onclick = null;
            delete contentEl.dataset.clickEvent;
            delete contentEl.dataset.tempUnblur;
          }
        }
      }

      // 3. 차단 버튼 스타일 동기화 (빨간색 <-> 회색)
      // 해당 유저의 해시 ID를 가진 차단 버튼을 찾음
      const blockBtn = box.querySelector(`.block-btn-${userHash}`);
      if (blockBtn) {
        // 텍스트 변경 시 .btn-label 만 수정 (툴팁 보존)
        const labelEl = blockBtn.querySelector(".btn-label");

        if (isBlocked) {
          // 이미 'is-blocked' 클래스가 있다면 아무것도 하지 않음 (재렌더링 방지)
          if (!blockBtn.classList.contains("is-blocked")) {
            blockBtn.classList.add("is-blocked");
            if (labelEl) labelEl.innerText = "차단됨";
          }
        } else {
          // 이미 차단 해제된 상태라면 아무것도 하지 않음
          if (blockBtn.classList.contains("is-blocked")) {
            blockBtn.classList.remove("is-blocked");
            if (labelEl) labelEl.innerText = "차단하기";
          }
        }
      }
    }
  });
}

// 툴팁 요소를 버튼 내부에 추가하는 헬퍼 함수
function addTooltip(targetBtn, text) {
  // 이미 있으면 중복 추가 방지
  if (targetBtn.querySelector(".chzzk-tooltip-text")) return;

  const tooltip = document.createElement("span");
  tooltip.className = "chzzk-tooltip-text";
  tooltip.innerText = text;
  targetBtn.appendChild(tooltip);
}

// UI 주입 함수 (복사 버튼 + 차단 버튼 분리)
function injectButtonGroup(targetElement, hash, commentBoxElement, commentId) {
  const group = document.createElement("span");
  group.className = "chzzk-btn-group";

  // 이 그룹이 어떤 유저의 것인지 마킹 (재사용 감지용)
  group.dataset.ownerHash = hash;

  // [1] 복사 버튼
  const copyBtn = document.createElement("span");
  copyBtn.className = "chzzk-action-btn chzzk-copy-btn";
  copyBtn.innerText = `${hash}`;

  addTooltip(copyBtn, `UID 복사하기`);

  copyBtn.onclick = (e) => {
    e.stopPropagation();
    e.preventDefault();
    navigator.clipboard.writeText(hash).then(() => {
      // 복사 성공 시각적 피드백 (텍스트 잠시 변경)
      if (copyBtn.childNodes[0]) {
        const originalText = copyBtn.childNodes[0].textContent;
        copyBtn.childNodes[0].textContent = "복사됨";
        setTimeout(() => {
          copyBtn.childNodes[0].textContent = originalText; // 원상 복구 시에도 텍스트만 변경
        }, 1000);
      }

      showToast("UID가 클립보드에 복사되었습니다.", "success");
    });
  };

  // [2] 개별 캡처 버튼 (다운로드용)
  const captureBtn = document.createElement("span");
  captureBtn.className = "chzzk-action-btn chzzk-capture-btn";

  const captureLabel = document.createElement("span");
  captureLabel.className = "btn-label";
  captureLabel.innerText = "📷";
  captureBtn.appendChild(captureLabel);

  addTooltip(captureBtn, "댓글 캡처 이미지 다운로드 (PNG)"); // 툴팁 변경

  captureBtn.onclick = (e) => {
    e.stopPropagation();
    e.preventDefault();
    // 모드: 'download'
    captureCommentBox(commentBoxElement, commentId, captureBtn, "download");
  };

  // [3] 수집 버튼 (PDF용 장바구니)
  const collectBtn = document.createElement("span");
  collectBtn.className = "chzzk-action-btn chzzk-collect-btn";

  // 이미 수집된 상태면 스타일 유지
  const isCollected = !!blockedImagesCache[commentId];
  if (isCollected) {
    collectBtn.classList.add("is-captured");
  }

  const collectLabel = document.createElement("span");
  collectLabel.className = "btn-label";
  collectLabel.innerText = blockedImagesCache[commentId]
    ? "📥 담기 완료"
    : "📥"; // 상태에 따라 아이콘 변경
  collectBtn.appendChild(collectLabel);

  addTooltip(collectBtn, isCollected ? "목록에서 제거" : "PDF 목록에 담기");

  collectBtn.onclick = (e) => {
    e.stopPropagation();
    e.preventDefault();

    // 이미 담겨있으면 삭제, 없으면 캡처
    if (blockedImagesCache[commentId]) {
      // 취소(삭제) 로직
      removeCapture(commentId, collectBtn);
    } else {
      // 모드: 'collect'
      captureCommentBox(commentBoxElement, commentId, collectBtn, "collect");
    }
  };

  // [4] 차단 버튼
  const blockBtn = document.createElement("span");
  // 나중에 상태 업데이트를 위해 고유 클래스(block-btn-해시) 추가
  blockBtn.className = `chzzk-action-btn chzzk-block-btn block-btn-${hash}`;

  // 차단 버튼 텍스트를 감싸는 span 생성 (툴팁 보존을 위해)
  const blockLabel = document.createElement("span");
  blockLabel.className = "btn-label";
  blockLabel.innerText = "차단하기";
  blockBtn.appendChild(blockLabel);

  // 툴팁 추가
  addTooltip(blockBtn, "유저 차단/해제");

  blockBtn.onclick = (e) => {
    e.stopPropagation();
    e.preventDefault();

    // 차단 버튼 클릭 시점에 메타데이터 수집
    const streamerName =
      document.querySelector(
        'div[class*="video_information_name"] span[class*="name_text"]'
      )?.textContent ||
      document.querySelector(
        'div[class*="community_detail_name"] span[class*="name_text"]'
      )?.textContent ||
      "알 수 없음";

    const nickname = targetElement.textContent || "알 수 없음";

    const title =
      document.querySelector('h2[class*="video_information_title"]')
        ?.textContent ||
      (document.querySelector(
        'div[class*="community_detail_name"] span[class*="name_text"]'
      ) == null
        ? "제목 없음"
        : "커뮤니티");

    const commentId = commentBoxElement.id.split("-").pop();

    // 1. 텍스트 컨테이너(comment_item_text) 찾기
    let contentEl = commentBoxElement.querySelector(
      'div[class*="comment_item_text"]'
    );

    // 2. 텍스트 컨테이너가 없으면(구조가 다를 경우), 상위 컨텐츠 박스에서 찾기
    if (!contentEl) {
      contentEl = commentBoxElement.querySelector(
        'div[class*="comment_item_content"]'
      );
    }

    // 3. 텍스트 추출
    let content = "";
    if (contentEl) {
      // 불필요한 공백 제거
      content = contentEl.lastChild.textContent.trim();
    }

    // 4. 텍스트가 비어있다면 이미지/이모티콘인지 확인
    if (!content) {
      const imgEl = commentBoxElement.querySelector(
        'div[class*="comment_item_attachment"] img'
      );
      if (imgEl) content = "(이미지/스티커)";
      else content = "내용 없음";
    }

    const metaData = {
      title: title,
      streamerName: streamerName,
      nickname: nickname,
      commentId: commentId,
      content: content,
      url: window.location.href, // 차단한 페이지 URL
    };

    toggleBlockUser(hash, metaData); // 메타데이터 함께 전달
  };

  group.appendChild(copyBtn);
  group.appendChild(captureBtn);
  group.appendChild(collectBtn);
  group.appendChild(blockBtn);

  targetElement.parentNode.appendChild(group);
}

// 치지직 공식 차단/해제 버튼 주입
function injectNativeBlockButton(menuLayer) {
  if (!currentMenuTargetHash) return; // 타겟 유저 정보가 없으면 중단

  // '신고' 버튼 찾기 (이 뒤에 추가하기 위함)
  // svg 내부의 텍스트가 '신고'인 버튼을 찾거나, 구조상 첫번째 li 확인
  const listItems = menuLayer.querySelectorAll("li");
  let reportLi = null;

  // '신고' 텍스트를 가진 버튼이 있는 li 찾기
  listItems.forEach((li) => {
    if (li.textContent.includes("신고")) {
      reportLi = li;
    }
  });

  if (!reportLi) return;

  // 차단 버튼 생성
  const blockLi = document.createElement("li");
  const blockBtn = document.createElement("button");

  // 기존 버튼 스타일 클래스 복사 (comment_item_option...)
  const reportBtnClass = reportLi.querySelector("button").className;
  blockBtn.className = reportBtnClass;
  blockBtn.type = "button";

  // 차단 아이콘 SVG
  const blockSvg = `
    <svg width="20" height="20" viewBox="0 0 25 25" fill="none" xmlns="http://www.w3.org/2000/svg" class="live_chatting_popup_profile_icon_control__fy6xt" aria-hidden="true"><mask id="mask0_1149_32188" maskUnits="userSpaceOnUse" x="4" y="4" width="17" height="16" style="mask-type: luminance;"><path fill-rule="evenodd" clip-rule="evenodd" d="M4 4.5H21L17 11.5L15.41 12C15.41 12 13.5 13.5 13 13.5C13 13.5 12.6667 14 12.5 14C12.3333 14 12 13.5 12 13.5C12 14 13 19.6351 13 19.6351H4V4.5Z" fill="white"></path></mask><g mask="url(#mask0_1149_32188)"><path d="M16.05 8.82432C16.05 10.8375 14.4492 12.4486 12.5 12.4486C10.5508 12.4486 8.95 10.8375 8.95 8.82432C8.95 6.81117 10.5508 5.2 12.5 5.2C14.4492 5.2 16.05 6.81117 16.05 8.82432Z" stroke="currentColor" stroke-width="1.4"></path><path d="M19.2375 19.6352C19.2375 23.4395 16.2096 26.5028 12.5 26.5028C8.79037 26.5028 5.7625 23.4395 5.7625 19.6352C5.7625 15.8309 8.79037 12.7676 12.5 12.7676C16.2096 12.7676 19.2375 15.8309 19.2375 19.6352Z" stroke="currentColor" stroke-width="1.4"></path></g><ellipse cx="5.7625" cy="19.9277" rx="0.7" ry="0.508744" fill="currentColor"></ellipse><ellipse cx="19.24" cy="19.9277" rx="0.7" ry="0.508744" fill="currentColor"></ellipse><circle cx="17.5" cy="17" r="3.5" stroke="currentColor" stroke-width="1.4"></circle><path d="M19.5 14.5L15.5 19.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path></svg>
  `;

  // 텍스트 및 클릭 이벤트 설정
  blockBtn.innerHTML = `${blockSvg} 차단`;

  blockBtn.onclick = async () => {
    // 메뉴 닫기 (클릭 효과)
    menuLayer.style.display = "none";
    await handleNativeBlock(currentMenuTargetHash);
  };

  blockLi.appendChild(blockBtn);

  // 신고 버튼 뒤에 추가
  reportLi.after(blockLi);
}

// 치지직 차단 API 호출 핸들러
async function handleNativeBlock(userHash) {
  const pathSegments = window.location.pathname.split("/");
  const channelId = pathSegments[1];

  if (!channelId) {
    showToast("채널 정보를 찾을 수 없습니다.", "error");
    return;
  }

  // 차단 시도 (POST)
  try {
    const response = await fetch(
      `${CHZZK_API_BASE}/privateUserBlocks/${userHash}?loungeId=${channelId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include", // 쿠키 포함
      }
    );

    if (response.ok) {
      showToast("유저를 차단했습니다.", "success");
      if (!blockedUsersCache.includes(userHash)) {
        toggleBlockUser(userHash);
      }
      applyNativeBlockUI(userHash);
      return;
    }

    throw new Error("API Error");
  } catch (error) {
    console.error("Native block failed:", error);
    showToast("요청 처리 중 오류가 발생했습니다.", "error");
  }
}

// 차단 성공 시 UI 즉시 변경 (새로고침 없이 반영)
function applyNativeBlockUI(userHash) {
  const commentBoxes = document.querySelectorAll('[id^="commentBox-"]');

  commentBoxes.forEach((box) => {
    const parts = box.id.split("-");
    const commentId = parts[parts.length - 1];

    // 해당 유저의 댓글인지 확인 (해시맵 대조)
    if (commentHashMap.get(commentId) === userHash) {
      // 1. 기존 확장프로그램 UI 클린업 (툴팁, 버튼 등 제거)
      const existingTooltips = box.querySelectorAll(".chzzk-tooltip-text");
      existingTooltips.forEach((el) => el.remove());
      delete box.dataset.uiInjected; // 재활용 방지 플래그 제거

      // 2. DOM 내용 교체
      // 기존의 프로필, 닉네임, 내용, 버튼 등이 모두 사라지고 이 내용으로 덮어씌워짐
      box.innerHTML = `
        <div class="comment_item_default__urJDh">
            <img class="comment_item_image__VhM+S" width="36" height="36" src="https://ssl.pstatic.net/static/nng/glive/image/default_profile_light.png" style="margin-right: 10px; border-radius: 50%; vertical-align: middle;">
            <div class="comment_item_text__c6NLq">내가 차단한 이용자의 댓글입니다.</div>
        </div>
      `;
    }
  });
}

// CSV 내보내기 (차단 목록 + 캡처 수집 목록 통합)
function exportToCSV() {
  const blockEntries = Object.values(blockedDetailsCache);
  const captureEntries = Object.values(blockedImagesCache);

  if (blockEntries.length === 0 && captureEntries.length === 0) {
    showToast("저장된 데이터(차단/수집)가 없습니다.", "info");
    return;
  }

  // CSV 헤더
  let csvContent =
    "\uFEFF유형,스트리머,다시보기 제목/커뮤니티,차단일시,닉네임,UID,댓글내용,URL\n";

  const clean = (text) => `"${String(text || "").replace(/"/g, '""')}"`;

  // 1. 차단 목록 추가
  blockEntries.forEach((row) => {
    csvContent += `${clean("차단")},${clean(row.streamerName)},${clean(
      row.title
    )},${clean(row.blockDate)},${clean(row.nickname)},${clean(row.uid)},${clean(
      row.content
    )},${clean(row.url)}\n`;
  });

  // 2. 캡처 수집 목록 추가
  captureEntries.forEach((row) => {
    // 중복 제거: 만약 차단 목록에 이미 있는 UID라면, 굳이 또 넣을지 말지 결정
    // 여기서는 '캡처'라는 행위가 중요하므로 중복되더라도 기록으로 남김
    csvContent += `${clean("캡처수집")},${clean(row.streamer)},${clean(
      row.title
    )},${clean(row.timestamp)},${clean(row.nickname)},${clean(row.uid)},${clean(
      row.content
    )},${clean(row.pageUrl)}\n`;
  });

  // 3. Blob 생성 후 백그라운드로 전송
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });

  // Blob을 Data URL(Base64)로 변환
  const reader = new FileReader();
  reader.readAsDataURL(blob);
  reader.onloadend = function () {
    const base64data = reader.result;

    chrome.runtime.sendMessage({
      type: "DOWNLOAD_CSV",
      dataUrl: base64data,
      filename: `치지직_댓글_차단_캡처_통합로그_${new Date()
        .toISOString()
        .slice(0, 10)}.csv`,
    });
  };
}

// 현재 URL이 내보내기 버튼을 보여줘야 하는 페이지인지 확인
function shouldShowExportButton() {
  const path = window.location.pathname;
  // 영상 페이지(/video/...) 또는 커뮤니티 페이지(/.../community/...) 인지 확인
  return path.includes("/video/") || path.includes("/community/");
}

// URL에 따라 버튼 표시 여부 토글
function toggleExportButtonVisibility() {
  const container = document.getElementById("chzzk-export-container");
  if (container) {
    if (shouldShowExportButton()) {
      container.style.display = "flex";
    } else {
      container.style.display = "none";
    }
  }
}

// CSV, PDF 다운로드 버튼 UI 생성
function createExportButton() {
  const container = document.createElement("div");
  container.id = "chzzk-export-container";

  // 초기 표시 상태 설정
  if (!shouldShowExportButton()) {
    container.style.display = "none";
  }

  // 1. CSV 저장 버튼
  const csvBtn = document.createElement("button");
  csvBtn.id = "chzzk-csv-btn";
  csvBtn.className = "chzzk-export-btn";
  csvBtn.innerText = "💾 [CSV] 차단/수집 목록";
  csvBtn.onclick = openBlockListModal;

  // 2. PDF 저장 버튼
  // PDF (모달 열기)
  const pdfBtn = document.createElement("button");
  pdfBtn.id = "chzzk-pdf-btn";
  pdfBtn.className = "chzzk-export-btn";
  pdfBtn.onclick = openPdfModal; // 바로 생성 안 하고 모달 오픈

  // 3. 이미지 초기화 버튼
  const clearBtn = document.createElement("button");
  clearBtn.id = "chzzk-clear-btn";
  clearBtn.className = "chzzk-export-btn";
  clearBtn.innerText = "🗑️ 비우기";
  clearBtn.onclick = clearImages;

  container.appendChild(csvBtn);
  container.appendChild(pdfBtn);
  container.appendChild(clearBtn);

  document.body.appendChild(container);

  updateExportButtonUI(); // 초기값 설정
}

// URL 파라미터 확인 및 포커싱
function checkUrlForTarget() {
  const params = new URLSearchParams(window.location.search);
  const targetId = params.get("chzzk_target");

  if (!targetId) return;

  // 이미 찾아서 강조 표시를 했다면 더 이상 찾지 않음 (성능 최적화)
  // 단, 페이지 이동으로 인해 타겟이 바뀔 수 있으므로 전역 변수와 대조
  if (
    pendingTargetId === targetId &&
    document.querySelector(`.chzzk-target-highlight[id*="${targetId}"]`)
  ) {
    return;
  }

  // 타겟 설정
  pendingTargetId = targetId;

  // (중요) updateDom 안에서 처리하도록 유도하거나, 여기서 직접 DOM을 찾음
  // updateDom은 댓글이 로딩될 때마다 계속 돌기 때문에,
  // 거기서 pendingTargetId를 체크하는 로직이 이미 있다면 이 함수는 변수 세팅만 해줘도 충분합니다.
}

// -- 메시지 수신 핸들러 --
window.addEventListener("message", (event) => {
  // URL 변경 감지 시 초기화
  if (event.data.type === "CHZZK_URL_CHANGED") {
    resetDataAndUI();

    // URL이 바뀌었으니 타겟 ID도 다시 확인해봐야 함
    // (예: 목록에서 다른 댓글을 클릭해서 이동한 경우)
    setTimeout(checkUrlForTarget, 500);
    return;
  }

  if (event.data.type !== "CHZZK_XHR_DATA") return;
  const data = event.data.payload;
  if (!data || !data.content) return;

  if (data.content.bestComments) parseComments(data.content.bestComments);
  if (data.content.comments && data.content.comments.data)
    parseComments(data.content.comments.data);

  scheduleUpdateDom();
});

// --- Observer 실행 ---
function startObserver() {
  if (!document.body) {
    setTimeout(startObserver, 50);
    return;
  }
  const observer = new MutationObserver((mutations) => {
    // 1. DOM 업데이트 (댓글 감지)
    scheduleUpdateDom();

    // 2. 더보기 메뉴 레이어 감지
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        mutation.addedNodes.forEach((node) => {
          // 치지직 댓글 메뉴 레이어 클래스 확인 (comment_item_layer)
          if (
            node.nodeType === 1 &&
            node.classList &&
            node.classList.toString().includes("comment_item_layer")
          ) {
            injectNativeBlockButton(node);
          }
        });
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  scheduleUpdateDom();
}

initBlockedUsers(); // 데이터 로드 시작
checkUrlForTarget();

// '더보기' 버튼 클릭 감지하여 타겟 유저 Hash 저장
document.addEventListener(
  "click",
  (e) => {
    // 더보기 버튼(또는 그 내부 SVG/Path)을 클릭했는지 확인
    const moreBtn = e.target.closest(
      'button[class*="comment_item_button_more"]'
    );

    if (moreBtn) {
      const commentBox = moreBtn.closest('[id^="commentBox-"]');
      if (commentBox) {
        const parts = commentBox.id.split("-");
        const commentId = parts[parts.length - 1];

        // 해시맵에서 UID 찾기
        if (commentHashMap.has(commentId)) {
          currentMenuTargetHash = commentHashMap.get(commentId);
        }
      }
    }
  },
  true
); // 캡처링 단계에서 실행하여 메뉴가 뜨기 직전에 데이터 확보
