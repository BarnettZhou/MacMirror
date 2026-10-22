# LAN Mirror (验证性原型)

在 macOS 上启动一个局域网服务：BetterDisplay 创建并连接一块真正独立的虚拟扩展屏，ScreenCaptureKit 只采集这块虚拟屏并显示到浏览器。Mac 上将窗口拖到 LANMirror 扩展屏后，客户端网页会看到这些窗口，不会复制 Mac 主屏。客户端只接收画面，不回传鼠标或键盘输入。服务端最多允许一个客户端。

## 运行

要求：macOS、BetterDisplay 4.x、Node.js 20+、Swift/Xcode Command Line Tools。

```sh
npm install
swift build
npm start
```

在 Mac 浏览器打开 `http://localhost:8787` 管理页面；其它电脑打开 `http://<Mac局域网IP>:8787/client`，输入页面显示的四位码。

显示后端可在启动时选择，默认使用 VirtualDisplay：

```sh
# 默认：VirtualDisplay（需要 VirtualDisplay.app 已安装）
npm start

# 备选：BetterDisplay（需要开启 BetterDisplay CLI 集成）
DISPLAY_BACKEND=betterdisplay npm start
```

VirtualDisplay 后端优先查找 `/Applications/VirtualDisplay.app/Contents/MacOS/vdctl`，并兼容本机技术验证构建路径 `/tmp/VirtualDisplay-derived-app/Build/Products/Debug/VirtualDisplay.app/Contents/MacOS/vdctl`。其他位置可通过 `VIRTUAL_DISPLAY_CTL=/path/to/vdctl` 指定。它复用名为 `VirtualDisplay` 的虚拟屏；如果不存在，则创建这一块屏。它不会创建或修改 BetterDisplay 的 `LANMirror`。两种后端对网页端使用相同的配对、采集和管理接口。

VirtualDisplay 当前只向管理页报告其 `vdctl` 标记为当前的分辨率。技术验证中，切换到其他预设后 macOS 实际模式未改变，因此其他分辨率暂不作为可选项。

注意：CGVirtualDisplay 创建后需要约 10 秒才会被 WindowServer 上线为扩展屏，管理页启用后请稍等。若 WindowServer 崩溃或重启，macOS 可能把崩溃时销毁的虚拟屏标识（vendor/product/serial）列入异常状态，之后相同标识的虚拟屏永远无法上线（表现为扩展屏完全失效：能采集但拖不动窗口）。恢复方法：在 `com.youngyunxing.VirtualDisplay` 配置中为该显示器换一组 `vendorID`/`productID`/`serialNumber`，再开关一次显示器。

客户端常亮优先使用浏览器 Screen Wake Lock。该 API 要求安全上下文，局域网 HTTP 地址通常不满足；静音视频不能可靠阻止系统休眠。要启用客户端屏幕常亮，可为服务配置浏览器信任的 HTTPS 证书：

```sh
HTTPS_KEY=/path/to/key.pem HTTPS_CERT=/path/to/cert.pem npm start
```

然后客户端使用 `https://<Mac局域网IP>:8787/client`。证书必须包含该 IP/主机名并由客户端信任，否则浏览器仍可能禁用常亮锁。

Mac 端**不做任何保活**：远程观看期间本机照常按系统设置的 `displaysleep` / `sleep` 息屏和睡眠，与平时无人操作时完全一致。早期版本会 spawn `caffeinate -dimsu`，且服务重启时不清子进程，一次重启就遗留一个永久持有 `PreventUserIdleDisplaySleep` 的孤儿进程，导致显示器永不熄屏——该逻辑已整体移除。

首次运行需要在 macOS 隐私与安全性中允许 Screen Recording。BetterDisplay 的 CLI 集成功能也必须启用。

## 当前验证范围

- BetterDisplay 创建、连接和复用唯一的 `LANMirror` 虚拟屏
- VirtualDisplay 后端通过 `vdctl` 复用唯一的 `VirtualDisplay` 虚拟屏，并使用当前预设提供的逻辑分辨率
- 仅采集该独立显示器的 ScreenCaptureKit 画面
- 四位码配对与单连接互斥
- 管理页查看连接并下线
- 浏览器纯显示，不提供远端输入控制
