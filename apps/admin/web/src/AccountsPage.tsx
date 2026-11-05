import { useEffect, useState, type FormEvent } from "react";
import { adminApi, type AdminUser, type ManagedUser, type UserRole } from "./api";

const ROLE_LABELS: Record<UserRole, string> = {
  admin: "관리자",
  editor: "편집자",
  viewer: "읽기 전용",
};

const ROLE_HELP: Record<UserRole, string> = {
  admin: "모든 페이지 편집 + 어드민 접속",
  editor: "모든 페이지 보기·편집",
  viewer: "보기와 AI 질문만 (수정·이동·삭제 불가)",
};

function formatDate(value: string | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function CreateUserForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("editor");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button type="button" className="btn btn--primary" onClick={() => setOpen(true)}>
        계정 추가
      </button>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await adminApi.createUser({ username, displayName, password, role });
      setUsername("");
      setDisplayName("");
      setPassword("");
      setRole("editor");
      setOpen(false);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "계정을 만들지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card create-user" onSubmit={submit}>
      <h3>새 계정</h3>
      <div className="grid-2">
        <label className="field">
          <span>아이디</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="영문 소문자·숫자" required />
        </label>
        <label className="field">
          <span>표시 이름</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="비우면 아이디" />
        </label>
        <label className="field">
          <span>초기 비밀번호</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="8자 이상" required autoComplete="new-password" />
        </label>
        <label className="field">
          <span>역할</span>
          <select value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            {(Object.keys(ROLE_LABELS) as UserRole[]).map((value) => (
              <option key={value} value={value}>
                {ROLE_LABELS[value]} — {ROLE_HELP[value]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <div className="alert alert--error">{error}</div>}
      <div className="actions">
        <button type="button" className="btn btn--ghost" onClick={() => setOpen(false)}>
          취소
        </button>
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? "만드는 중…" : "만들기"}
        </button>
      </div>
    </form>
  );
}

function UserRow({
  user,
  users,
  currentUser,
  onChanged,
  onMessage,
}: {
  user: ManagedUser;
  users: ManagedUser[];
  currentUser: AdminUser;
  onChanged: () => void;
  onMessage: (message: { ok: boolean; text: string }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const isSelf = user.id === currentUser.id;

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    try {
      onMessage({ ok: true, text: await action() });
      onChanged();
    } catch (err) {
      onMessage({ ok: false, text: err instanceof Error ? err.message : "요청에 실패했습니다." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className={user.disabled ? "row--disabled" : ""}>
      <td>
        <strong>{user.displayName}</strong>
        <div className="muted">
          @{user.username}
          {isSelf ? " · 나" : ""}
        </div>
      </td>
      <td>
        <select
          value={user.role}
          disabled={busy || isSelf}
          title={isSelf ? "자기 역할은 바꿀 수 없습니다" : ROLE_HELP[user.role]}
          onChange={(e) => {
            const role = e.target.value as UserRole;
            void run(async () => {
              await adminApi.updateUser(user.id, { role });
              return `${user.displayName}의 역할을 ${ROLE_LABELS[role]}(으)로 바꿨습니다.`;
            });
          }}
        >
          {(Object.keys(ROLE_LABELS) as UserRole[]).map((value) => (
            <option key={value} value={value}>
              {ROLE_LABELS[value]}
            </option>
          ))}
        </select>
      </td>
      <td>
        <span className={`badge ${user.disabled ? "badge--off" : "badge--on"}`}>{user.disabled ? "비활성" : "활성"}</span>
      </td>
      <td className="muted">{formatDate(user.lastLoginAt)}</td>
      <td className="num">{user.activeSessions}</td>
      <td className="num">{user.pageCount}</td>
      <td>
        <div className="row-actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy || isSelf}
            onClick={() =>
              void run(async () => {
                await adminApi.updateUser(user.id, { disabled: !user.disabled });
                return user.disabled ? `${user.displayName}을(를) 다시 활성화했습니다.` : `${user.displayName}을(를) 비활성화하고 로그인을 끊었습니다.`;
              })
            }
          >
            {user.disabled ? "활성화" : "비활성화"}
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy}
            onClick={() => {
              const password = window.prompt(`${user.displayName}의 새 비밀번호 (8자 이상). 기존 로그인은 모두 끊깁니다.`);
              if (!password) return;
              void run(async () => {
                await adminApi.resetPassword(user.id, password);
                return `${user.displayName}의 비밀번호를 바꿨습니다.`;
              });
            }}
          >
            비밀번호
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy || isSelf || user.activeSessions === 0}
            onClick={() =>
              void run(async () => {
                const { revoked } = await adminApi.revokeSessions(user.id);
                return `${user.displayName}의 로그인 ${revoked}개를 끊었습니다.`;
              })
            }
          >
            로그아웃시키기
          </button>
          <button
            type="button"
            className="btn btn--danger btn--sm"
            disabled={busy || isSelf}
            onClick={() => {
              const candidates = users.filter((other) => other.id !== user.id && !other.disabled);
              const transferName = window.prompt(
                `${user.displayName} 계정을 삭제합니다. 이 계정이 만든 페이지 ${user.pageCount}개를 넘겨받을 계정의 아이디를 입력하세요.\n후보: ${candidates.map((c) => c.username).join(", ")}`,
                currentUser.username,
              );
              if (!transferName) return;
              const target = candidates.find((c) => c.username === transferName.trim());
              if (!target) {
                onMessage({ ok: false, text: "넘겨받을 계정을 찾을 수 없습니다." });
                return;
              }
              void run(async () => {
                const { transferredPages } = await adminApi.deleteUser(user.id, target.id);
                return `${user.displayName} 계정을 삭제하고 페이지 ${transferredPages}개를 ${target.displayName}에게 넘겼습니다.`;
              });
            }}
          >
            삭제
          </button>
        </div>
      </td>
    </tr>
  );
}

export function AccountsPage({ currentUser }: { currentUser: AdminUser }) {
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () =>
    adminApi
      .listUsers()
      .then((res) => setUsers(res.users))
      .catch((err) => setMessage({ ok: false, text: err.message }));

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="stack">
      <div className="toolbar">
        <div className="muted">
          관리자 {users?.filter((u) => u.role === "admin" && !u.disabled).length ?? 0} · 편집자{" "}
          {users?.filter((u) => u.role === "editor" && !u.disabled).length ?? 0} · 읽기 전용{" "}
          {users?.filter((u) => u.role === "viewer" && !u.disabled).length ?? 0}
        </div>
        <CreateUserForm onCreated={() => void load()} />
      </div>
      {message && <div className={`alert ${message.ok ? "alert--ok" : "alert--error"}`}>{message.text}</div>}
      <div className="card card--flush">
        <table className="table">
          <thead>
            <tr>
              <th>계정</th>
              <th>역할</th>
              <th>상태</th>
              <th>마지막 로그인</th>
              <th className="num">세션</th>
              <th className="num">페이지</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users?.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                users={users}
                currentUser={currentUser}
                onChanged={() => void load()}
                onMessage={setMessage}
              />
            ))}
          </tbody>
        </table>
        {!users && <div className="muted pad">불러오는 중…</div>}
      </div>
      <p className="muted">
        읽기 전용 계정은 페이지를 보고 AI에게 질문할 수 있지만, 페이지 만들기·수정·이동·삭제와 실시간 편집은 서버에서 막힙니다. 마지막 남은
        관리자는 역할 변경·비활성화·삭제할 수 없습니다.
      </p>
    </div>
  );
}
