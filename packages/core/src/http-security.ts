/**
 * 운영에서 쓰는 HTTP 보호 장치.
 * - CORS: CORS_ALLOWED_ORIGINS 가 비어 있으면 예전처럼 모든 출처를 허용(개발용)하고,
 *   값이 있으면 그 출처와 Electron 앱(file:// → Origin: null)만 허용한다.
 * - 로그인 시도 제한: 같은 아이디 또는 같은 IP 에서 연달아 틀리면 잠시 막는다.
 */

export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/** 응답에 넣을 Access-Control-Allow-Origin 값. 허용하지 않으면 null. */
export function resolveAllowedOrigin(origin: string | undefined, allowed: string[]): string | null {
  if (allowed.length === 0) return "*";
  if (!origin) return null; // 같은 출처 요청이나 브라우저가 아닌 클라이언트는 CORS 헤더가 필요 없다.
  if (origin === "null") return "null"; // Electron(file://)
  return allowed.includes(origin.replace(/\/+$/, "")) ? origin : null;
}

type Attempt = { failures: number; firstAt: number; blockedUntil: number };

export class LoginThrottle {
  private attempts = new Map<string, Attempt>();

  constructor(
    private readonly maxFailures = 8,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly blockMs = 15 * 60 * 1000,
  ) {}

  private keys(username: string, ip: string): string[] {
    return [`u:${username.trim().toLowerCase()}`, `ip:${ip}`];
  }

  /** 막혀 있으면 다시 시도할 수 있을 때까지 남은 초, 아니면 0. */
  retryAfterSeconds(username: string, ip: string, now = Date.now()): number {
    let until = 0;
    for (const key of this.keys(username, ip)) {
      const attempt = this.attempts.get(key);
      if (attempt && attempt.blockedUntil > now) until = Math.max(until, attempt.blockedUntil);
    }
    return until ? Math.ceil((until - now) / 1000) : 0;
  }

  recordFailure(username: string, ip: string, now = Date.now()): void {
    for (const key of this.keys(username, ip)) {
      const current = this.attempts.get(key);
      const attempt = !current || now - current.firstAt > this.windowMs ? { failures: 0, firstAt: now, blockedUntil: 0 } : current;
      attempt.failures += 1;
      // IP 는 여러 사람이 같이 쓸 수 있어(공유기, 프록시) 조금 더 너그럽게 본다.
      const limit = key.startsWith("ip:") ? this.maxFailures * 3 : this.maxFailures;
      if (attempt.failures >= limit) attempt.blockedUntil = now + this.blockMs;
      this.attempts.set(key, attempt);
    }
    this.prune(now);
  }

  recordSuccess(username: string, ip: string): void {
    this.attempts.delete(this.keys(username, ip)[0]);
  }

  private prune(now: number): void {
    if (this.attempts.size < 5000) return;
    for (const [key, attempt] of this.attempts) {
      if (attempt.blockedUntil < now && now - attempt.firstAt > this.windowMs) this.attempts.delete(key);
    }
  }
}
