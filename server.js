/* CPDF — local web server: serves the app and a small API for tools that need native programs.
 * Usage: node server.js [port] [--open]
 * If the port is busy, the next free one is used. No dependencies beyond Node.js itself.
 *
 * API (only for requests from the CPDF page itself — see isAllowed):
 *   GET  /api/capabilities                    → { server, libreoffice, ghostscript }
 *   POST /api/convert?to=pdf|docx&name=a.docx → converts the request body with LibreOffice
 *   POST /api/gs?op=compress|grayscale|pdfa   → processes the request body (a PDF) with Ghostscript
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec, spawn } = require('child_process');
const { pathToFileURL } = require('url');

const root = __dirname;
const startPort = parseInt(process.argv.find((a) => /^\d+$/.test(a)), 10) || 8000;
const openBrowser = process.argv.includes('--open');
const MAX_BODY = 200 * 1024 * 1024;
const JOB_TIMEOUT = 3 * 60 * 1000;
const isWin = process.platform === 'win32';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
};

/* ---------- Finding native programs ---------- */
function onPath(names) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = isWin ? ['.exe', '.cmd', ''] : [''];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const p = path.join(dir, name + ext);
        try { if (fs.statSync(p).isFile()) return p; } catch (_) { /* keep looking */ }
      }
    }
  }
  return null;
}
const firstExisting = (list) => list.find((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } }) || null;

function findLibreOffice() {
  if (isWin) {
    const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)'].filter(Boolean);
    return firstExisting(pf.map((d) => path.join(d, 'LibreOffice', 'program', 'soffice.exe'))) || onPath(['soffice']);
  }
  if (process.platform === 'darwin') return firstExisting(['/Applications/LibreOffice.app/Contents/MacOS/soffice']) || onPath(['soffice']);
  return onPath(['soffice', 'libreoffice']);
}

function findGhostscript() {
  if (isWin) {
    const found = onPath(['gswin64c', 'gswin32c']);
    if (found) return found;
    for (const base of [process.env.ProgramFiles, 'C:\\Program Files'].filter(Boolean)) {
      const gsDir = path.join(base, 'gs');
      try {
        const versions = fs.readdirSync(gsDir).sort().reverse();
        for (const v of versions) {
          const p = firstExisting([path.join(gsDir, v, 'bin', 'gswin64c.exe'), path.join(gsDir, v, 'bin', 'gswin32c.exe')]);
          if (p) return p;
        }
      } catch (_) { /* not installed here */ }
    }
    return null;
  }
  return onPath(['gs']) || firstExisting(['/opt/homebrew/bin/gs', '/usr/local/bin/gs']);
}

const programs = { libreoffice: findLibreOffice(), ghostscript: findGhostscript() };

/* ---------- Jobs ---------- */
function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Timed out')); }, JOB_TIMEOUT);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(new Error(stderr.trim().split('\n').slice(-3).join(' ') || `Exit code ${code}`));
    });
  });
}

// LibreOffice can only run one conversion per profile at a time, so jobs are queued.
let officeQueue = Promise.resolve();
const loProfile = path.join(os.tmpdir(), 'cpdf-libreoffice-profile');

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpdf-'));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Keeps the original file name (LibreOffice prints it in spreadsheet headers), minus anything unsafe. */
function safeName(name, fallbackExt) {
  const ext = (path.extname(name || '').toLowerCase().match(/^\.[a-z0-9]{1,5}$/) || [fallbackExt])[0];
  const stem = path.basename(name || '', path.extname(name || '')).replace(/[^\p{L}\p{N} ._-]/gu, '_').replace(/^[.\s]+/, '').slice(0, 80);
  return `${stem || 'document'}${ext}`;
}

async function convert(body, to, name) {
  if (!programs.libreoffice) throw Object.assign(new Error('LibreOffice is not installed'), { status: 501 });
  const job = () => withTempDir(async (dir) => {
    const input = path.join(dir, safeName(name, to === 'docx' ? '.pdf' : '.docx'));
    fs.writeFileSync(input, body);
    const args = ['--headless', '--norestore', '--nolockcheck', `-env:UserInstallation=${pathToFileURL(loProfile).href}`];
    const ext = path.extname(input).toLowerCase();
    if (to === 'docx') args.push('--infilter=writer_pdf_import', '--convert-to', 'docx:MS Word 2007 XML');
    else {
      // Plain-text formats default to the system code page; read them as UTF-8 instead.
      if (ext === '.csv') args.push('--infilter=CSV:44,34,76,1');
      else if (ext === '.txt') args.push('--infilter=Text (encoded):UTF8');
      args.push('--convert-to', 'pdf');
    }
    args.push('--outdir', dir, input);
    await run(programs.libreoffice, args, dir);
    const out = path.join(dir, `${path.basename(input, path.extname(input))}.${to}`);
    if (!fs.existsSync(out)) throw new Error('LibreOffice could not convert this file');
    return fs.readFileSync(out);
  });
  const result = officeQueue.then(job, job);
  officeQueue = result.catch(() => {});
  return result;
}

async function ghostscript(body, op, level) {
  if (!programs.ghostscript) throw Object.assign(new Error('Ghostscript is not installed'), { status: 501 });
  return withTempDir(async (dir) => {
    const input = path.join(dir, 'in.pdf'), output = path.join(dir, 'out.pdf');
    fs.writeFileSync(input, body);
    const args = ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-dQUIET', '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.7'];
    if (op === 'compress') args.push(`-dPDFSETTINGS=/${['screen', 'ebook', 'printer', 'prepress'].includes(level) ? level : 'ebook'}`);
    else if (op === 'grayscale') args.push('-sColorConversionStrategy=Gray', '-dProcessColorModel=/DeviceGray', '-dOverrideICC');
    else if (op === 'pdfa') args.push('-dPDFA=2', '-dPDFACompatibilityPolicy=1', '-sColorConversionStrategy=RGB');
    else throw Object.assign(new Error('Unknown operation'), { status: 400 });
    args.push(`-sOutputFile=${output}`, input);
    await run(programs.ghostscript, args, dir);
    return fs.readFileSync(output);
  });
}

/* ---------- HTTP ---------- */
let port = startPort;

// Only the CPDF page may call the API: same host, plus a custom header that other sites
// cannot send without a CORS preflight (which this server never approves).
function isAllowed(req) {
  const host = req.headers.host || '';
  const okHost = host === `localhost:${port}` || host === `127.0.0.1:${port}`;
  const origin = req.headers.origin;
  const okOrigin = !origin || origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`;
  return okHost && okOrigin && req.headers['x-cpdf'] === '1';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('File too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

async function handleApi(req, res, url) {
  if (!isAllowed(req)) return send(res, 403, 'Forbidden');
  const route = url.pathname.slice('/api/'.length);
  try {
    if (route === 'capabilities' && req.method === 'GET') {
      return send(res, 200, JSON.stringify({ server: true, libreoffice: !!programs.libreoffice, ghostscript: !!programs.ghostscript }), 'application/json');
    }
    if (req.method !== 'POST') return send(res, 405, 'Method not allowed');
    const body = await readBody(req);
    if (route === 'convert') {
      const to = url.searchParams.get('to') === 'docx' ? 'docx' : 'pdf';
      const out = await convert(body, to, url.searchParams.get('name'));
      return send(res, 200, out, to === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    }
    if (route === 'gs') {
      return send(res, 200, await ghostscript(body, url.searchParams.get('op'), url.searchParams.get('level')), 'application/pdf');
    }
    return send(res, 404, 'Not found');
  } catch (err) {
    console.error(`  [api] ${route}: ${err.message}`);
    return send(res, err.status || 500, err.message);
  }
}

function serveStatic(req, res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  let file = path.resolve(root, '.' + rel);
  if (file !== root && !file.startsWith(root + path.sep)) return send(res, 403, 'Forbidden');
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');

  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, '404 — Not found');
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) handleApi(req, res, url);
  else serveStatic(req, res, url);
});

function listen(p) {
  port = p;
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && p < startPort + 20) listen(p + 1);
    else { console.error(err.message); process.exit(1); }
  });
  server.listen(p, '127.0.0.1', () => {
    const url = `http://localhost:${p}/`;
    console.log('');
    console.log('  CPDF is running at ' + url);
    console.log('  LibreOffice: ' + (programs.libreoffice || 'not found (Office conversions disabled)'));
    console.log('  Ghostscript: ' + (programs.ghostscript || 'not found (PDF/A and advanced compression disabled)'));
    console.log('  Press Ctrl+C (or close this window) to stop the server.');
    console.log('');
    if (openBrowser) {
      const cmd = isWin ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
      exec(cmd);
    }
  });
}

listen(startPort);
