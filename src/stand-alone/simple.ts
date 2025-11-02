import Koa, { Context } from 'koa';
import bodyParser from '@koa/bodyparser';
import koaCompress from 'koa-compress';
import TurndownService from 'turndown';
import { Readability } from '@mozilla/readability';
import puppeteer from 'puppeteer';
import { request } from 'undici';
import path from 'path';

// Simple in-memory rate limiter: 20 req/min per IP
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 1000;
const buckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(ip: string): { ok: boolean; retryAfter?: number } {
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { ok: true };
  }
  if (bucket.count < RATE_LIMIT) {
    bucket.count += 1;
    return { ok: true };
  }
  return { ok: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
}

async function htmlToMarkdown(url: URL, html: string): Promise<string> {
  // Try Readability first using linkedom
  const { parseHTML } = await import('linkedom');
  let contentHtml = html;
  try {
    let dom = parseHTML(html);
    if (!dom.window.document.documentElement) {
      dom = parseHTML(`<html><body>${html}</body></html>`);
    }
    // Patch minimal API surface like in project jsdom.ts
    Object.defineProperty(dom.window.document.documentElement, 'cloneNode', { value: function () { return this; } });
    const reader = new Readability(dom.window.document as any);
    const parsed = reader.parse();
    if (parsed?.content && parsed.content.length > 0) {
      contentHtml = parsed.content;
    }
  } catch {
    // fall back to whole HTML
  }
  const td = new TurndownService({ codeBlockStyle: 'fenced', preformattedCode: true } as any);
  return td.turndown(contentHtml).trim();
}

async function fetchPageHtml(target: URL): Promise<{ html: string; contentType?: string }>{
  // Prefer puppeteer for dynamic pages. If it fails quickly, fall back to undici
  const browser = await puppeteer.launch({
    timeout: 15000,
    headless: !Boolean(process.env.DEBUG_BROWSER),
    executablePath: process.env.OVERRIDE_CHROME_EXECUTABLE_PATH,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent((await browser.userAgent()).replace(/Headless/i, ''));
    await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const html = await page.content();
    return { html, contentType: 'text/html' };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function fetchIfPdf(target: URL): Promise<undefined | Uint8Array> {
  try {
    const r = await request(target.toString(), { method: 'GET' });
    const ct = r.headers['content-type'] as string | undefined;
    if (ct && ct.toLowerCase().includes('application/pdf')) {
      const arr = new Uint8Array(await r.body.arrayBuffer());
      return arr;
    }
  } catch {
    // ignore
  }
  return undefined;
}

async function pdfToMarkdown(data: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data, disableFontFace: true, verbosity: 0, cMapUrl: path.resolve(require.resolve('pdfjs-dist'), '../../cmaps') + '/' }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const textContent = await page.getTextContent({ includeMarkedContent: true });
    const lines: string[] = [];
    for (const item of textContent.items as any[]) {
      lines.push((item.str || ''));
      if (item.hasEOL) lines.push('\n');
    }
    const txt = lines.join('');
    parts.push(`\n\n# Page ${i}\n\n${txt}`);
  }
  return parts.join('').trim();
}

function parseUrl(input?: string): URL {
  if (!input) throw new Error('No URL provided');
  const trimmed = input.trim();
  if (URL.canParse(trimmed)) return new URL(trimmed);
  // Support encoded path like /https://...
  const maybe = decodeURIComponent(trimmed);
  if (URL.canParse(maybe)) return new URL(maybe);
  throw new Error('Invalid URL');
}

async function handleFetchToMarkdown(target: URL): Promise<string> {
  // PDF first
  const maybePdf = await fetchIfPdf(target);
  if (maybePdf) {
    return await pdfToMarkdown(maybePdf);
  }
  const { html } = await fetchPageHtml(target);
  return await htmlToMarkdown(target, html);
}

export async function createServer() {
  const app = new Koa();
  app.use(koaCompress());
  app.use(bodyParser({ encoding: 'utf-8', jsonLimit: '10mb', formLimit: '10mb' } as any));

  // GET /
  app.use(async (ctx: Context, next) => {
    if (ctx.method === 'GET' && (ctx.path === '/' || ctx.path === '')) {
      ctx.type = 'text/plain; charset=utf-8';
      ctx.body = 'Usage: GET /{URL} or POST / with {"url":"..."}';
      return;
    }
    await next();
  });

  // GET /{URL}
  app.use(async (ctx: Context, next) => {
    if (ctx.method === 'GET' && ctx.path.length > 1) {
      const rl = rateLimit(ctx.ip);
      if (!rl.ok) {
        ctx.status = 429;
        ctx.set('Retry-After', String(rl.retryAfter || 60));
        ctx.body = 'Rate limit exceeded';
        return;
      }
      const raw = ctx.path.slice(1);
      let target: URL;
      try { target = parseUrl(raw); } catch { ctx.throw(400, 'Invalid URL'); return; }
      const md = await handleFetchToMarkdown(target);
      ctx.type = 'text/plain; charset=utf-8';
      ctx.body = md + (md.endsWith('\n') ? '' : '\n');
      return;
    }
    await next();
  });

  // POST /
  app.use(async (ctx: Context, next) => {
    if (ctx.method === 'POST' && ctx.path === '/') {
      const rl = rateLimit(ctx.ip);
      if (!rl.ok) {
        ctx.status = 429;
        ctx.set('Retry-After', String(rl.retryAfter || 60));
        ctx.body = 'Rate limit exceeded';
        return;
      }
      const url = (ctx.request.body as any)?.url || ctx.request.body;
      let target: URL;
      try { target = parseUrl(typeof url === 'string' ? url : ''); } catch { ctx.throw(400, 'Invalid URL'); return; }
      const md = await handleFetchToMarkdown(target);
      ctx.type = 'text/plain; charset=utf-8';
      ctx.body = md + (md.endsWith('\n') ? '' : '\n');
      return;
    }
    await next();
  });

  const port = parseInt(process.env.PORT || '8080', 10);
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Reader listening on :${port}`);
  });

  return app;
}

if (require.main === module) {
  createServer();
}
