// UPA PortWise(울산항만공사 선박운항 정보공유 서비스) 공개 엔드포인트 중계 클라이언트.
// 원본 화면(https://www.upa.or.kr/portwise/vsl/)이 브라우저에서 호출하는 *.do 엔드포인트를
// 서버에서 대신 호출한다(브라우저 직접 호출은 CORS로 막힘). 로그인 없이 열리는 엔드포인트만 쓴다.

export const UPA_BASE = 'https://www.upa.or.kr/portwise/vsl';
const UA = 'Mozilla/5.0 (compatible; SK-PortWise-Relay/1.0)';
const SESSION_TTL_MS = 20 * 60 * 1000;

export class UpstreamError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

let sessionCookie = '';
let sessionAt = 0;
let sessionPending = null;

async function ensureSession(force) {
  if (!force && sessionCookie && Date.now() - sessionAt < SESSION_TTL_MS) return;
  if (!sessionPending) {
    sessionPending = (async () => {
      const res = await fetch(`${UPA_BASE}/`, {
        headers: { 'User-Agent': UA },
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
      await res.arrayBuffer();
      sessionCookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
      sessionAt = Date.now();
    })().finally(() => {
      sessionPending = null;
    });
  }
  await sessionPending;
}

/**
 * PortWise 엔드포인트 POST 호출.
 * @param {string} path  `/cmm/init/getWharf.do` 형태 (쿼리스트링 포함 가능)
 * @param {{form?: Record<string, string|number>, json?: unknown, timeoutMs?: number}} [opts]
 */
export async function upaPost(path, { form, json, timeoutMs = 25000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    await ensureSession(attempt > 0);
    const headers = {
      'User-Agent': UA,
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      Referer: `${UPA_BASE}/`,
    };
    if (sessionCookie) headers.Cookie = sessionCookie;
    let body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      body = new URLSearchParams(
        Object.entries(form ?? {}).map(([k, v]) => [k, String(v)]),
      ).toString();
    }
    let res;
    try {
      res = await fetch(`${UPA_BASE}${path}`, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastError = new UpstreamError(`${path}: ${err.message}`, 502);
      continue;
    }
    const text = await res.text();
    // 세션 만료 시 로그인 페이지로 302 → 세션 재발급 후 1회 재시도
    if (res.status >= 300 && res.status < 400) {
      lastError = new UpstreamError(`${path}: redirected (${res.status})`, 502);
      continue;
    }
    if (!res.ok) {
      lastError = new UpstreamError(`${path}: HTTP ${res.status}`, 502);
      continue;
    }
    try {
      return JSON.parse(text);
    } catch {
      lastError = new UpstreamError(`${path}: non-JSON response`, 502);
    }
  }
  throw lastError;
}

// ── TTL 캐시 (동시 요청 합치기 + 실패 시 직전 값 제공) ───────────────────────────
const cache = new Map();

/**
 * @template T
 * @param {string} key
 * @param {number} ttlMs
 * @param {() => Promise<T>} load
 * @returns {Promise<{value: T, fetchedAt: number, stale: boolean, error?: string}>}
 */
export async function cached(key, ttlMs, load) {
  const now = Date.now();
  let entry = cache.get(key);
  if (entry?.value !== undefined && now - entry.fetchedAt < ttlMs) {
    return { value: entry.value, fetchedAt: entry.fetchedAt, stale: false };
  }
  if (!entry) {
    entry = { value: undefined, fetchedAt: 0, pending: null };
    cache.set(key, entry);
  }
  if (!entry.pending) {
    entry.pending = load()
      .then((value) => {
        entry.value = value;
        entry.fetchedAt = Date.now();
      })
      .finally(() => {
        entry.pending = null;
      });
  }
  try {
    await entry.pending;
    return { value: entry.value, fetchedAt: entry.fetchedAt, stale: false };
  } catch (err) {
    if (entry.value !== undefined) {
      return { value: entry.value, fetchedAt: entry.fetchedAt, stale: true, error: err.message };
    }
    throw err;
  }
}
