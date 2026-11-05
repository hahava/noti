import { ensureSchema, pool, upsertPreissuedUser, type UserRole } from "./db.js";

async function main() {
  const [username, password, ...restParts] = process.argv.slice(2);
  if (!username || !password) {
    console.error("사용법: npm run user:issue -- <아이디> <비밀번호> [표시이름] [admin|editor|viewer]");
    console.error("예시:   npm run user:issue -- alice secret1234 \"Alice Kim\" admin");
    process.exit(1);
  }

  let role: UserRole = "editor";
  const lastArg = restParts[restParts.length - 1]?.toLowerCase();
  if (lastArg === "admin" || lastArg === "editor" || lastArg === "viewer" || lastArg === "user") {
    role = lastArg === "user" ? "editor" : lastArg;
    restParts.pop();
  }

  const displayName = restParts.join(" ").trim() || username;
  await ensureSchema();
  const user = await upsertPreissuedUser(username, password, displayName, role);
  console.log(
    `[계정 발급 완료] 아이디: ${user.username} | 이름: ${user.displayName} | 권한: ${user.role} | ID: ${user.id}`,
  );
  await pool.end();
}

main().catch((error) => {
  console.error("[계정 발급 실패]", error);
  process.exit(1);
});
