# 测试说明

测试使用模拟页面、媒体元素和浏览器消息，验证 `content.js` 与 `background.js` 的协作。它们不连接真实学习网站，也不代表平台已经写入完成记录。

## 运行

在项目根目录执行：

```sh
npm ci --ignore-scripts
npm run check
npm test
```

`npm run check` 检查运行脚本语法，`npm test` 使用 Node.js 测试运行器和 jsdom。实际验证证据及限制见 [验证说明](../docs/VERIFICATION.md)。

## 覆盖范围

- 首页入口、课表分页扫描、目录稳定和完整性检查。
- 单课授权、短时长优先、音视频播放目标、文档访问及平台完成核对。
- 区分资源打开、实际播放、达到目标、自然结束和平台确认。
- 半自动与全自动入口、按固定列表串行选课、只有作业时跳过、局部失败后的有限重进。
- 暂停、取消、刷新、扩展更新、浏览器重启、页面关闭及跨页继续。
- 任务身份、停止确认、迟到消息、响应遗失、阶段等待上限及监督证据。
- 防自动休眠权限调用、日志容量、故障详情、只读导出和存储失败。
- 课程卡片、抽屉、只读筛选、设置保存、阅读位置和任务概览。

`outer-scheduler.test.cjs`、`outer-content.test.cjs` 和 `outer-diagnostics.test.cjs` 重点验证外围调度；单课资源、播放器和文档相关用例验证内层执行。双模式边界见 [双模式说明](../docs/DUAL_MODE.md)。

## 可选浏览器 UI 验收

`ui-browser-smoke.cjs` 不包含在 `npm test` 中。它使用测试环境提供的 Playwright，在独立临时配置中加载扩展，通过本地合成页面拦截页面及外链，不访问课程数据或启动真实课程任务。项目依赖中不因此增加 Playwright。

在已提供 Playwright 的环境中执行，可通过 `NODE_PATH` 指向工具目录：

```sh
BROWSER_EXECUTABLE="/path/to/Edge" UI_ARTIFACTS_DIR="/tmp/xinwei-ui-results" \
  node tests/ui-browser-smoke.cjs
```

验收包括本地图片、默认收起、课程卡片、设置、暂停继续、全部内页、长标题和按钮排版、拖动、键盘操作、窄视口、深色模式及减少动态效果。

合成测试和本地页面截图不能替代真实课程、登录状态、自动播放权限、网站结构变化或系统休眠场景的检查。
