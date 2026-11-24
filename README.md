# 流光

个人工作台 Mac 应用：今日时间流、日历、日志与周报、入职清单、邮箱、学习路线，接入本机 Claude Code。

第一次打开会让你填名字、周报发给谁、项目、作息；之后都能在设置里改。快捷入口、入职清单、学习路线都由自己定，也可以直接跟 Claude 说。设置里可以导入配置文件（JSON，`{"settings": {...}}`）。

## 安装与更新

1. 推送到 main 后，Actions 打包并把签名过的安装包发布到 `cryptoshatter/liuguang-releases`。
2. 首次安装：从 liuguang-releases 的 Releases 下载 `.dmg`，把「流光」拖进「应用程序」。应用没有苹果签名，第一次打开要到「系统设置 › 隐私与安全性」点「仍要打开」。
3. 之后流光启动时会检查新版本，弹窗点「更新」即可，设置页也能手动检查。
4. 本仓库需要两个 secret：`RELEASES_TOKEN`（能往 liuguang-releases 发布的令牌）和 `TAURI_SIGNING_PRIVATE_KEY`（更新签名私钥，公钥在 `tauri.conf.json`）。缺少时只打包不发布。

## 数据

- 数据库：`~/Library/Application Support/流光/liuguang.db`，与应用本体分开，覆盖安装不影响数据。
- 每次升级如需改表结构，会先备份到 `backups/pre-migrate-*.db`，在事务里迁移，失败自动回滚。
- 每天自动备份一份到 `backups/daily-*.db`，保留 30 份。
- 设置里可以导出 Markdown 和 JSON。
- 邮箱密码只存在 macOS 钥匙串（服务名「流光」）。

## Claude

调用本机的 Claude Code 命令行（`claude -p`），需要先在终端装好并登录过一次。找不到时可以在设置里填写路径。

右侧的 Claude 在每个页面都在，能替你操作流光里的所有数据：排任务、补日志、改周报、勾入职清单、生成学习路线、起草邮件（发送要自己点）。

## 开发

```bash
npm install
npm run tauri dev
```
