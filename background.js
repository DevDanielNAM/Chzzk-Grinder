chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 1. 이미지 다운로드 요청을 받으면 실행
  if (
    request.type === "DOWNLOAD_IMAGE" ||
    request.type === "DOWNLOAD_PDF" ||
    request.type === "DOWNLOAD_CSV"
  ) {
    chrome.downloads.download({
      url: request.dataUrl, // content.js가 보낸 이미지 데이터
      filename: request.filename, // 저장할 파일명
      saveAs: true, // 장 위치 묻는 창 띄우기 (True)
    });
  }
});

// 2. 설치 및 업데이트 감지 리스너
chrome.runtime.onInstalled.addListener(async (details) => {
  // 설치(install) 되거나 업데이트(update) 되었을 때 실행
  if (details.reason === "install" || details.reason === "update") {
    // 현재 열려있는 치지직 탭들을 모두 찾음
    const tabs = await chrome.tabs.query({
      url: [
        "https://chzzk.naver.com/*/community/*",
        "https://chzzk.naver.com/video/*",
        "https://chzzk.naver.com/live/*",
      ],
    });

    // 각 탭에 배너 띄우는 함수를 강제로 주입하여 실행
    for (const tab of tabs) {
      chrome.scripting
        .executeScript({
          target: { tabId: tab.id },
          func: showUpdateNotificationBanner, // 아래 정의된 함수를 페이지 안에서 실행
        })
        .catch((err) => {
          // 탭이 로딩 중이거나 닫히는 중일 때 발생하는 에러 무시
          // console.log(err);
        });
    }
  }
});

// 3. 페이지에 주입될 배너 생성 함수
function showUpdateNotificationBanner() {
  // 이미 배너가 있다면 중복 생성 방지
  if (document.getElementById("chzzk-grinder-ext-update-banner")) {
    return;
  }

  const banner = document.createElement("div");
  banner.id = "chzzk-grinder-ext-update-banner";

  // 스타일 설정
  banner.style.cssText = `
    display: flex;
    align-items: center;
    justify-content: center;
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 50px;
    background-color: #772ce8;
    color: white;
    text-align: center;
    font-size: 14px;
    z-index: 2147483647; /* 최상단 보장 (최댓값) */
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    transform: translateY(-100%);
    transition: transform 0.5s cubic-bezier(0.19, 1, 0.22, 1);
  `;

  const wrapper = document.createElement("div");
  wrapper.style.cssText = `
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 15px;
  `;

  const message = document.createElement("span");
  message.innerText =
    "🚀 치즈 그라인더 확장 프로그램이 업데이트 되었습니다. 원활한 사용을 위해 새로고침 해주세요.";
  message.style.fontWeight = "500";

  const refreshButton = document.createElement("button");
  refreshButton.innerText = "새로고침";
  refreshButton.style.cssText = `
    background-color: #00ffa3;
    color: #121212;
    border: none;
    border-radius: 4px;
    padding: 6px 12px;
    font-weight: 800;
    cursor: pointer;
    font-size: 13px;
    transition: filter 0.2s;
  `;

  refreshButton.onmouseover = () => {
    refreshButton.style.filter = "brightness(0.9)";
  };
  refreshButton.onmouseout = () => {
    refreshButton.style.filter = "brightness(1)";
  };

  refreshButton.onclick = () => {
    banner.style.transform = "translateY(-100%)";
    setTimeout(() => location.reload(), 200);
  };

  const closeButton = document.createElement("span");
  closeButton.innerText = "×";
  closeButton.style.cssText = `
    cursor: pointer;
    font-size: 24px;
    font-weight: bold;
    margin-left: 20px;
    opacity: 0.8;
    line-height: 1;
  `;
  closeButton.onmouseover = () => {
    closeButton.style.opacity = "1";
  };
  closeButton.onmouseout = () => {
    closeButton.style.opacity = "0.8";
  };

  closeButton.onclick = () => {
    banner.style.transform = "translateY(-100%)";
    setTimeout(() => banner.remove(), 500);
  };

  wrapper.appendChild(message);
  wrapper.appendChild(refreshButton);
  banner.appendChild(wrapper);
  banner.appendChild(closeButton);

  document.body.appendChild(banner);

  // 애니메이션 실행
  setTimeout(() => {
    banner.style.transform = "translateY(0)";
  }, 100);
}
