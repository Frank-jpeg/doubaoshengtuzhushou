# 豆包图像生成助手

ScriptCat / Tampermonkey 用户脚本，用于豆包（doubao.com）批量文生图 / 图生图、断点续传。

## 安装

点下面的链接，脚本猫 / 油猴会弹出安装页：

```
https://raw.githubusercontent.com/Frank-jpeg/doubaoshengtuzhushou/main/doubao-image-auto.user.js
```

> 必须用这个链接安装，脚本才会绑定更新源。手动新建 / 粘贴进编辑器的脚本不会检查更新。

## 更新

脚本头部内置 `@updateURL` + `@downloadURL`，指向本仓库 `main` 分支的脚本文件。
脚本猫 / 油猴按 `@version` 自动检查更新，也可以在脚本详情页点「检查更新」手动触发。

**发新版时必须同时改三处，改齐再推，否则更新不会被识别：**

1. 脚本头部的 `// @name`（名字带版本号，如 `豆包图像生成助手 v3.4`）
2. 脚本头部的 `// @version`
3. 代码里的 `const SCRIPT_VERSION = "x.y";`

`prep_repo_release.py` 里做了这三处的强一致校验，不一致会直接中止，不会产出错版。

> ⚠️ **名字带版本号的代价（已确认按此执行）**
>
> 脚本猫按 **`@name` + `@namespace`** 判定脚本唯一性（官方文档原文：*"name + namespace
> determines the script's uniqueness"*；源码里 `installScript()` 也按「同 name + 同 namespace
> 是否存在」来决定是更新还是新装）。名字一变，脚本猫就当成**另一个新脚本**装进去，
> 旧版不会自动消失。
>
> **所以每次发版后要去脚本列表手动删掉旧版**，否则新旧两个同时注入同一页面。
> （Tampermonkey 不受影响，改名会按更新处理并自动改名；本项目按脚本猫的行为处理。）
>
> 想省掉这一步的话，改回「名字固定 + 版本号写进 `@description`」即可，两者取舍随时可换。

## 文件

| 文件 | 说明 |
| --- | --- |
| `doubao-image-auto.user.js` | 豆包图像生成助手，当前 **v3.4** |

## 更新记录

### v3.4

- **修复抓错图（主要）**：`isGeneratedResultImage()` 不再用图片 CDN 域名放行。`imagex-sign.byteimg.com` 是豆包全站图片 CDN，侧栏会话头像、会话缩略图、UI 图标都在这个域名下，旧逻辑会把它们全部当成生成结果下载。现改为锚定生成结果容器 DOM（`[data-testid="mdbox_image"]` / `.image-item-*`）与生成图专属 class。
- `getImageCards()` 增加 DOM 节点去重：同一结果容器上挂着主图与悬停叠加层两张 `img`，旧逻辑会重复下载同一张图。
- `downloadBlobByUrl()` 增加 `watermarkFree` 参数，原图下载分支不再误报「正在下载无水印图」。
- 脚本头部加入 `@updateURL` / `@downloadURL`，指向本仓库 `main`，支持在线检查更新。

### v3.3（未发布到本仓库，仅本地版本）

- 适配豆包新输入框（Tiptap / ProseMirror）写入方式；补 `assertPromptValue()` 写入校验。

### v3.2

- 修复豆包新版页面按钮位置变化导致的图像生成入口、发送按钮、图片上传入口识别问题。
