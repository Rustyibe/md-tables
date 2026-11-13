# md-tables

Claude Code 的 mod(plugin):重画 AI 回复里的 markdown 表格。

Claude Code 内置的表格渲染在 CJK 和 emoji 面前会出问题:

- 中文单元格按「每字符 1 列」计量,而终端画 2 列,列宽腰斩,`使用中` 被拆成一行一个字;
- 紧跟另一张表(中间没有空行)的表不被识别,整段原样吐出 `| a | b |`;
- 窄终端下长内容撞出边界后被终端自动折行,竖线集体错位。

md-tables 挂在表格的渲染事件上、手工排版网格,表格因此对齐、在列内换行,
并且在流式输出期间保持稳定。

## 工作原理

- **hook**:`ui.render` 的 `{ component: 'AssistantMessage' }`。块内没有 GFM
  竖线表格时原样放行(`next(e)`)——零开销、零侵入。存储的消息从不被改写,
  ctrl+o 的 transcript 视图里仍是原始 markdown。
- **宽度计量**:移植自 pi TUI 的 `visibleWidth`——grapheme 切分、RGI emoji /
  变体选择符处理,以及把 `get-east-asian-width` 的生成表以数据形式内置。
  CJK 记 2 列,`│ ─ ┼` 记 1 列,与引擎和 pi 完全一致。
- **列宽分配**:同样是 pi 的 `renderTable` 算法——每列知道自己的 natural
  宽度和最长不可断单元(英文单词,或单个 CJK 字,上限 30);放不下时先压到
  单元底线,剩余空间按各列的可缩余量按比例摊分。单元格在列内换行,
  不做粗暴截断。
- **边框样式**:数据层移植自 tabled 的 presets(`hooks/register.tsx` 里的
  `STYLES`:`modern / ascii / extended / markdown / dots / blank`),
  出厂固定 `modern`。
- **流式行为**:表恰好顶在消息末尾时它还可能继续长,因此先按原文行输出,
  直到"落定"——被空行、后续段落或下一张表的 delimiter 闭合,或者本轮结束
  (`turn.start` / `turn.complete` 加一个能扛过 reload 的 `$.state` 标志;
  绘制期读取会订阅实例,落定自动重画,无需手动 invalidate)。然后一次性
  换成网格。
- **降级**:窄到每列连 1 格都放不下时保持原文行;代码块内与非表格内容
  一概不动。

## 安装

终端会话内(Claude Code 里):

```
/plugin install md-tables --marketplace Rustyibe/md-tables
```

按 `y` 添加 marketplace,选 scope(user = 之后每个新会话自动加载)。

或在 shell 里:

```
claude plugin install md-tables --marketplace Rustyibe/md-tables
```

开发式加载(不安装;目录被 watch,存盘即 hot-reload):

```
claude --plugin-dir <本目录路径>
```

## 目录结构

```
.claude-plugin/plugin.json     manifest(name、version、license、types)
.claude-plugin/marketplace.json 让本仓库自身可作为 marketplace
hooks/hooks.json               指向 hooks module
hooks/register.tsx             mod 全部逻辑:解析 → 计量 → 分配 → 绘制
types/index.d.ts               $.state 契约(openTurn)
tests/md-tables.test.tsx       7 个引擎 host 上的测试(claude plugin test)
```

## 开发

```
claude plugin validate <目录>
claude plugin test <目录>
```

注意:

- box-drawing 字符按窄(1 列)计量,与 pi 一致。字体把这类字符画成双宽的
  终端会看到错位——那种终端下 pi 自己也会错位。
- 工具输出行里的表格和代码块内的表格刻意不在处理范围。

## 致谢

- 渲染算法:[pi](https://github.com/badlogic/pi-mono)
  (`packages/tui` markdown component,`renderTable` / `visibleWidth`)。
- 样式 preset 与分层设计:[tabled](https://github.com/zhiburt/tabled)。
- 宽度表:[get-east-asian-width](https://github.com/sindresorhus/get-east-asian-width)
  1.6.0,以数据形式内置。

## 许可

MIT
