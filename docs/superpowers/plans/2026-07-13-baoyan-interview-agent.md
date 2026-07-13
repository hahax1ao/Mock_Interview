# 电子信息保研模拟面试 Agent V1 实施计划

> **For agentic workers:** 使用测试驱动开发，逐项验证后再进入下一阶段。

**目标：** 实现材料建档、四角色实时语音面试、证据化复盘和趋势跟踪的本地应用。

**架构：** Next.js/TypeScript 负责本地网页与 API；自定义 Node WebSocket 服务代理浏览器和百炼 Omni Realtime，避免暴露密钥；SQLite/Drizzle 保存本地状态；百炼文本模型完成评审与汇总。

**技术栈：** Next.js、React、Tailwind、Zod、SQLite、Drizzle、OpenAI-compatible SDK、WebSocket、Vitest、Playwright。

## 实施任务

1. 建立项目、配置、本地数据库和安全环境变量规范。
2. 以测试驱动实现材料解析、事实确认和检索。
3. 以测试驱动实现场次计划、状态机、转写事件和角色交接。
4. 实现百炼文本及 Omni Realtime 适配器，提供 Mock 模式。
5. 以测试驱动实现四角色评审、评分汇总、训练计划和趋势。
6. 实现材料、面试房间、复盘和趋势界面。
7. 运行单元测试、端到端测试、构建、安全检查和真实 API 冒烟测试。
