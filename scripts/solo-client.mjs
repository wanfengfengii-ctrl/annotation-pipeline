// Uses the same documented-by-the-deployed-frontend routes as SOLO-QA.
// Cookies never enter pipeline records, command arguments, or output logs.
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  chmodSync,
  lstatSync,
} from 'node:fs';
import path from 'node:path';

export const SOLO_ORIGIN = 'https://solo2.jzxhnh.com';

export function savePrivateJSON(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.tmp-' + process.pid;
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temp, file);
  chmodSync(file, 0o600);
}

export function readAuthentication(file) {
  const st = lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.mode & 0o077)
    throw Error('SOLO 登录文件必须是仅当前用户可读写的普通文件');
  const auth = JSON.parse(readFileSync(file, 'utf8'));
  if (auth.origin !== SOLO_ORIGIN || !Array.isArray(auth.cookies))
    throw Error('SOLO 登录配置无效');
  return auth;
}

export class SoloError extends Error {
  constructor(message, { status = 0, uncertain = false, fields = [] } = {}) {
    super(message);
    this.status = status;
    this.uncertain = uncertain;
    this.fields = fields;
  }
}

export class SoloClient {
  constructor({
    auth = { origin: SOLO_ORIGIN, cookies: [] },
    fetchImpl = fetch,
    saveAuth = () => {},
    timeout = 45000,
  } = {}) {
    if (auth.origin !== SOLO_ORIGIN) throw Error('上传目标必须为 SOLO-QA');
    this.auth = auth;
    this.fetch = fetchImpl;
    this.saveAuth = saveAuth;
    this.timeout = timeout;
  }

  async request(route, { method = 'GET', json, file } = {}) {
    if (
      !route.startsWith('/') ||
      route.startsWith('//') ||
      route.includes('..')
    )
      throw Error('SOLO 接口路径无效');
    const mutation = method !== 'GET';
    const valid = this.auth.cookies.filter(
      (c) => !c.expiresAt || c.expiresAt > Date.now(),
    );
    const headers = { Accept: 'application/json', Origin: SOLO_ORIGIN };
    if (valid.length)
      headers.Cookie = valid.map((c) => c.name + '=' + c.value).join('; ');
    const csrf = valid.find((c) => c.name === 'solo_qa_csrf');
    if (mutation && csrf)
      headers['X-CSRF-Token'] = decodeURIComponent(csrf.value);
    let body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (file) {
      body = new FormData();
      body.append(
        'file',
        new Blob([file.bytes], { type: 'application/zip' }),
        file.name,
      );
    }
    let response;
    try {
      response = await this.fetch(SOLO_ORIGIN + '/api/v1' + route, {
        method,
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch {
      throw new SoloError('SOLO 请求未收到明确回执', { uncertain: mutation });
    }
    for (const line of response.headers.getSetCookie?.() || []) {
      const [pair, ...attributes] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      const cookie = {
        name: pair.slice(0, eq).trim(),
        value: pair.slice(eq + 1),
      };
      for (const item of attributes) {
        const [key, ...parts] = item.trim().split('=');
        if (key.toLowerCase() === 'max-age')
          cookie.expiresAt = Date.now() + Number(parts.join('=')) * 1000;
        if (key.toLowerCase() === 'expires' && !cookie.expiresAt)
          cookie.expiresAt = Date.parse(parts.join('='));
      }
      if (!/^[\w-]+$/.test(cookie.name) || /[\r\n;]/.test(cookie.value))
        continue;
      this.auth.cookies = this.auth.cookies.filter(
        (c) => c.name !== cookie.name,
      );
      if (!cookie.expiresAt || cookie.expiresAt > Date.now())
        this.auth.cookies.push(cookie);
    }
    this.saveAuth(this.auth);
    let data;
    try {
      data = await response.json();
    } catch {
      throw new SoloError('SOLO 返回了无法核验的响应', {
        status: response.status,
        uncertain: mutation,
      });
    }
    if (!response.ok) {
      // Do not persist the server body, which can echo submitted values.
      throw new SoloError(
        response.status === 401
          ? 'SOLO 登录已过期，请重新登录'
          : `SOLO 请求失败（${response.status}）`,
        {
          status: response.status,
          uncertain:
            mutation && (response.status >= 500 || response.status === 408),
          fields: (data.errors || [])
            .map((e) => e.field)
            .filter((x) => typeof x === 'string'),
        },
      );
    }
    return data;
  }

  async login(username, password) {
    const result = await this.request('/auth/login', {
      method: 'POST',
      json: { username, password },
    });
    if (!result.user?.id) throw Error('SOLO 登录响应缺少账号身份');
    this.auth.userId = result.user.id;
    this.saveAuth(this.auth);
    return this.me();
  }

  async me() {
    const user = await this.request('/auth/me');
    if (!user.id || user.must_change_password)
      throw Error('请先在 SOLO 网页完成首次密码修改');
    if (this.auth.userId && String(user.id) !== String(this.auth.userId))
      throw Error('SOLO 登录账号发生变化');
    this.auth.userId = user.id;
    this.saveAuth(this.auth);
    return user;
  }
  schema() {
    return this.request('/submissions/form-schema');
  }
  detail(id) {
    if (!/^\d+$/.test(String(id))) throw Error('远端记录编号无效');
    return this.request('/submissions/' + id);
  }
  list(params) {
    return this.request('/submissions?' + new URLSearchParams(params));
  }
  upload(file) {
    return this.request('/submissions/upload', { method: 'POST', file });
  }
  create(payload) {
    return this.request('/submissions', { method: 'POST', json: payload });
  }
}
