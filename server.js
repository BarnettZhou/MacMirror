import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8787);
const HTTPS_KEY = process.env.HTTPS_KEY;
const HTTPS_CERT = process.env.HTTPS_CERT;
const DISPLAY_BACKEND = String(process.env.DISPLAY_BACKEND || 'betterdisplay').toLowerCase();
const BETTER_DISPLAY = process.env.BETTER_DISPLAY || '/Applications/BetterDisplay.app/Contents/MacOS/BetterDisplay';
const VIRTUAL_DISPLAY_CTL_CANDIDATES = [
  '/Applications/VirtualDisplay.app/Contents/MacOS/vdctl',
  '/tmp/VirtualDisplay-derived-app/Build/Products/Debug/VirtualDisplay.app/Contents/MacOS/vdctl',
];
const VIRTUAL_DISPLAY_CTL = process.env.VIRTUAL_DISPLAY_CTL
  || VIRTUAL_DISPLAY_CTL_CANDIDATES.find(existsSync)
  || VIRTUAL_DISPLAY_CTL_CANDIDATES[0];
const DISPLAY_NAME = DISPLAY_BACKEND === 'virtualdisplay' ? 'VirtualDisplay' : 'LANMirror';
if (!['betterdisplay', 'virtualdisplay'].includes(DISPLAY_BACKEND)) {
  throw new Error(`Unsupported DISPLAY_BACKEND: ${DISPLAY_BACKEND}. Use betterdisplay or virtualdisplay.`);
}
const code = String(randomInt(1000, 10000));
let active = null;
let virtualDisplay = null;
let captureProcess = null;
let caffeinateProcess = null;
const RESOLUTIONS = ['1280x720', '1600x900', '1920x1080'];

function runFile(file, args, options = {}) {
  return new Promise((resolve, reject) => execFile(file, args, { timeout: 15_000, ...options }, (error, stdout, stderr) =>
    error ? reject(new Error((stderr || stdout || error.message).trim())) : resolve(stdout)));
}
function vd(args) {
  if (!existsSync(VIRTUAL_DISPLAY_CTL)) {
    return Promise.reject(new Error(`vdctl not found at ${VIRTUAL_DISPLAY_CTL}; install VirtualDisplay.app or set VIRTUAL_DISPLAY_CTL to its vdctl path`));
  }
  return runFile(VIRTUAL_DISPLAY_CTL, args);
}
function bd(args) {
  return new Promise((resolve, reject) => execFile(BETTER_DISPLAY, args, { timeout: 10_000 }, (error, stdout, stderr) =>
    error ? reject(new Error(stderr || error.message)) : resolve(stdout)));
}
async function findBetterDisplay() {
  const displays = parseJsonObjects(await bd(['get', '-identifiers']));
  return displays.find(item => item.deviceType === 'VirtualScreen' && item.name === 'LANMirror')
    ?? displays.find(item => item.deviceType === 'VirtualScreen' && item.name === 'LANMirrorTest');
}
async function virtualStatus() {
  const parsed = JSON.parse(await vd(['status']));
  return parsed.displays?.find(item => item.name === DISPLAY_NAME) ?? null;
}
async function virtualPresets() {
  return JSON.parse(await vd(['list', 'presets', DISPLAY_NAME]));
}
async function systemDisplayByName(name) {
  const output = JSON.parse(await runFile('/usr/sbin/system_profiler', ['SPDisplaysDataType', '-json']));
  const rows = output.SPDisplaysDataType?.flatMap(item => item.spdisplays_ndrvs || []) || [];
  const row = rows.find(item => item._name === name);
  if (!row) return null;
  const rawID = row._spdisplays_displayID;
  const displayID = rawID == null ? null : parseInt(String(rawID).replace(/^0x/i, ''), 16);
  const resolution = String(row._spdisplays_resolution || '').match(/(\d+)\s*x\s*(\d+)/);
  const pixels = String(row._spdisplays_pixels || '').match(/(\d+)\s*x\s*(\d+)/);
  return { name, displayID, connected: row.spdisplays_online === 'spdisplays_yes', resolution: resolution ? `${resolution[1]}x${resolution[2]}` : undefined, pixelWidth: pixels ? Number(pixels[1]) : undefined, pixelHeight: pixels ? Number(pixels[2]) : undefined };
}
function parseDisplayModes(output) {
  return output.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*(\d+)\s*-\s*(\d+)x(\d+)\b(.*)$/);
    if (!match || /\bUnsafe\b/i.test(match[4])) return [];
    return [{ mode: Number(match[1]), resolution: `${match[2]}x${match[3]}`, hiDPI: /\bHiDPI\b/i.test(match[4]), current: /\bCurrent\b/i.test(match[4]) }];
  });
}
async function readBetterDisplayModes() {
  return parseDisplayModes(await bd(['get', '-name=LANMirror', '-displayModeList']));
}
async function readDisplayModes() {
  if (DISPLAY_BACKEND === 'betterdisplay') return readBetterDisplayModes();
  const presets = await virtualPresets();
  return presets.filter(preset => preset.current).map(preset => ({
    presetID: preset.id,
    resolution: `${Math.round(preset.width / 2)}x${Math.round(preset.height / 2)}`,
    physicalResolution: `${preset.width}x${preset.height}`,
    hiDPI: true,
    current: true,
    refreshRate: preset.refreshRate,
  }));
}
async function readDisplayMode() {
  try { return (await readDisplayModes()).find(mode => mode.current) ?? null; } catch { return null; }
}
async function refreshBetterDisplay() {
  const display = await findBetterDisplay();
  if (!display) { virtualDisplay = null; return null; }
  virtualDisplay = { backend: DISPLAY_BACKEND, name: display.name, displayID: display.displayID, UUID: display.UUID, tagID: display.tagID, connected: Boolean(display.displayID && display.displayID !== '0'), ...(await readDisplayMode() ?? {}) };
  return virtualDisplay;
}
async function refreshVirtualDisplay() {
  const status = await virtualStatus();
  const systemDisplay = await systemDisplayByName(DISPLAY_NAME).catch(() => null);
  if (!status) { virtualDisplay = null; return null; }
  const mode = await readDisplayMode();
  virtualDisplay = { backend: DISPLAY_BACKEND, name: DISPLAY_NAME, displayID: systemDisplay?.displayID, connected: Boolean(status.online && systemDisplay?.displayID != null), ...(mode ?? {}) };
  return virtualDisplay;
}
async function refreshDisplay() {
  return DISPLAY_BACKEND === 'betterdisplay' ? refreshBetterDisplay() : refreshVirtualDisplay();
}
async function ensureDisplay() {
  if (virtualDisplay?.connected) return virtualDisplay;
  try {
    if (DISPLAY_BACKEND === 'virtualdisplay') {
      let status = await virtualStatus();
      if (!status) {
        await vd(['add', 'display', DISPLAY_NAME]);
        status = await virtualStatus();
      }
      if (!status) throw new Error('VirtualDisplay 中没有名为 VirtualDisplay 的显示器');
      if (!status.enabled) await vd(['toggle', 'display', DISPLAY_NAME]);
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 250));
        const current = await refreshVirtualDisplay();
        if (current?.connected) return current;
      }
      throw new Error('VirtualDisplay 未上线或没有可用的 macOS display ID');
    }
    let display = await findBetterDisplay();
    if (!display) {
      await bd(['create', '-deviceType=virtualScreen', '-virtualScreenName=LANMirror', '-aspectWidth=16', '-aspectHeight=9', '-useResolutionList=on', '-resolutionList=1280x720,1600x900,1920x1080', '-virtualScreenHiDPI=on']);
      display = await findBetterDisplay();
      if (!display) throw new Error('BetterDisplay did not create LANMirror');
    }
    const selectedTag = display.tagID;
    if (!display.displayID || display.displayID === '0') {
      await bd(['set', '-name=LANMirror', '-connected=on']);
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 250));
        display = await findBetterDisplay();
        if (display?.tagID === selectedTag && display.displayID && display.displayID !== '0') break;
      }
    }
    if (!display?.displayID || display.displayID === '0') throw new Error('LANMirror has no active macOS display ID');
    const displays = parseJsonObjects(await bd(['get', '-identifiers']));
    for (const duplicate of displays.filter(item => item.deviceType === 'VirtualScreen' && ['LANMirror', 'LANMirrorTest'].includes(item.name) && item.tagID !== display.tagID)) {
      await bd(['discard', `-tagID=${duplicate.tagID}`]).catch(error => console.error(`Could not discard duplicate LANMirror ${duplicate.tagID}: ${error.message}`));
    }
    return await refreshBetterDisplay();
  } catch (error) {
    console.error(`${DISPLAY_BACKEND} unavailable: ${error.message}`);
    return null;
  }
}
function startKeepAwake() {
  if (caffeinateProcess || process.platform !== 'darwin') return;
  // Keep the Mac (including its virtual display) awake while a client is connected.
  caffeinateProcess = spawn('caffeinate', ['-dimsu'], { stdio: 'ignore' });
  caffeinateProcess.once('error', error => console.error(`caffeinate failed: ${error.message}`));
  caffeinateProcess.once('exit', () => { caffeinateProcess = null; });
}
function stopKeepAwake() {
  if (!caffeinateProcess) return;
  caffeinateProcess.kill('SIGTERM');
  caffeinateProcess = null;
}

async function stopCapture() {
  const child = captureProcess;
  if (!child) return;
  captureProcess = null;
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1500);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}
async function configureDisplay(settings) {
  const { connected, resolution } = settings;
  if (connected !== undefined && typeof connected !== 'boolean') throw new Error('connected must be a boolean');
  if (resolution === undefined && connected === undefined) throw new Error('No display setting provided');
  if (connected === false) {
    await stopCapture();
    stopKeepAwake();
    if (DISPLAY_BACKEND === 'betterdisplay') {
      await bd(['set', '-name=LANMirror', '-connected=off']);
    } else {
      const status = await virtualStatus();
      if (status?.enabled) await vd(['toggle', 'display', DISPLAY_NAME]);
    }
    active?.socket.close(4000, 'Virtual display disabled by administrator');
    active = null;
    return await refreshDisplay();
  }

  let display = await refreshDisplay();
  if ((!display || !display.connected) && connected === true) display = await ensureDisplay();
  if (!display) throw new Error(`${DISPLAY_NAME} virtual display not found`);
  const wasConnected = Boolean(display.connected);
  const shouldCapture = Boolean(active?.authenticated && wasConnected);
  await stopCapture();
  try {
    if (connected === true && !wasConnected) {
      if (DISPLAY_BACKEND === 'betterdisplay') await bd(['set', '-name=LANMirror', '-connected=on']);
      else {
        const status = await virtualStatus();
        if (status && !status.enabled) await vd(['toggle', 'display', DISPLAY_NAME]);
      }
    }
    let requestedMode;
    if (resolution !== undefined) {
      const modes = await readDisplayModes();
      requestedMode = modes.find(item => item.resolution === resolution && item.hiDPI) ?? modes.find(item => item.resolution === resolution);
      if (!requestedMode) throw new Error(`${DISPLAY_BACKEND} has no display mode for ${resolution}`);
      if (DISPLAY_BACKEND === 'betterdisplay') await bd(['set', '-name=LANMirror', `-displayModeNumber=${requestedMode.mode}`]);
      else await vd(['activate', 'preset', DISPLAY_NAME, requestedMode.presetID]);
    }
    virtualDisplay = null;
    let updated = connected === true ? await ensureDisplay() : await refreshDisplay();
    if (resolution !== undefined) {
      for (let attempt = 0; attempt < 8 && (updated?.resolution !== resolution || (requestedMode?.hiDPI && !updated?.hiDPI)); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 250));
        updated = await refreshDisplay();
      }
      if (updated?.resolution !== resolution || (requestedMode?.hiDPI && !updated?.hiDPI)) {
        throw new Error(`${DISPLAY_BACKEND} did not apply ${resolution}; current mode is ${updated?.resolution ?? 'unknown'}`);
      }
    }
    if (shouldCapture && updated?.connected) startCapture();
    return updated;
  } catch (error) {
    virtualDisplay = null;
    const current = await refreshDisplay().catch(() => null);
    if (shouldCapture && current?.connected) startCapture();
    throw error;
  }
}
function parseJsonObjects(text) {
  const objects = [];
  let start = -1, depth = 0, inString = false, escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') inString = false; continue; }
    if (char === '"') { inString = true; continue; }
    if (char === '{') { if (depth === 0) start = i; depth += 1; }
    if (char === '}' && depth > 0 && --depth === 0) { try { objects.push(JSON.parse(text.slice(start, i + 1))); } catch {} }
  }
  return objects;
}
function startCapture() {
  if (!virtualDisplay?.displayID || captureProcess) return;
  captureProcess = spawn(fileURLToPath(new URL('./.build/debug/MirrorCapture', import.meta.url)), [virtualDisplay.displayID], { stdio: ['ignore', 'pipe', 'pipe'] });
  captureProcess.on('error', error => { console.error(`Capture helper failed: ${error.message}`); active?.socket.send(JSON.stringify({ type: 'capture-error', message: error.message })); });
  let pending = Buffer.alloc(0);
  captureProcess.stdout.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const size = pending.readUInt32BE(0);
      if (size === 0 || size > 16 * 1024 * 1024) {
        pending = pending.subarray(4);
        continue;
      }
      if (pending.length < size + 4) break;
      const frame = pending.subarray(4, size + 4);
      pending = pending.subarray(size + 4);
      if (!active?.authenticated || active.socket.readyState !== 1) continue;
      // Bound latency: do not enqueue more frames while the network/client is behind.
      if (active.socket.bufferedAmount > Math.max(frame.length * 2, 512 * 1024)) {
        active.droppedFrames = (active.droppedFrames ?? 0) + 1;
        continue;
      }
      active.socket.send(frame, error => {
        if (error) console.error(`WebSocket frame send failed: ${error.message}`);
      });
    }
  });
  captureProcess.stderr.on('data', chunk => {
    const message = chunk.toString().trim();
    console.error(message);
    if (message) active?.socket.send(JSON.stringify({ type: 'capture-error', message }));
  });
  captureProcess.on('exit', () => { captureProcess = null; });
}
function json(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
const requestHandler = async (req, res) => {
  if (req.url === '/api/status') {
    if (!virtualDisplay) await refreshDisplay().catch(() => {});
    let resolutions = RESOLUTIONS;
    let backendError = null;
    if (DISPLAY_BACKEND === 'virtualdisplay') {
      try { resolutions = (await readDisplayModes()).map(mode => mode.resolution); }
      catch (error) { resolutions = []; backendError = error.message; }
    }
    return json(res, { code, backend: DISPLAY_BACKEND, backendError, connected: !!active, device: active?.device ?? null, droppedFrames: active?.droppedFrames ?? 0, virtualDisplay, resolutions });
  }
  if (req.url === '/api/display' && req.method === 'POST') {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const settings = JSON.parse(body || '{}');
      const display = await configureDisplay(settings);
      return json(res, { ok: true, virtualDisplay: display });
    } catch (error) { return json(res, { ok: false, error: error.message }, 400); }
  }
  if (req.url === '/api/disconnect' && req.method === 'POST') {
    if (active) {
      active.socket.close(4000, 'Disconnected by administrator');
      active = null;
      stopCapture();
      stopKeepAwake();
    }
    return json(res, { ok: true });
  }
  const file = req.url === '/client' ? 'client.html' : 'admin.html';
  try { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(await readFile(new URL(`./public/${file}`, import.meta.url))); }
  catch { res.writeHead(404); res.end('Not found'); }
};
const useHttps = Boolean(HTTPS_KEY && HTTPS_CERT);
const server = useHttps
  ? https.createServer({ key: readFileSync(HTTPS_KEY), cert: readFileSync(HTTPS_CERT) }, requestHandler)
  : http.createServer(requestHandler);
const wss = new WebSocketServer({ server, path: '/socket' });
wss.on('connection', (socket, req) => {
  if (active) return socket.close(4001, 'Another device is already connected');
  active = { socket, authenticated: false, device: { address: req.socket.remoteAddress, connectedAt: new Date().toISOString() } };
  socket.on('message', async raw => {
    let message; try { message = JSON.parse(raw); } catch { return socket.close(4002, 'Invalid message'); }
    if (!active?.authenticated) {
      if (message.type !== 'auth' || message.code !== code) return socket.send(JSON.stringify({ type: 'auth', ok: false }));
      active.authenticated = true;
      const display = await ensureDisplay();
      if (!display) return socket.send(JSON.stringify({ type: 'auth', ok: true, display: null, error: `${DISPLAY_BACKEND} 虚拟屏不可用，请检查服务端日志。` }));
      startKeepAwake();
      startCapture();
      return socket.send(JSON.stringify({ type: 'auth', ok: true, display }));
    }
  });
  socket.on('close', () => {
    if (active?.socket === socket) {
      active = null;
      stopCapture();
      stopKeepAwake();
    }
  });
});
server.listen(PORT, '0.0.0.0', () => {
  const protocol = useHttps ? 'https' : 'http';
  console.log(`LAN Mirror: ${protocol}://localhost:${PORT}  pairing code: ${code}`);
  console.log(`Display backend: ${DISPLAY_BACKEND}`);
  if (useHttps) console.log('Wake Lock can work when the client browser trusts the certificate.');
});
