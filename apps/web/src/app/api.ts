// Same-origin JSON client. State-changing requests carry the session's CSRF token; the session cookie
// is HttpOnly and never visible here.
export class ApiError extends Error {
  readonly status: number;
  readonly body: { error?: string; message?: string; field?: string | null; errors?: { code: string; message: string }[]; missing?: string[]; reasons?: string[] } | null;
  constructor(status: number, body: ApiError['body']) {
    super(body?.message ?? body?.error ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

let csrf = '';
function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: 'bad_response' };
  }
}
export const setCsrf = (token: string) => { csrf = token; };

export async function api<T>(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown): Promise<T> {
  const unsafe = method !== 'GET';
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { ...(unsafe ? { 'content-type': 'application/json', 'x-pw-csrf': csrf } : {}) },
    body: unsafe ? JSON.stringify(body ?? {}) : undefined,
  });
  const text = await res.text();
  const data = parseJson(text);
  if (!res.ok) throw new ApiError(res.status, data as ApiError['body']);
  return data as T;
}

// A raw body (e.g. a PDF original), with the CSRF token; the answer is JSON.
export async function apiRaw<T>(url: string, body: Blob, contentType: string): Promise<T> {
  const res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': contentType, 'x-pw-csrf': csrf }, body });
  const data = parseJson(await res.text());
  if (!res.ok) throw new ApiError(res.status, data as ApiError['body']);
  return data as T;
}

export const errorText = (e: unknown) => (e instanceof ApiError ? `${e.message}${e.body?.missing ? ` (${e.body.missing.join(', ')})` : ''}` : e instanceof Error ? e.message : String(e));
