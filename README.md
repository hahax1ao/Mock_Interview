# 研面：电子信息保研模拟面试 Agent

一个只在本机保存材料、转写和复盘数据的保研模拟面试网页应用。模型服务使用阿里云百炼，浏览器通过本地 WebSocket 中继连接 Qwen Omni Realtime，长期 API Key 不会进入前端。

## 启动

1. 安装 Node.js 24 与 npm 11。
2. 安装依赖：

   ```powershell
   npm install
   ```

3. 配置百炼标准按量付费 API Key。任选一种方式：

   - 设置系统环境变量 `DASHSCOPE_API_KEY` 或 `ALIYUN_API_KEY`，然后重启终端/Codex；
   - 复制 `.env.example` 为被 Git 忽略的 `.env.local`，只在本机填写 Key。

   不要使用 Coding Plan / Token Plan 专用 Key，也不要把真实 Key 提交到 Git 或发到聊天中。

   智能材料解析默认使用 `QWEN_MATERIAL_MODEL=qwen3.5-flash`。本地解析会先从材料中提取文本；智能解析时仅将提取出的材料文本发送到阿里云百炼，原始 PDF、DOCX、图片等文件不会上传到百炼，仍只保存在本机。

4. 启动：

   ```powershell
   npm run dev
   ```

5. 打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)。

## 已实现

- PDF、DOCX、JPG/PNG、TXT、Markdown 本地解析与 OCR；
- 个人材料、目标院校材料、专业资料分类及事实确认；
- 10/20/30 分钟四角色实时面试；
- 单主题三层追问限制、断线暂停/自动重连、最后一分钟主考官收尾；
- 麦克风不可用时文字降级，不保存原始音频；
- 四评审 Agent、证据化六维评分、分歧提示、示范回答与七天训练计划；
- 相同时长、方向和压力等级场次的本地趋势；
- SQLite/Drizzle 本地存储与级联删除。

## 验证

```powershell
npm test
npm run lint
npm run build
npm run test:e2e
```

Playwright 默认使用本机已安装的 Chrome。真实百炼冒烟测试会产生费用，因此不包含在默认自动测试中。

## 本地数据

- 数据库：`data/baoyan.db`
- 原始材料：`uploads/`
- 构建与测试产物：`.next/`、`test-results/`、`playwright-report/`

上述目录均已按用途加入忽略规则或仅保留在本机。
