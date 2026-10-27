import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createPairingCode } from './lib/pairing.js';

const PORT = Number(process.env.PORT || 8787);
const HTTPS_KEY = process.env.HTTPS_KEY;
const HTTPS_CERT = process.env.HTTPS_CERT;
const VIRTUAL_DISPLAY_CTL_CANDIDATES = [
  '/Applications/VirtualDisplay.app/Contents/MacOS/vdctl',
  '/tmp/VirtualDisplay-derived-app/Build/Products/Debug/VirtualDisplay.app/Contents/MacOS/vdctl',
];
const VIRTUAL_DISPLAY_CTL = process.env.VIRTUAL_DISPLAY_CTL
  || VIRTUAL_DISPLAY_CTL_CANDIDATES.find(existsSync)
  || VIRTUAL_DISPLAY_CTL_CANDIDATES[0];
const derivedAppPath = resolve(dirname(VIRTUAL_DISPLAY_CTL), '../..');
const VIRTUAL_DISPLAY_APP = process.env.VIRTUAL_DISPLAY_APP
  || (derivedAppPath.endsWith('.app') ? derivedAppPath : '');
const MIRROR_CAPTURE = fileURLToPath(new URL('./.build/debug/MirrorCapture', import.meta.url));
const MIRROR_DISPLAY_CTL = fileURLToPath(new URL('./.build/debug/MirrorDisplayCtl', import.meta.url));
const DISPLAY_NAME = 'VirtualDisplay';

async function launchVirtualDisplayApp() {
  if (process.platform !== 'darwin') return;
  if (!VIRTUAL_DISPLAY_APP || !existsSync(VIRTUAL_DISPLAY_APP)) {
    console.warn(`VirtualDisplay.app not found${VIRTUAL_DISPLAY_APP ? ` at ${VIRTUAL_DISPLAY_APP}` : ''}; install it or set VIRTUAL_DISPLAY_APP.`);
    return;
  }
  const running = await new Promise(done => execFile('pgrep', ['-x', 'VirtualDisplay'], error => done(!error)));
  if (running) {
    console.log('VirtualDisplay.app is already running');
    return;
  }
  await new Promise(done => execFile('open', ['-gj', VIRTUAL_DISPLAY_APP], error => {
    if (error) console.error(`Could not launch VirtualDisplay.app: ${error.message}`);
    else console.log(`VirtualDisplay.app launch requested: ${VIRTUAL_DISPLAY_APP}`);
    done();
  }));
}
launchVirtualDisplayApp().catch(error => console.error(`VirtualDisplay.app launch failed: ${error.message}`));

let code = createPairingCode();
const STREAM_QUALITIES = {
  original: { quality: '0.72', maxPixelWidth: '0', bitrate: '15000' },
  balanced: { quality: '0.6', maxPixelWidth: '2560', bitrate: '8000' },
  smooth: { quality: '0.45', maxPixelWidth: '1920', bitrate: '4000' },
};
let streamQuality = 'original';
let active = null;
let virtualDisplay = null;
let captureProcess = null;
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
async function readDisplayModes() {
  const presets = await virtualPresets();
  return presets.map(preset => ({
    presetID: preset.id,
    resolution: `${Math.round(preset.width / 2)}x${Math.round(preset.height / 2)}`,
    physicalResolution: `${preset.width}x${preset.height}`,
    hiDPI: true,
    current: Boolean(preset.current),
    refreshRate: preset.refreshRate,
  }));
}
async function refreshVirtualDisplay() {
  const status = await virtualStatus();
  const systemDisplay = await systemDisplayByName(DISPLAY_NAME).catch(() => null);
  if (!status) { virtualDisplay = null; return null; }
  // 分辨率以 vdctl status 里的实际 CG 模式为准（预设 activate 不会改变当前模式）
  virtualDisplay = { backend: 'virtualdisplay', name: DISPLAY_NAME, displayID: systemDisplay?.displayID, connected: Boolean(status.online && systemDisplay?.displayID != null), resolution: `${status.logicalWidth}x${status.logicalHeight}`, physicalResolution: `${status.physicalWidth}x${status.physicalHeight}`, hiDPI: true, refreshRate: status.refreshRate, presetID: status.currentPresetID ?? undefined };
  return virtualDisplay;
}
async function refreshDisplay() {
  return refreshVirtualDisplay();
}
async function ensureDisplay() {
  if (virtualDisplay?.connected) {
    // 缓存的 displayID 可能已失效（显示器重建后 ID 会变），先刷新确认
    const fresh = await refreshDisplay().catch(() => null);
    if (fresh?.connected) return fresh;
    virtualDisplay = null;
  }
  try {
    let status = await virtualStatus();
    if (!status) {
      await vd(['add', 'display', DISPLAY_NAME]);
      status = await virtualStatus();
    }
    if (!status) throw new Error('VirtualDisplay 中没有名为 VirtualDisplay 的显示器');
    if (!status.enabled) await vd(['toggle', 'display', DISPLAY_NAME]);
    // CGVirtualDisplay 在本机需要数秒到十余秒才会被 WindowServer 上线；若 App 持有的是
    // WindowServer 重启前的失效对象，开关一次强制其重建。
    let forcedRecreate = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const current = await refreshVirtualDisplay();
      if (current?.connected) return current;
      if (!forcedRecreate && attempt === 11) {
        forcedRecreate = true;
        const latest = await virtualStatus();
        if (latest?.enabled) {
          await vd(['toggle', 'display', DISPLAY_NAME]).catch(() => {});
          await new Promise(resolve => setTimeout(resolve, 1500));
          await vd(['toggle', 'display', DISPLAY_NAME]).catch(() => {});
        }
      }
    }
    throw new Error('VirtualDisplay 未上线或没有可用的 macOS display ID');
  } catch (error) {
    console.error(`VirtualDisplay unavailable: ${error.message}`);
    return null;
  }
}
// 不在这里做任何 Mac 端保活（caffeinate）：远程观看不应改变本机自身的息屏/睡眠策略。
// 需要屏幕常亮的是客户端，由 public/client.html 的 Screen Wake Lock 负责。

async function stopCapture() {
  const child = captureProcess;
  if (!child) return;
  captureProcess = null;
  child.intentionalStop = true;
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1500);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}
let captureRecovering = false;
async function recoverCapture() {
  if (captureRecovering) return;
  captureRecovering = true;
  try {
    // 显示器重建（切换预设、WindowServer 重启等）期间采集会退出；等新 displayID 出现后自动重启
    for (let attempt = 0; attempt < 20 && active?.authenticated && !captureProcess; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const display = await refreshDisplay().catch(() => null);
      if (display?.connected && display.displayID) { startCapture(); return; }
    }
  } finally { captureRecovering = false; }
}
function probeDisplay(displayID) {
  return new Promise(resolve => execFile(MIRROR_DISPLAY_CTL, ['probe', String(displayID)], { timeout: 5000 }, error => {
    if (!error) return resolve(true);
    if (error.code === 3) return resolve(false);
    resolve(true);
  }));
}
// 看门狗：CGVirtualDisplay 被重建后旧 displayID 失效，但采集进程不会报错也不会退出，
// 只是静默停帧。定期探测 displayID 是否还在线，失效则重启采集。
function startDisplayWatchdog() {
  if (displayWatchdog) return;
  displayWatchdog = setInterval(async () => {
    if (!active?.authenticated || !captureProcess || !virtualDisplay?.displayID) return;
    if (await probeDisplay(virtualDisplay.displayID)) return;
    console.error('Virtual display was rebuilt; restarting capture');
    await stopCapture();
    recoverCapture();
  }, 3000);
}
let displayWatchdog = null;
async function configureDisplay(settings) {
  const { connected, resolution, quality } = settings;
  if (connected !== undefined && typeof connected !== 'boolean') throw new Error('connected must be a boolean');
  if (quality !== undefined && !(quality in STREAM_QUALITIES)) throw new Error(`quality must be one of: ${Object.keys(STREAM_QUALITIES).join(', ')}`);
  if (resolution === undefined && connected === undefined && quality === undefined) throw new Error('No display setting provided');
  if (quality !== undefined) {
    const changed = quality !== streamQuality;
    streamQuality = quality;
    if (changed && captureProcess) { await stopCapture(); startCapture(); }
    if (resolution === undefined && connected === undefined) return await refreshDisplay();
  }
  if (connected === false) {
    await stopCapture();
    const status = await virtualStatus();
    if (status?.enabled) await vd(['toggle', 'display', DISPLAY_NAME]);
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
      const status = await virtualStatus();
      if (status && !status.enabled) await vd(['toggle', 'display', DISPLAY_NAME]);
    }
    let requestedMode;
    if (resolution !== undefined) {
      const modes = await readDisplayModes();
      requestedMode = modes.find(item => item.resolution === resolution && item.hiDPI) ?? modes.find(item => item.resolution === resolution);
      if (!requestedMode) throw new Error(`VirtualDisplay has no display mode for ${resolution}`);
      // vdctl activate preset 只改变 CGVirtualDisplay 的模式列表，不会切换 macOS 当前模式；
      // 等 App 应用列表后，用 MirrorDisplayCtl 强制切换当前模式。
      await vd(['activate', 'preset', DISPLAY_NAME, requestedMode.presetID]);
      let applied = false;
      let lastError = null;
      for (let attempt = 0; attempt < 10 && !applied; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const current = await refreshVirtualDisplay().catch(() => null);
        if (!current?.displayID) continue;
        try {
          await runFile(MIRROR_DISPLAY_CTL, ['set', String(current.displayID), resolution]);
          applied = true;
        } catch (error) { lastError = error; }
      }
      if (!applied) throw new Error(`无法切换到 ${resolution}：${lastError?.message ?? '显示器未就绪'}`);
    }
    virtualDisplay = null;
    let updated = connected === true ? await ensureDisplay() : await refreshDisplay();
    if (resolution !== undefined) {
      for (let attempt = 0; attempt < 8 && (updated?.resolution !== resolution || (requestedMode?.hiDPI && !updated?.hiDPI)); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 250));
        updated = await refreshDisplay();
      }
      if (updated?.resolution !== resolution || (requestedMode?.hiDPI && !updated?.hiDPI)) {
        throw new Error(`VirtualDisplay did not apply ${resolution}; current mode is ${updated?.resolution ?? 'unknown'}`);
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
function startCapture() {
  if (!virtualDisplay?.displayID || captureProcess) return;
  const preset = STREAM_QUALITIES[streamQuality] ?? STREAM_QUALITIES.original;
  const codec = active?.codec ?? 'jpeg';
  const child = spawn(MIRROR_CAPTURE, [String(virtualDisplay.displayID), preset.quality, preset.maxPixelWidth, codec, preset.bitrate], { stdio: ['ignore', 'pipe', 'pipe'] });
  captureProcess = child;
  child.on('error', error => { console.error(`Capture helper failed: ${error.message}`); active?.socket.send(JSON.stringify({ type: 'capture-error', message: error.message })); });
  let pending = Buffer.alloc(0);
  child.stdout.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    // 帧协议：[payloadLength(4)][captureMs(8)][encodeMs(4)][flags(1)][payload]，转发时剥掉长度前缀
    while (pending.length >= 4) {
      const size = pending.readUInt32BE(0);
      if (size === 0 || size > 16 * 1024 * 1024) {
        pending = pending.subarray(4);
        continue;
      }
      if (pending.length < size + 17) break;
      const frame = pending.subarray(4, size + 17);
      pending = pending.subarray(size + 17);
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
  child.stderr.on('data', chunk => {
    const message = chunk.toString().trim();
    console.error(message);
    // 每 300 帧的编码统计是常规日志，不是错误，不推给客户端
    if (message && !/^MirrorCapture: \d+ frames/.test(message)) active?.socket.send(JSON.stringify({ type: 'capture-error', message }));
  });
  child.on('close', () => {
    if (captureProcess === child) captureProcess = null;
    // 非主动停止（如显示器重建后 displayID 失效）且客户端还在：自动恢复采集
    if (!child.intentionalStop && active?.authenticated) recoverCapture();
  });
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
    try { resolutions = (await readDisplayModes()).map(mode => mode.resolution); }
    catch (error) { resolutions = []; backendError = error.message; }
    return json(res, { code, backend: 'virtualdisplay', backendError, connected: !!active, device: active?.device ?? null, droppedFrames: active?.droppedFrames ?? 0, virtualDisplay, resolutions, streamQuality });
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
      // 断开后作废旧认证码，避免客户端用缓存码自动重连
      code = createPairingCode(code);
      console.log(`Pairing code rotated: ${code}`);
    }
    return json(res, { ok: true, code });
  }
  const file = req.url === '/client' ? 'client.html' : req.url === '/clock.html' ? 'clock.html' : 'admin.html';
  try { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(await readFile(new URL(`./public/${file}`, import.meta.url))); }
  catch { res.writeHead(404); res.end('Not found'); }
};
const useHttps = Boolean(HTTPS_KEY && HTTPS_CERT);
const server = useHttps
  ? https.createServer({ key: readFileSync(HTTPS_KEY), cert: readFileSync(HTTPS_CERT) }, requestHandler)
  : http.createServer(requestHandler);
const wss = new WebSocketServer({ server, path: '/socket' });
const pending = new Set();
wss.on('connection', (socket, req) => {
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  pending.add(socket);
  socket.on('message', async raw => {
    let message; try { message = JSON.parse(raw); } catch { return socket.close(4002, 'Invalid message'); }
    // 时钟校准/RTT 探测：回显客户端时间并附上服务端时间，客户端据此估算两端时钟差
    if (message.type === 'ping') {
      return socket.send(JSON.stringify({ type: 'pong', t: message.t, now: Date.now(), dropped: active?.socket === socket ? active.droppedFrames ?? 0 : 0 }));
    }
    if (active?.socket === socket) return;
    if (message.type !== 'auth' || message.code !== code) return socket.send(JSON.stringify({ type: 'auth', ok: false }));
    pending.delete(socket);
    // 新客户端认证成功后接管会话：旧连接（如刷新前的残留 socket）被顶掉。
    const previous = active;
    // 客户端上报的编码能力：h264（WebCodecs 硬解）或 jpeg（兜底）
    active = { socket, authenticated: true, codec: message.codec === 'h264' ? 'h264' : 'jpeg', device: { address: req.socket.remoteAddress, connectedAt: new Date().toISOString() } };
    if (previous) previous.socket.close(4001, 'Another device took over');
    const display = await ensureDisplay();
    if (active?.socket !== socket) return;
    if (!display) return socket.send(JSON.stringify({ type: 'auth', ok: true, display: null, error: '虚拟屏不可用，请检查服务端日志。' }));
    startCapture();
    return socket.send(JSON.stringify({ type: 'auth', ok: true, display, codec: active.codec }));
  });
  socket.on('close', () => {
    pending.delete(socket);
    if (active?.socket === socket) {
      active = null;
      stopCapture();
    }
  });
});
// 心跳：浏览器刷新/断网后旧 socket 可能不会触发 close，定期 ping 并清理无响应连接。
const heartbeat = setInterval(() => {
  const sockets = active ? [...pending, active.socket] : [...pending];
  for (const socket of sockets) {
    if (socket.isAlive === false) { socket.terminate(); continue; }
    socket.isAlive = false;
    socket.ping();
  }
}, 5000);
wss.on('close', () => clearInterval(heartbeat));
server.listen(PORT, '0.0.0.0', () => {
  const protocol = useHttps ? 'https' : 'http';
  console.log(`Mac Mirror: ${protocol}://localhost:${PORT}  pairing code: ${code}`);
  if (useHttps) console.log('Wake Lock can work when the client browser trusts the certificate.');
  // 清掉上次运行遗留的采集进程：孤儿 SCK 流挂在显示器上时，切换显示模式会拖垮整个采集管线
  execFile('pkill', ['-x', 'MirrorCapture'], () => {});
  startDisplayWatchdog();
});
