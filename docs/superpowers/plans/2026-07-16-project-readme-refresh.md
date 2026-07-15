# Project README Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the project README as a clear UTF-8 Chinese guide that accurately explains setup, material management, detailed experience interviews, verification, privacy, and troubleshooting.

**Architecture:** Replace the current README as one cohesive user-facing document rather than appending another change log. Derive every capability and command from the current implementation, then validate the finished document with deterministic content checks and a fresh-reader review.

**Tech Stack:** Markdown, PowerShell, Git, Node.js/npm project commands

## Global Constraints

- Use concise, executable Chinese and PowerShell examples.
- Do not include a real API Key, full resume content, or personal contact information.
- State that original PDF, DOCX, and image files remain local; only locally extracted, redacted, bounded text is sent to DashScope when smart extraction is requested.
- Do not claim admission prediction, public cloud sync, online search, or other unimplemented features.
- Preserve the user's unrelated uncommitted files and changes.

---

### Task 1: Rewrite and verify the project README

**Files:**
- Modify: `README.md`
- Reference: `docs/superpowers/specs/2026-07-16-project-readme-refresh-design.md`
- Reference: `src/app/api/materials/route.ts`
- Reference: `src/components/experience-cards.tsx`
- Reference: `src/lib/material-smart-extraction.ts`
- Reference: `src/lib/experience-interview.ts`

**Interfaces:**
- Consumes: Current npm scripts from `package.json`, environment variable names from `.env.example`, and implemented behavior from the referenced production files.
- Produces: A standalone UTF-8 `README.md` that a new local user can follow without reading source code.

- [ ] **Step 1: Record the required reader questions**

Use these questions as the acceptance checklist:

```text
1. What does the application do and which model provider does it use?
2. How do I install, configure, start, and open it on Windows?
3. How do I upload, re-extract, edit, confirm, and delete materials or experience cards?
4. Which confirmed experience will the research interviewer ask about first?
5. What data remains local, and what text can be sent to DashScope?
6. How do I run automated tests and interpret partial smart-extraction status?
7. What should I do when port 3000, the microphone, or an environment variable causes trouble?
```

- [ ] **Step 2: Rewrite README.md in UTF-8**

Create the following exact section structure and fill each section with current project facts:

```markdown
# 研面：电子信息保研模拟面试 Agent

## 项目简介
## 核心能力
## 快速开始
## 推荐使用流程
## 详细经历卡与项目面试
## 测试与真实验收
## 隐私与本地数据
## 常见问题
## 当前版本边界
```

The workflow section must explicitly cover choosing a file, starting local parsing, reviewing facts, re-extracting old personal materials, editing draft cards, confirming a whole card, deleting mistaken uploads, creating a 10/20/30-minute interview, and reading the review report.

The real-acceptance paragraph must state only the verified summary: one authorized resume was parsed in one successful chunk; detailed cards were recovered for Super-LoRa, the embedded FPGA competition, and the electronic-design G problem; a production text-interview request named Super-LoRa and asked about personal responsibility. Do not include the resume's full text.

- [ ] **Step 3: Verify encoding, required sections, and sensitive-content exclusions**

Run:

```powershell
$text = Get-Content -Raw -Encoding UTF8 README.md
$required = @('## 项目简介','## 核心能力','## 快速开始','## 推荐使用流程','## 详细经历卡与项目面试','## 测试与真实验收','## 隐私与本地数据','## 常见问题','## 当前版本边界','DASHSCOPE_API_KEY','npm run dev','npm run test:e2e','Super-LoRa')
$missing = $required | Where-Object { -not $text.Contains($_) }
if ($missing) { throw "README 缺少：$($missing -join ', ')" }
if ($text.Contains([char]0xFFFD)) { throw 'README 包含无效替换字符' }
if ($text -match 'sk-[A-Za-z0-9_-]{12,}') { throw 'README 疑似包含真实密钥' }
```

Expected: exit code 0 and no output.

- [ ] **Step 4: Run Markdown diff checks and inspect scope**

Run:

```powershell
git diff --check -- README.md
git diff --stat -- README.md
git status --short
```

Expected: `git diff --check` exits 0; the README is the only implementation file changed by this task; pre-existing user changes remain present and unstaged.

- [ ] **Step 5: Perform fresh-reader testing**

Give a fresh reviewer only `README.md` and the seven questions from Step 1. Require it to identify any unanswered question, contradiction, unsupported claim, ambiguous privacy statement, or missing prerequisite. Correct every Important finding and repeat the encoding/content checks from Step 3.

- [ ] **Step 6: Commit only the README**

```powershell
git add -- README.md
git commit -m "docs: refresh project guide"
```

Expected: one documentation commit; unrelated user files are not staged.
