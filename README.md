# Mac Mirror

把 Mac 上一块独立的虚拟扩展屏，通过局域网投到任意设备的浏览器里。

Mac 上把窗口拖到虚拟屏，其它设备打开网页输入四位码即可观看。虚拟屏不复制主屏，远程端只接收画面，不回传鼠标和键盘。适合把 Mac 当作主机、在另一台电脑或平板上看扩展桌面的场景。

## 功能特性

- **独立虚拟屏**：只采集虚拟屏本身，主屏内容不会出现在远程端
- **纯浏览器接收**：客户端无需安装任何软件
- **推荐 VirtualDisplay 后端**：免费开源、菜单栏常驻、轻量，无需付费订阅
- **在线切换分辨率**：直接使用 VirtualDisplay 中配置的分辨率预设
- **三档传输画质**：原画 / 均衡 / 流畅，按网络情况选择
- **低延迟 H.264**：VideoToolbox 硬编 + WebCodecs 解码，实测局域网端到端延迟约 25–40ms；不支持 WebCodecs 的浏览器自动回退 JPEG
- **四位码配对**：启动和断开时随机更新，客户端输入即可连接
- **单客户端接管**：同一时间只服务一个客户端，新连接会顶掉旧连接
- **客户端网络信息**：客户端按 `S` 打开设置，开启后右下角实时显示端到端延迟、RTT、帧率、码率等
- **断线自恢复**：心跳检测残留连接；虚拟屏重建后自动重启采集
- **客户端常亮**：HTTP 下用一个不可见的占位视频防息屏（不影响延迟）；HTTPS 下还可用 Screen Wake Lock
- **不干扰 Mac 电源策略**：远程观看期间，Mac 照常按系统设置息屏和睡眠

## 工作原理

客户端认证通过后，服务端会：

1. 通过 `vdctl` 让 VirtualDisplay 创建/上线名为 `VirtualDisplay` 的虚拟屏
2. 用 `MirrorCapture`（ScreenCaptureKit）只采集这块屏，并用 VideoToolbox 硬件编码为 H.264（实时模式、Baseline 档次无 B 帧、关键帧带内重复 SPS/PPS）
3. 通过 WebSocket 把画面帧（含采集时间戳）推给浏览器；支持 WebCodecs 的浏览器用 `VideoDecoder` 解码后 Canvas 直渲（优先软解实时模式，逐帧即时输出；硬解会按流水线深度扣住数帧，增加百毫秒级延迟），不支持的浏览器回退 JPEG + `createImageBitmap`
4. 切换分辨率时，用 `MirrorDisplayCtl` 强制 macOS 应用目标显示模式；H.264 流内带 SPS/PPS，分辨率切换无需重连

## 系统要求

- macOS 13 或更高版本
- Node.js 20+
- Swift 6 工具链（Xcode 16+ 或 Xcode Command Line Tools）
- **VirtualDisplay 4.0+**，需包含 `vdctl`

## 安装

### 1. 安装 VirtualDisplay

VirtualDisplay 是一款免费开源的 macOS 菜单栏虚拟显示器工具，项目地址：

**https://github.com/youngyunxing/VirtualDisplay**

从该仓库的 Releases 下载 `VirtualDisplay.zip`，解压后把 `VirtualDisplay.app` 拖到「应用程序」文件夹。首次运行若被 Gatekeeper 拦截，可执行：

```sh
xattr -dr com.apple.quarantine /Applications/VirtualDisplay.app
```

或者右键应用选择「打开」。启动后菜单栏会出现显示器图标，`vdctl` 位于 `/Applications/VirtualDisplay.app/Contents/MacOS/vdctl`。

Mac Mirror 会自动创建并复用名为 `VirtualDisplay` 的虚拟屏。你可以提前在 VirtualDisplay 菜单里为它添加分辨率预设；逻辑分辨率（预设值的一半）会出现在管理页的可选列表中。如果列表为空，请先在 VirtualDisplay 中为该屏添加至少一个预设。

### 2. 初始化并启动

```sh
./init.sh         # 检查开发环境（macOS 13+ / Node 20+ / Swift 6 / VirtualDisplay）并安装项目依赖
./start.sh        # 检查/拉起虚拟屏后端并启动服务
```

`init.sh` 只需在首次克隆或依赖缺失时运行；环境有问题会直接报错停下。未安装 VirtualDisplay 时，`init.sh` 会询问是否从 GitHub 自动下载安装最新版。之后日常启动用 `./start.sh` 即可（也可以直接 `npm start`）。

默认监听 `8787` 端口，可通过 `PORT` 修改。`npm start` / `start.sh` 都会自动拉起 `VirtualDisplay.app`（不抢焦点）。

## 使用

- 管理页：`http://localhost:8787`
- 客户端：`http://<Mac局域网IP>:8787/client`

在客户端页面输入管理页显示的四位码即可连接。认证码每次启动随机生成；管理页点击「断开连接」后会立即换新码，客户端必须输入新码才能重新连接。

管理页可以：

- 查看当前连接状态与客户端地址
- 切换虚拟屏分辨率
- 切换传输画质
- 断开当前客户端

## 传输画质

| 档位 | H.264 码率 | 最大宽度 | JPEG 质量（回退） | 适用场景 |
| --- | --- | --- | --- | --- |
| 原画 | 15 Mbps | 不限制 | 0.72 | 局域网有线或信号良好的 Wi‑Fi |
| 均衡 | 8 Mbps | 2560px | 0.6 | 一般 Wi‑Fi，兼顾清晰度与延迟 |
| 流畅 | 4 Mbps | 1920px | 0.45 | 网络较差、客户端卡顿或延迟明显时 |

切换画质会重启采集进程，客户端画面会短暂中断后自动恢复。

## 延迟实测与诊断

同机实测（3840×2160@30fps、原画档）：端到端延迟约 **25–40ms**，其中编码 ~20ms、解码 ~3ms、网络 RTT ~1–2ms。静态画面下 ScreenCaptureKit 不出帧，延迟数值停留在最后一帧，属正常。

客户端按 `S` → 开启「网络信息」可在右下角查看实时延迟 / RTT / 帧率 / 码率 / 编码 / 解码耗时与解码队列深度。

`http://<Mac>:8787/clock.html` 是一个毫秒级时钟测试页：把它拖到虚拟屏上全屏播放，即可对比原始时钟与镜像画面的读数差，直接观察端到端延迟。

## 显示后端

只支持 VirtualDisplay（BetterDisplay 后端已移除）。按以下顺序查找 `vdctl`：

1. `/Applications/VirtualDisplay.app/Contents/MacOS/vdctl`
2. `/tmp/VirtualDisplay-derived-app/Build/Products/Debug/VirtualDisplay.app/Contents/MacOS/vdctl`（技术验证构建）
3. 环境变量 `VIRTUAL_DISPLAY_CTL=/path/to/vdctl`

它只操作名为 `VirtualDisplay` 的虚拟屏。

服务启动时会检查 VirtualDisplay.app 是否在运行，未运行时用 `open -gj` 在后台拉起。应用路径默认从 `vdctl` 所在位置推导；如果安装在其它位置，可设置 `VIRTUAL_DISPLAY_APP=/path/to/VirtualDisplay.app`。

## 客户端常亮与 HTTPS

客户端有两种防息屏机制：

1. **占位视频（默认，HTTP 可用）**：客户端设置里的「防息屏」默认开启。一个 8×8 占位 canvas 每秒出 1 帧，灌给一个几乎不可见的 `<video>` 播放；浏览器对"正在播放的可见视频"保持屏幕唤醒（判定只看布局可见性，与尺寸、透明度无关）。主画面始终由 canvas 直渲，该机制**不影响画面延迟**。
2. **Screen Wake Lock（需 HTTPS）**：该 API 要求安全上下文，局域网 HTTP 地址不满足。为服务配置浏览器信任的证书后：

```sh
HTTPS_KEY=/path/to/key.pem HTTPS_CERT=/path/to/cert.pem npm start
```

然后客户端改用 `https://<Mac局域网IP>:8787/client`。证书必须包含该 IP/主机名并由客户端信任，否则浏览器仍会禁用常亮锁。HTTPS 下两种机制同时生效，互为兜底。

## Mac 端电源行为

Mac 端**不做任何保活**。远程观看期间，本机照常按系统设置的 `displaysleep` / `sleep` 息屏和睡眠，与平时无人操作时完全一致。

早期版本会 spawn `caffeinate -dimsu`，且服务重启时不清子进程，一次重启就遗留一个永久持有 `PreventUserIdleDisplaySleep` 的孤儿进程，导致显示器永不熄屏。该逻辑已整体移除。

## 注意事项

- **首次运行**需要在 macOS「隐私与安全性」中允许 Screen Recording，否则采集不到画面。
- **虚拟屏上线需要时间**：CGVirtualDisplay 创建后通常需要数秒到十余秒才会被 WindowServer 识别为扩展屏，客户端连接后请稍等。
- **WindowServer 崩溃后的恢复**：若 WindowServer 崩溃或重启，macOS 可能把崩溃时销毁的虚拟屏标识（`vendorID` / `productID` / `serialNumber`）列入异常状态，之后相同标识的虚拟屏永远无法上线，表现为能采集但窗口拖不进去。恢复方法：在 `com.youngyunxing.VirtualDisplay` 配置中为该显示器换一组 `vendorID` / `productID` / `serialNumber`，再开关一次显示器。
- **只读画面**：客户端不提供远端输入控制。
- **单客户端**：同一时间只服务一个客户端，新客户端认证成功后会接管会话。

## 项目结构

```
server.js                     Node 服务：配对、状态 API、WebSocket 推流
public/admin.html             管理页
public/client.html            客户端观看页
public/clock.html             毫秒时钟测试页（延迟自测用）
Sources/MirrorCapture/        ScreenCaptureKit 采集 + VideoToolbox H.264 硬编
Sources/MirrorDisplayCtl/     显示模式切换辅助程序
tests/session.test.js         配对码测试
```

## 开发

```sh
npm test          # 运行 Node 测试
swift build       # 构建两个 Swift 辅助程序到 .build/debug
```
