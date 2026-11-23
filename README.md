# 流光

个人工作台 Mac 应用：今日时间流、日历、周报、入职清单、公司邮箱、学习路线，接入本机 Claude Code。

## 安装与更新

1. 打开仓库的 Actions 页面，进入最新一次「打包 macOS」，下载 `liuguang-dmg`；打了 `v*` 标签的版本也会出现在 Releases 里。
2. 解压得到 `.dmg`，把「流光」拖进「应用程序」。更新时同样拖进去覆盖。
3. 应用没有苹果签名，第一次打开会被拦下：到「系统设置 › 隐私与安全性」底部点「仍要打开」。

## 数据

- 数据库：`~/Library/Application Support/流光/liuguang.db`，与应用本体分开，覆盖安装不影响数据。
- 每次升级如需改表结构，会先备份到 `backups/pre-migrate-*.db`，在事务里迁移，失败自动回滚。
- 每天自动备份一份到 `backups/daily-*.db`，保留 30 份。
- 设置里可以导出 Markdown 和 JSON。
- 邮箱密码只存在 macOS 钥匙串（服务名「流光」）。

## Claude

调用本机的 Claude Code 命令行（`claude -p`），需要先在终端装好并登录过一次。找不到时可以在设置里填写路径。

## 开发

```bash
npm install
npm run tauri dev
```
