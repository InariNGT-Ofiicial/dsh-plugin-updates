import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';

export class CheckError extends Error { constructor(code, retryAt = null) { super(code); this.code = code; this.retryAt = retryAt; } }

// Requests stay on api.github.com. A proxy is used only when the operator configures one.
export function requestJson(url, { headers, timeoutMs, proxyUrl = '', signal, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    let agent, request, connectRequest, tunnel, secure, settled = false;
    const finish = (err, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      request?.destroy(); connectRequest?.destroy(); secure?.destroy(); tunnel?.destroy(); agent?.destroy();
      err ? reject(err) : resolve(value);
    };
    const abort = () => finish(new CheckError('CANCELLED'));
    const timer = setTimeout(() => finish(new CheckError('NETWORK_TIMEOUT')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    try {
      const target = new URL(url);
      const hosts=binary?['api.github.com','github.com','codeload.github.com','release-assets.githubusercontent.com','objects.githubusercontent.com']:['api.github.com'];
      if (target.protocol !== 'https:' || !hosts.includes(target.hostname) || target.port || target.username || target.password) throw new CheckError('UNTRUSTED_API_URL');
      if (proxyUrl) {
        const proxy = new URL(proxyUrl);
        if (!['http:', 'https:'].includes(proxy.protocol)) throw new CheckError('INVALID_PROXY');
        agent = new https.Agent({ keepAlive: false });
        agent.createConnection = (_options, callback) => {
          const proxyHeaders = { Host: `${target.hostname}:443` };
          if (proxy.username || proxy.password) proxyHeaders['Proxy-Authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
          connectRequest = (proxy.protocol === 'https:' ? https : http).request({ hostname: proxy.hostname, port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80), method: 'CONNECT', path: `${target.hostname}:443`, headers: proxyHeaders });
          connectRequest.once('connect', (res, socket, head) => {
            tunnel = socket;
            if (res.statusCode !== 200) { callback(new CheckError('PROXY_CONNECT_FAILED')); return; }
            if (head.length) socket.unshift(head);
            secure = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: true });
            secure.once('secureConnect', () => callback(null, secure));
            secure.once('error', () => finish(new CheckError('NETWORK_ERROR')));
          });
          connectRequest.once('error', () => callback(new CheckError('PROXY_CONNECT_FAILED')));
          connectRequest.end();
        };
      }
      request = https.get(target, { headers, agent }, res => {
        const chunks = []; let size = 0;
        res.on('data', chunk => { size += chunk.length; if (size > (binary ? 25 : 1) * 1024 * 1024) finish(new CheckError('RESPONSE_TOO_LARGE')); else chunks.push(chunk); });
        res.once('error', () => finish(new CheckError('NETWORK_ERROR')));
        res.once('end', () => {
          let data = null;
          if (res.statusCode === 200) {
            try { data = binary ? Buffer.concat(chunks) : JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { finish(new CheckError('INVALID_GITHUB_RESPONSE')); return; }
          }
          finish(null, { status: res.statusCode, headers: res.headers, data });
        });
      });
      request.once('error', () => finish(new CheckError('NETWORK_ERROR')));
    } catch (e) { finish(e instanceof CheckError ? e : new CheckError('NETWORK_ERROR')); }
  });
}

export class GitHubClient {
  constructor({ state = {}, token = '', timeoutMs = 12000, proxyUrl = '', signal, maxRequests = 40, request = requestJson, now = () => Date.now() } = {}) {
    this.state = state; this.state.cache ||= {}; this.token = token; this.timeoutMs = timeoutMs; this.proxyUrl = proxyUrl; this.signal = signal; this.remaining = maxRequests; this.request = request; this.now = now; this.inflight = new Map(); this.requests = 0;
  }
  get(path, { refresh = false, redirects = 0 } = {}) {
    const key = `${refresh}:${path}`;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const promise = this._get(path, { refresh, redirects });
    this.inflight.set(key, promise); return promise;
  }
  async _get(path, { refresh, redirects }) {
    if (!path.startsWith('/repos/') || path.includes('://') || /[\r\n]/.test(path)) throw new CheckError('UNTRUSTED_API_URL');
    const cached = this.state.cache[path];
    if (!refresh && cached && this.now() - cached.time < 15 * 60 * 1000) return cached.data;
    if (this.state.blockedUntil > this.now()) throw new CheckError('GITHUB_RATE_LIMIT', this.state.blockedUntil);
    if (this.remaining-- <= 0) throw new CheckError('REQUEST_BUDGET_EXHAUSTED');
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'dsh-plugin-updates/0.2.1' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (cached?.etag) headers['If-None-Match'] = cached.etag;
    this.requests++;
    const response = await this.request(`https://api.github.com${path}`, { headers, timeoutMs: this.timeoutMs, proxyUrl: this.proxyUrl, signal: this.signal });
    const h = response.headers || {};
    if (h['x-ratelimit-remaining'] === '0') this.state.blockedUntil = Math.max(this.now() + 60000, Number(h['x-ratelimit-reset'] || 0) * 1000);
    if ([301, 302, 307, 308].includes(response.status)) {
      let location; try { location = new URL(h.location); } catch {}
      if (redirects >= 3 || !location || location.origin !== 'https://api.github.com') throw new CheckError('UNTRUSTED_REDIRECT');
      return this._get(location.pathname + location.search, { refresh, redirects: redirects + 1 });
    }
    if (response.status === 304 && cached) { cached.time = this.now(); return cached.data; }
    if (response.status === 404) return null;
    if ([403,429].includes(response.status)) {
      // Also respect secondary limits; do not keep hammering the next plugin.
      const retry = Number(h['retry-after']);
      this.state.blockedUntil = Math.max(this.state.blockedUntil || 0, this.now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : 300000));
      throw new CheckError('GITHUB_RATE_LIMIT_OR_FORBIDDEN', this.state.blockedUntil);
    }
    if (response.status === 401) throw new CheckError('GITHUB_AUTH_FAILED');
    if (response.status !== 200) throw new CheckError(`GITHUB_HTTP_${Number(response.status) || 0}`);
    this.state.cache[path] = { time: this.now(), etag: h.etag || '', data: response.data };
    return response.data;
  }
}
