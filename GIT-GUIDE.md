# Git 版本管理 & 回滚指南

> 本项目的 Git 速查手册。日常只需要记住前两节，回滚时再查第三节。

## 0. 本项目的版本库结构

Git 管理的是**代码**；你的记账数据和密钥**不在**版本库里（见 `.gitignore`）：

| 文件 | 是否入库 | 原因 |
|------|---------|------|
| server.js、public/、启动记账.bat | ✅ 入库 | 代码，需要版本回滚 |
| data.json | ❌ 忽略 | 真实账本数据，避免 `reset --hard` 误伤（且不会随回滚丢失） |
| secret.json | ❌ 忽略 | 智谱 API Key，绝不能提交/推送 |

注意：`git reset --hard` 只会动**已入库的文件**，data.json 和 secret.json 不受影响，这是故意的安全设计。

## 1. 日常流程（改完代码就提交）

```bash
git status                 # 看哪些文件改动了
git add .                  # 把所有改动加入暂存区（或 git add 具体文件）
git commit -m "写清楚这次改了什么"   # 提交，形成一个新的版本快照
```

查看历史版本：

```bash
git log --oneline          # 每个版本一行：短ID + 提交说明
git log -p 文件名           # 看某个文件的具体改动历史
```

`git log --oneline` 输出类似：

```
a1b2c3d 修复了报表金额计算错误
e4f5g6h 新增月度汇总功能
...
```

前面那串就是**版本号（commit ID）**，回滚时会用到。

## 2. 三棵树的概念（理解回滚的关键）

```
工作区  →  暂存区  →  版本库
(你编辑的文件)  (git add 后)  (git commit 后)
```

## 3. 回滚场景速查

### 场景 A：还没 commit，想丢弃某个文件的改动

```bash
git restore 文件名          # 丢弃工作区改动，恢复到上次提交的样子
git restore .              # 丢弃全部未提交的改动（慎用，不可恢复）
```

### 场景 B：已经 commit，但想撤销这一次提交

```bash
# 撤销提交，但改动保留在工作区（最常用、最安全）
git reset --soft HEAD~1

# 撤销提交和暂存，改动保留在工作区
git reset HEAD~1

# 彻底丢弃这次提交的改动（慎用，改动会消失）
git reset --hard HEAD~1
```

`HEAD~1` 表示上一个版本，`HEAD~2` 表示上上个，以此类推。

### 场景 C：回滚到任意一个历史版本

```bash
git reset --hard a1b2c3d   # 把整个项目恢复到 a1b2c3d 那个版本的样子
```

⚠️ `--hard` 会丢弃该版本之后的所有改动，执行前确认真的不要了。

更安全的做法（保留历史，生成一条"反向提交"，适合已推送到远端的情况）：

```bash
git revert a1b2c3d         # 新增一个提交，效果等于撤销 a1b2c3d
```

### 场景 D：只想把某个文件恢复到历史版本，其他文件不动

```bash
git checkout a1b2c3d -- src/app.js   # 把 app.js 恢复到 a1b2c3d 时的样子
git commit -m "恢复 app.js 到旧版本"
```

### 场景 E：后悔了！想找回被 reset 掉的版本

Git 几乎不会真正删除提交。用 `reflog` 找回：

```bash
git reflog                 # 列出 HEAD 的所有移动记录
git reset --hard HEAD@{2}  # 回到 reflog 里显示的某个位置
```

## 4. 常用辅助命令

```bash
git diff                   # 看当前未提交的改动内容
git diff --staged          # 看已 add 未 commit 的改动
git show a1b2c3d           # 看某个版本改了什么
git branch                 # 查看分支
```

## 5. 提交信息建议

用一句话说清楚"为什么改"或"改了什么"，例如：

- `修复：删除账目时分页数量没有减 1`
- `新增：按月份筛选账单功能`
- `重构：把金额计算抽成独立模块`
