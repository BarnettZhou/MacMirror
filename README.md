# LAN Mirror

把 Mac 上一块独立的虚拟扩展屏，通过局域网投到任意设备的浏览器里。

Mac 上把窗口拖到虚拟屏，其它设备打开网页输入四位码即可观看。虚拟屏不复制主屏，远程端只接收画面，不回传鼠标和键盘。适合把 Mac 当作主机、在另一台电脑或平板上看扩展桌面的场景。

## 功能特性

- **独立虚拟屏**：只采集虚拟屏本身，主屏内容不会出现在远程端
- **纯浏览器接收**：客户端无需安装任何软件
- **推荐 VirtualDisplay 后端**：免费开源、菜单栏常驻、轻量，无需付费订阅
- **在线切换分辨率**：直接使用 VirtualDisplay 中配置的分辨率预设
- **三档传输画质**：原画 / 均衡 / 流畅，按网络情况选择
- **四位码配对**：启动和断开时随机更新，客户端输入即可连接
- **单客户端接管**：同一时间只服务一个客户端，新连接会顶掉旧连接
- **断线自恢复**：心跳检测残留连接；虚拟屏重建后自动重启采集
- **客户端常亮**：借助浏览器 Screen Wake Lock，观看时客户端不熄屏
- **不干扰 Mac 电源策略**：远程观看期间，Mac 照常按系统设置息屏和睡眠

## 工作原理

客户端认证通过后，服务端会：

1. 通过 `vdctl` 让 VirtualDisplay 创建/上线名为 `VirtualDisplay` 的虚拟屏
2. 用 `MirrorCapture`（ScreenCaptureKit）只采集这块屏
3. 通过 WebSocket 把画面帧推给浏览器，浏览器用 Canvas 渲染
4. 切换分辨率时，用 `MirrorDisplayCtl` 强制 macOS 应用目标显示模式

## 系统要求

- macOS 13 或更高版本
- Node.js 20+
- Swift 6 工具链（Xcode 16+ 或 Xcode Command Line Tools）
- 显示后端二选一：
  - **VirtualDisplay 4.0+（推荐）**，需包含 `vdctl`
  - BetterDisplay 4.x（备选，需开启 CLI 集成）

## 安装

### 1. 安装 VirtualDisplay（推荐）

VirtualDisplay 是一款免费开源的 macOS 菜单栏虚拟显示器工具，项目地址：

**https://github.com/youngyunxing/VirtualDisplay**

从该仓库的 Releases 下载 `VirtualDisplay.zip`，解压后把 `VirtualDisplay.app` 拖到「应用程序」文件夹。首次运行若被 Gatekeeper 拦截，可执行：

```sh
xattr -dr com.apple.quarantine /Applications/VirtualDisplay.app
```

或者右键应用选择「打开」。启动后菜单栏会出现显示器图标，`vdctl` 位于 `/Applications/VirtualDisplay.app/Contents/MacOS/vdctl`。

LAN Mirror 会自动创建并复用名为 `VirtualDisplay` 的虚拟屏。你可以提前在 VirtualDisplay 菜单里为它添加分辨率预设；逻辑分辨率（预设值的一半）会出现在管理页的可选列表中。如果列表为空，请先在 VirtualDisplay 中为该屏添加至少一个预设。

### 2. 构建并启动

```sh
npm install
swift build
npm start
```

默认监听 `8787` 端口，可通过 `PORT` 修改。

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

| 档位 | 编码质量 | 最大宽度 | 适用场景 |
| --- | --- | --- | --- |
| 原画 | 0.72 | 不限制 | 局域网有线或信号良好的 Wi‑Fi |
| 均衡 | 0.6 | 2560px | 一般 Wi‑Fi，兼顾清晰度与延迟 |
| 流畅 | 0.45 | 1920px | 网络较差、客户端卡顿或延迟明显时 |

切换画质会重启采集进程，客户端画面会短暂中断后自动恢复。

## 显示后端

默认使用 VirtualDisplay，无需额外配置。启动时可选择后端：

```sh
# 默认：VirtualDisplay
npm start

# 备选：BetterDisplay（需要开启 BetterDisplay CLI 集成）
DISPLAY_BACKEND=betterdisplay npm start
```

VirtualDisplay 后端按以下顺序查找 `vdctl`：

1. `/Applications/VirtualDisplay.app/Contents/MacOS/vdctl`
2. `/tmp/VirtualDisplay-derived-app/Build/Products/Debug/VirtualDisplay.app/Contents/MacOS/vdctl`（技术验证构建）
3. 环境变量 `VIRTUAL_DISPLAY_CTL=/path/to/vdctl`

它只操作名为 `VirtualDisplay` 的虚拟屏，不会创建或修改 BetterDisplay 的 `LANMirror`。BetterDisplay 后端在首次连接时创建 `LANMirror` 虚拟屏，所有操作同样限定在该屏。

## 客户端常亮与 HTTPS

客户端常亮依赖浏览器 Screen Wake Lock。该 API 要求安全上下文，局域网 HTTP 地址通常不满足；静音视频不能可靠阻止系统休眠。

如需客户端屏幕常亮，可为服务配置浏览器信任的 HTTPS 证书：

```sh
HTTPS_KEY=/path/to/key.pem HTTPS_CERT=/path/to/cert.pem npm start
```

然后客户端改用 `https://<Mac局域网IP>:8787/client`。证书必须包含该 IP/主机名并由客户端信任，否则浏览器仍会禁用常亮锁。

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
Sources/MirrorCapture/        ScreenCaptureKit 采集辅助程序
Sources/MirrorDisplayCtl/     显示模式切换辅助程序
tests/session.test.js         配对码测试
```

## 开发

```sh
npm test          # 运行 Node 测试
swift build       # 构建两个 Swift 辅助程序到 .build/debug
```
