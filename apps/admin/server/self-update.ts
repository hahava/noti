import { ADMIN_CONTAINER, replaceContainer, staysRunning } from "./upgrade.js";

/**
 * 업데이트 마지막 단계: 어드민이 띄운 보조 컨테이너에서 실행되어 어드민 컨테이너를 새 이미지로 바꾼다.
 * (실행 중인 어드민은 자기 컨테이너를 지우면 함께 꺼지므로 스스로 바꿀 수 없다.)
 * 새 어드민이 뜨지 않으면 이전 어드민을 다시 살린다. 이 컨테이너는 끝나면 자동으로 지워진다.
 */
async function main() {
  const image = process.env.NOTY_UPDATE_IMAGE;
  if (!image) throw new Error("NOTY_UPDATE_IMAGE 가 없습니다.");
  // 어드민이 "교체 시작" 응답을 화면에 보낼 시간을 준다.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await replaceContainer(ADMIN_CONTAINER, image, () => staysRunning(ADMIN_CONTAINER), (line) => console.log(`[self-update] ${line}`), {
    NOTY_APP_IMAGE: image,
  });
}

main().catch((error) => {
  console.error("[self-update] 실패:", error);
  process.exit(1);
});
