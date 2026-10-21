import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { createHash } from 'node:crypto';
import { brotliCompress, gzip, constants } from 'node:zlib';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';

const brotli = promisify(brotliCompress);
const zip = promisify(gzip);

// One budget for static downloads and large HTTP replies on both server ports.
// Do not accumulate idle credit: a new visitor must not trigger a large burst.
export function createPacedSender({ bytesPerSecond = 256 * 1024, chunkBytes = 4096, maximum = 128 } = {}) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 16384) throw new Error('网页发送速率必须至少为 16384 字节/秒');
  const jobs = []; let timer; let nextAt = 0; let closed = false;
  function schedule() {
    if (!timer && jobs.length && !closed) timer = setTimeout(pump, Math.max(1, Math.ceil(nextAt - performance.now())));
  }
  function finish(job, ok) {
    const index = jobs.indexOf(job); if (index >= 0) jobs.splice(index, 1);
    job.response.off('close', job.cancel); job.response.off('error', job.cancel); job.response.off('drain', schedule);
    job.accept(ok);
    if (!jobs.length) { clearTimeout(timer); timer = undefined; }
  }
  function pump() {
    timer = undefined;
    for (let count = jobs.length; count > 0; count--) {
      const job = jobs.shift(); jobs.push(job);
      if (job.response.destroyed || job.response.writableEnded) { finish(job, false); continue; }
      if (job.response.writableNeedDrain) continue;
      const chunk = job.content.subarray(job.offset, job.offset + chunkBytes);
      job.offset += chunk.length;
      nextAt = performance.now() + chunk.length / bytesPerSecond * 1000;
      try {
        job.response.write(chunk);
        if (job.offset === job.content.length) { job.response.end(); finish(job, true); }
      } catch { job.response.destroy(); finish(job, false); }
      schedule(); return;
    }
    if (jobs.length) { nextAt = performance.now() + 25; schedule(); }
  }
  return {
    send(response, content) {
      if (closed || jobs.length >= maximum) {
        response.removeHeader('Content-Length'); response.removeHeader('Content-Encoding');
        response.writeHead(503, { 'Cache-Control': 'no-store', 'Retry-After': '2' }); response.end(); return Promise.resolve(false);
      }
      if (!content.length) { response.end(); return Promise.resolve(true); }
      return new Promise(accept => {
        const job = { response, content, offset: 0, accept };
        job.cancel = () => finish(job, false);
        jobs.push(job); response.once('close', job.cancel); response.once('error', job.cancel); response.on('drain', schedule); schedule();
      });
    },
    close() { closed = true; clearTimeout(timer); timer = undefined; for (const job of [...jobs]) { job.response.destroy(); finish(job, false); } }
  };
}

export const staticDelivery = createPacedSender({ bytesPerSecond: Number(process.env.TSMD_WEB_BYTES_PER_SECOND || 256 * 1024) });

export function sendJson(response, status, body, headers, extra = {}) {
  const content = Buffer.from(JSON.stringify(body));
  response.statusCode = status;
  for (const [name, value] of Object.entries({ ...headers, 'Content-Type': 'application/json', ...extra, 'Content-Length': content.length })) response.setHeader(name, value);
  // Small commands and authorization responses stay immediate. Large queues and
  // playlist details use the same budget as page assets instead of bursting.
  if (content.length > 16384) return staticDelivery.send(response, content).catch(() => response.destroy());
  response.end(content);
}

function quality(header, encoding) {
  const values = new Map(String(header || '').toLowerCase().split(',').map(part => {
    const [name, ...options] = part.trim().split(';');
    const q = options.find(option => option.trim().startsWith('q='));
    const value = q ? Number(q.trim().slice(2)) : 1;
    return [name, Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0];
  }));
  return values.get(encoding) ?? values.get('*') ?? 0;
}

export function createStaticResponder({ headers, mime, transformHtml = content => content, sender = staticDelivery }) {
  const cache = new Map();
  async function load(file) {
    if (!cache.has(file)) {
      const pending = (async () => {
        let raw = await readFile(file);
        if (extname(file) === '.html') raw = Buffer.from(transformHtml(raw.toString()));
        const variants = { identity: raw };
        if (/\.(?:js|mjs|css|html|svg)$/.test(file) && raw.length >= 512) {
          const [br, gz] = await Promise.all([brotli(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }), zip(raw)]);
          if (br.length < raw.length) variants.br = br;
          if (gz.length < raw.length) variants.gzip = gz;
        }
        return Object.fromEntries(Object.entries(variants).map(([encoding, content]) => [encoding, {
          content, etag: '"' + createHash('sha256').update(content).digest('base64url') + '"'
        }]));
      })();
      cache.set(file, pending);
      pending.catch(() => cache.delete(file));
      if (cache.size > 64) cache.delete(cache.keys().next().value);
    }
    return cache.get(file);
  }
  return async (request, response, file) => {
    const variants = await load(file);
    const accepted = request.headers['accept-encoding'];
    const encoding = ['br', 'gzip'].filter(name => variants[name] && quality(accepted, name) > 0)
      .sort((a, b) => quality(accepted, b) - quality(accepted, a))[0] || 'identity';
    const { content, etag } = variants[encoding];
    const html = extname(file) === '.html';
    const immutable = /[/\\]assets[/\\][^/\\]+-[\w-]{8,}\.(?:js|css)$/.test(file);
    const extra = {
      ...headers, 'Content-Type': mime[extname(file)] || 'application/octet-stream',
      'Cache-Control': html ? 'no-store' : immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
      Vary: 'Accept-Encoding', ETag: etag,
      ...(encoding !== 'identity' ? { 'Content-Encoding': encoding } : {})
    };
    if (!html && String(request.headers['if-none-match'] || '').split(',').some(value => value.trim().replace(/^W\//, '') === etag || value.trim() === '*')) {
      response.writeHead(304, extra); response.end(); return;
    }
    // Headers are committed by the first paced write, so overload can still return 503.
    for (const [name, value] of Object.entries({ ...extra, 'Content-Length': content.length })) response.setHeader(name, value);
    if (request.method === 'HEAD') { response.end(); return; }
    await sender.send(response, content);
  };
}

// Queue and playlist catalog are sent once, then only when their contents change.
// Fingerprints are strings so mutable service objects cannot alter the baseline.
export function stateFrame(state, previous, delta = false) {
  const fields = new Map(); const playerFields = new Map(); const patch = {}; const player = {};
  const full = !delta || !previous || previous.runId !== state.runId;
  for (const [key, value] of Object.entries(state)) {
    if (key === 'player') continue;
    const normalized = value === undefined ? null : value;
    const encoded = JSON.stringify(normalized); fields.set(key, encoded);
    if (full || previous.fields.get(key) !== encoded) patch[key] = normalized;
  }
  for (const [key, value] of Object.entries(state.player || {})) {
    const normalized = value === undefined ? null : value;
    const encoded = JSON.stringify(normalized); playerFields.set(key, encoded);
    if (full || previous.playerFields.get(key) !== encoded) player[key] = normalized;
  }
  // Explicit nulls clear fields removed by a new snapshot.
  if (!full) {
    for (const key of previous.fields.keys()) if (!fields.has(key)) patch[key] = null;
    for (const key of previous.playerFields.keys()) if (!playerFields.has(key)) player[key] = null;
  }
  if (full || Object.keys(player).length) patch.player = player;
  return {
    previous: { runId: state.runId, fields, playerFields },
    payload: Object.keys(patch).length ? JSON.stringify({ type: 'state', state: patch, ...(full ? {} : { partial: true }) }) : null
  };
}
