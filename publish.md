# 发布指南

## v1.5.0 发布信息

- **版本**：1.5.0
- **更新日期**：2026-09-08
- **Tag**：`v1.5.0`
- **Release 标题**：`API配置管理器 v1.5.0`
- **Release 正文**：复制 [CHANGELOG.md](CHANGELOG.md) 中 `## v1.5.0 (2026-09-08)` 下的内容，到下一版本标题前为止，不包含历史版本日志。

本文件是发布操作说明；修改版本号或更新日志，不代表已推送代码、创建标签或发布 GitHub Release。

## 1. 确认发布内容

在扩展仓库根目录执行：

```powershell
git status --short
git branch --show-current
git remote -v
git diff --check
```

- 确认远程仓库和分支是本次要发布的目标；下文以 `origin` / `main` 为例。
- 确认 `manifest.json`、`index.js`、README 及更新日志中的当前版本一致。
- 若发布到自己的分叉仓库，先核对 README 安装地址及 manifest 的主页地址是否指向预期仓库，并保留原作者署名。
- 不提交酒馆用户设置、配置导出、备份、真实凭据或测试截图。配置中的明文凭据会随酒馆用户设置保存；源码公开不等于设置文件可以公开。

## 2. 运行检查

使用 Node.js 22 或更高版本：

```powershell
node --check index.js
node --test tests/connection.test.cjs tests/pin.test.cjs tests/theme.test.cjs tests/models.test.cjs tests/model-fetch.test.cjs tests/apply-secret.test.cjs tests/release.test.cjs
```

浏览器回归还需要本机 Chromium / Edge 及酒馆静态资源。把路径替换为自己的安装目录：

```powershell
$env:SILLYTAVERN_PUBLIC = 'E:\SillyTavern\SillyTavern\public'
node --test tests/modal-ui.test.cjs
```

如不使用默认 Edge 路径，可设置 `BROWSER_PATH`。自动测试只使用模拟配置并阻止页面网络请求，不使用真实 API 或密钥。测试截图写入系统临时目录，不要加入发布提交。

## 3. 提交并推送

先检查本轮全部改动，再按需暂存发布文件：

```powershell
git add -- manifest.json index.js style.css README.md CHANGELOG.md CHECKLIST.md PRIVACY.md publish.md tests
git diff --cached --check
git diff --cached --stat
git diff --cached
```

确认暂存内容无遗漏、无真实配置或凭据后：

```powershell
git commit -m "Release v1.5.0"
git push origin main
```

## 4. 创建版本标签与 Release

确认标签尚未存在，不要覆盖或强制移动已发布的标签：

```powershell
git tag --list v1.5.0
git tag -a v1.5.0 -m "API配置管理器 v1.5.0"
git push origin v1.5.0
```

在目标 GitHub 仓库进入 **Releases → Draft a new release**：

1. 选择标签 `v1.5.0`。
2. 标题填写 **API配置管理器 v1.5.0**。
3. 正文复制更新日志中的本次版本内容，预览排版。
4. 确认目标提交包含本次完整代码、样式及文档，不勾选预发布选项。
5. 点击 **Publish release**；确认远程页面和标签后，才向用户宣布已发布。

## 用户更新说明

通过酒馆的扩展管理更新后刷新页面，管理弹窗应显示 **v1.5.0**。已有配置兼容保留；建议更新前备份酒馆用户设置，并妥善保护备份中的明文凭据。扩展不再内置联网版本检查或更新按钮。
