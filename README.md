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

显示后端可在启动时选择，默认使用 BetterDisplay：

```sh
# 默认：BetterDisplay（需要开启 BetterDisplay CLI 集成）
npm start

# 技术验证后端：VirtualDisplay（需要 VirtualDisplay.app 已安装并运行）
DISPLAY_BACKEND=virtualdisplay npm start
```

VirtualDisplay 后端默认查找 `/Applications/VirtualDisplay.app/Contents/MacOS/vdctl`，也可以通过 `VIRTUAL_DISPLAY_CTL=/path/to/vdctl` 指定路径。它复用名为 `VirtualDisplay` 的虚拟屏；如果不存在，则创建这一块屏。它不会创建或修改 BetterDisplay 的 `LANMirror`。两种后端对网页端使用相同的配对、采集和管理接口。

VirtualDisplay 当前只向管理页报告其 `vdctl` 标记为当前的分辨率。技术验证中，切换到其他预设后 macOS 实际模式未改变，因此其他分辨率暂不作为可选项。

客户端常亮优先使用浏览器 Screen Wake Lock。该 API 要求安全上下文，局域网 HTTP 地址通常不满足；静音视频不能可靠阻止系统休眠。要启用客户端屏幕常亮，可为服务配置浏览器信任的 HTTPS 证书：

```sh
HTTPS_KEY=/path/to/key.pem HTTPS_CERT=/path/to/cert.pem npm start
```

然后客户端使用 `https://<Mac局域网IP>:8787/client`。证书必须包含该 IP/主机名并由客户端信任，否则浏览器仍可能禁用常亮锁。Mac 端在有客户端连接期间由 `caffeinate` 阻止系统闲置睡眠。

首次运行需要在 macOS 隐私与安全性中允许 Screen Recording。BetterDisplay 的 CLI 集成功能也必须启用。

## 当前验证范围

- BetterDisplay 创建、连接和复用唯一的 `LANMirror` 虚拟屏
- VirtualDisplay 后端通过 `vdctl` 复用唯一的 `VirtualDisplay` 虚拟屏，并使用当前预设提供的逻辑分辨率
- 仅采集该独立显示器的 ScreenCaptureKit 画面
- 四位码配对与单连接互斥
- 管理页查看连接并下线
- 浏览器纯显示，不提供远端输入控制
