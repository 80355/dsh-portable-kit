# 宣传图（1080 × 1920，抖音竖版）

| 文件 | 内容 | 用途 |
| --- | --- | --- |
| `01-cover.png` | 封面：DSH 随身卡 + 四个模块 | 视频封面 / 图文首图 |
| `02-portable.png` | 便携：盘符变了也能跑（含启动脚本片段） | 第一张内容图 |
| `03-phone.png` | 手机操控：截图→网格→视觉→节点树→tap | 第二张 |
| `04-douyin.png` | 抖音自动化：用你自己的浏览器 | 第三张 |
| `05-magicos.png` | 厂商适配：前台也冻你，adb 豁免全无效 | 第四张（最抓眼球） |
| `06-open.png` | 开源：仓库地址 + 目录结构 | 结尾图 |

## 重新生成

图片由 `tmp/gen-assets2.mjs`（不在仓库里）渲染：HTML + 免费方案 → 无头 Edge 截图。

```bash
# 生成 HTML
node gen-assets.mjs
# 用 Edge 渲染（Windows）
msedge --headless=new --hide-scrollbars --window-size=1080,1920 \
  --screenshot=assets/01-cover.png file:///<path>/01-cover.html
```

设计约定（改图时保持一致）：

- 画布固定 **1080×1920**，外边距 96/84px；
- 背景：深色 `#04060d` + 青色/紫色双径向光晕 + 72px 网格；
- 主色：青 `#38e8ff`、紫 `#8b6bff`、粉 `#ff77c8`；警示橙 `#ffb44f`；
- 字体：`Microsoft YaHei` / `PingFang SC`（不引入外链字体，离线可渲染）；
- 每张图一个「标签行 + 大标题 + 一个证据块 + 一组要点」，不做纯文字堆砌。