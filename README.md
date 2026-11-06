# BetterVSC

BetterVSC 强制一套字体方案，把 Neovide 的“果冻光标”效果带到编辑器、内置终端和文件资源管理器，并提供资源管理器的纯键盘 Vim 风格操作。

## 字体方案

| 位置 | 字体 |
| --- | --- |
| 编辑器代码（西文） | JetBrains Mono |
| 编辑器代码（中文） | Maple Mono NF CN |
| 内置终端（仅终端） | Maple Mono NF CN |
| VS Code 其余界面 / 聊天 / 面板等 | Maple Mono NF CN，MiSans 兜底 |

> 系统里安装的 Maple 字体家族名是 **Maple Mono NF CN**（没有单独的 “Maple Sans”）。

## 光标颜色

光标颜色跟随输入法状态：

| 状态 | 颜色 |
| --- | --- |
| 中文（中） | 哔哩哔哩粉 `#FB7299` |
| 英文（英） | 洛天依蓝 `#66CCFF` |

编辑器光标、终端光标和果冻光标尾迹会一起切换。状态通过输入法组合事件、IME keydown（keyCode 229）和单独按下 Shift 来推断；切换后正常输入即可刷新。

## 终端光标

内置终端的光标由 xterm.js 绘制。为了让 Neovide 光标能读取光标位置，需要让终端使用 DOM 渲染器：

```json
"terminal.integrated.gpuAcceleration": "off"
```

这是本项目的默认设置。关闭终端 GPU 渲染后，扩展会把原本只作用于编辑器的果冻光标同样应用到终端光标上。

## 文件资源管理器

文件资源管理器获得和编辑器同款的果冻高亮：

- 聚焦行本身有一层跟随输入法颜色的半透明底色（不遮挡文件名）。
- 用键盘/鼠标切换文件时，覆盖层会从旧行“果冻”变形到新行。
- 从资源管理器切到代码窗口时，果冻会从文件行收束到编辑器光标；反向切换时从编辑器光标展开到文件行。

## 资源管理器键盘操作

在文件树聚焦时（可用 `Ctrl+Shift+E` 进入）：

| 按键 | 行为 |
| --- | --- |
| `j` / `k` | 下一个 / 上一个文件 |
| `h` | 折叠文件夹，或在文件上跳到父目录 |
| `Shift+h` | 跳到父目录 |
| `l` / `o` | 展开文件夹；在文件上打开并聚焦编辑器 |
| `Enter` | 在文件上打开并聚焦编辑器 |
| `Ctrl+d` / `Ctrl+u` | 向下 / 向上翻页 |
| `Esc` | 回到代码窗口 |

这些键由 `bettervsc.explorerVim` 控制，默认开启。需要文件树原生首字母跳转时，可在设置里关闭，或执行命令 `BetterVSC: Toggle Vim Keys in Explorer`。

## 已安装内容

- `media/bettervsc-cursor.js` — 编辑器 + 终端 Neovide 光标 + 资源管理器果冻高亮
- `media/bettervsc-fonts.css` — 工作区 UI 与终端字体强制覆盖
- `extension.js` — 强制字体/终端设置、注入资源文件、资源管理器 Vim 键位与打开文件命令

文件会被复制到 `%USERPROFILE%\.vscode\bettervsc\`，再由 `vscode-custom-css` 注入到 workbench。

## 命令

- `BetterVSC: Apply Fonts and Cursor`
- `BetterVSC: Re-inject Cursor and Font CSS`
- `BetterVSC: Open Focused File and Focus Editor`
- `BetterVSC: Toggle Vim Keys in Explorer`

修改自定义 CSS/JS 后需要执行一次 `Reload Custom CSS and JS`，然后重载窗口。

## 手动重装

```powershell
# 1. 复制资源
New-Item -ItemType Directory -Force "$env:USERPROFILE\.vscode\bettervsc" | Out-Null
Copy-Item .\media\* "$env:USERPROFILE\.vscode\bettervsc\" -Force

# 2. 在 settings.json 中设置
#    "vscode_custom_css.imports": [
#      "file:///C:/Users/<你>/.vscode/bettervsc/bettervsc-fonts.css",
#      "file:///C:/Users/<你>/.vscode/bettervsc/bettervsc-cursor.js"
#    ]

# 3. 命令面板执行
#    Reload Custom CSS and JS
#    Developer: Reload Window
```
