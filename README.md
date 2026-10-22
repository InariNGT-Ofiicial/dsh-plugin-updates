# DSH 插件自动更新 · 0.2.1

原生 DSH 插件，连接已安装插件的原 GitHub 仓库，**默认开启自动更新，每 24 小时检查一次**。检查和安装直接使用程序与官方 DSH CLI，不发起模型调用。

[最新 Release](https://github.com/InariNGT-Ofiicial/dsh-plugin-updates/releases/latest) · [安装包 v0.2.1](https://github.com/InariNGT-Ofiicial/dsh-plugin-updates/releases/download/v0.2.1/dsh-plugin-updates-0.2.1.tgz) · [问题反馈](https://github.com/InariNGT-Ofiicial/dsh-plugin-updates/issues)

首次启动延迟 15 秒；重启读取上次检查时间，未到期不会重复检查。默认覆盖同一 DSH 主目录下所有 profile 的直接安装插件，包含未启用的安装条目。更新保留它们原有的启用状态。更新安装完成后，在对应 profile 重新加载或重启时生效；插件不会自动重启 DSH。

## 安装或升级

需要 Node.js 24+、DSH 0.2.1-rc.2。可直接安装 Release URL，无需构建：

```powershell
dsh plugin --profile desktop add https://github.com/InariNGT-Ofiicial/dsh-plugin-updates/releases/download/v0.2.1/dsh-plugin-updates-0.2.1.tgz
```

桌面版命令未加入 PATH 时：

```powershell
& 'D:\DSH\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add https://github.com/InariNGT-Ofiicial/dsh-plugin-updates/releases/download/v0.2.1/dsh-plugin-updates-0.2.1.tgz
```

也可从 Release 下载 `.tgz` 后通过本地路径安装。命令安装后重新加载或重启 DSH。旧版的检查时间设置会保留，已有人工设置仍优先于默认值。

本插件的 `package.json.repository` 指向本仓库，通过 Release URL 或下载包安装后，也会检查自己的后续正式 Release。默认排除预发布；升级安装本插件后需要重新加载才能运行新版代码。

## 在 DSH 对话中人工控制

可以直接说“把检查间隔改成 48 小时”“关闭自动更新，只保留检查”“开启自动更新”“现在检查并更新插件”。

| 接口 | 参数示例 | 行为 |
| --- | --- | --- |
| `plugin_updates_check` | `{}` | 立即检查版本，不安装；15 分钟 HTTP 缓存可复用 |
| `plugin_updates_status` | `{}` | 查看最近报告、检查时间和自动更新开关，不发网络请求 |
| `plugin_updates_schedule` | `{"action":"set","intervalHours":24}` | 每 24 小时检查，立即调整计时并持久化 |
| `plugin_updates_schedule` | `{"action":"set","intervalHours":0}` | 暂停所有定时检查和定时更新，仍可手动调用 |
| `plugin_updates_schedule` | `{"action":"get"}` / `{"action":"reset"}` | 读取间隔 / 清除人工覆盖并恢复插件配置值 |
| `plugin_updates_auto_update` | `{"action":"get"}` | 查看自动更新开关及最近更新历史 |
| `plugin_updates_auto_update` | `{"action":"set","enabled":false}` | 关闭自动安装，保留版本检查 |
| `plugin_updates_auto_update` | `{"action":"set","enabled":true}` | 开启自动安装 |
| `plugin_updates_auto_update` | `{"action":"reset"}` | 恢复插件配置的开关，默认开启 |
| `plugin_updates_auto_update` | `{"action":"run"}` | 按当前开关立即检查并更新 |
| `plugin_updates_auto_update` | `{"action":"run","packageName":"example-plugin","profile":"desktop"}` | 只更新指定已安装插件；名称为示例占位符 |

检查间隔支持 0～168 小时，非零间隔最短按 1 分钟计时。开关更改在当前安装结束后阻止后续更新，不强行终止正在执行的包管理操作。人工设置优先于原生配置；调用对应 `reset` 后重新使用原生配置。

## 自动更新怎样选择安装源

先从本地安装信息确定原仓库：用户配置 → GitHub 安装来源 → `.git` origin → `package.json.repository`。检查最近 30 条 Release，默认排除草稿与预发布；无可核对 Release 时检查最近 30 条标签，再降级查看分支版本。候选版本必须与仓库中的包名、版本匹配，使用 MIT node-semver 7.8.5 比较。

自动安装范围：

- **npm 正式包安装的插件**：从该 profile 配置的包源读取同名、精确版本包，重新核对其 GitHub 仓库、包名、版本和 DSH 要求，再通过官方 DSH CLI 安装。不会把另一个仓库的同名包当成原插件。
- **GitHub 或 tarball 安装的插件**：优先取对应 Release 的插件 `.tgz`，没有时尝试标签归档；核对安装包内容、包名、版本、可运行入口和 bundle patch。Release 提供 SHA-256 digest 时同时校验。只接受 GitHub 官方下载域名，跨域下载不传递 GitHub token。
- **本地 link/workspace 源码、仅开发分支的新版本、缺少可安装包的多包仓库、别名安装、缺少 GitHub 来源等情况**：在报告中说明原因，保留原安装。多包仓库需要插件专用 `.tgz`，或原本通过 npm 正式包安装。

每次安装固定到检查过的版本，关闭安装生命周期脚本，不自动批准构建脚本或 DSH 版本豁免。不适配当前 DSH / Node.js、需要构建但没有运行入口、包名不符或包摘要校验失败的条目会被标记。

安装前保存旧包 tarball 和 profile 的 manifest、lockfile、workspace 设置、patch。安装成功后回读包名、版本、入口及启用状态；失败且文件已改变时尝试通过官方 CLI 安装旧版本。回退也失败则标记 `needs_attention`，暂停对该插件的自动重试，供人工处理。备份及日志保留本地，不自动删除。

这里的“已更新”表示安装文件已核对，**不代表插件业务功能已在运行中重新验收**。不同插件、依赖和宿主版本可能仍需重新加载后检查。无法确认的结果不会显示为成功。不会自动合并本地源码或比较同版本的提交变化，不递归管理普通依赖，也不更新 DSH 内置核心包。

## 原生配置

在当前 profile 的 `cordis.patch.yml` 中设置已有条目：

```yaml
- id: plugin-updates
  config:
    autoUpdate: true
    intervalHours: 24
    checkOnStart: true
    startupDelaySeconds: 15
    allProfiles: true
    includePrereleases: false
    timeoutMs: 12000
    maxRequests: 40
    githubTokenEnv: DSH_GITHUB_TOKEN
    proxyUrl: ""
    repositories: []
```

`autoUpdate: false` 只关闭安装，`intervalHours: 0` 暂停全部定时任务。`checkOnStart: false` 在启动时不立即进行到期检查。插件只在 DSH 运行且启用时执行，不创建操作系统计划任务。

缺少来源或子目录时，可以通过可信本地配置补充：

```yaml
    repositories:
      - packageName: example-plugin
        repository: https://github.com/example/plugin-repository
        directory: packages/plugin
        profile: desktop
        ref: main
```

单包仓库省略 `directory`，跨 profile 适用时省略 `profile`。上例只是占位符。工具不接受模型临时传入任意 URL、命令或版本；可更新目标来自本地已安装条目和核对过的上游版本。

## 报告、数据与网络

默认报告位于 `$DSH_HOME/plugin-updates/<当前profile>/`，没有设置 DSH_HOME 时使用 `~/.dsh/`。

| 文件 | 用途 |
| --- | --- |
| `latest.html` / `latest.json` | 可读报告 / 完整结构化结果，含自动更新状态、安装及失败原因 |
| `cache.json` | GitHub ETag、HTTP 缓存和限流退避 |
| `schedule.json` / `auto-update.json` | 人工检查间隔 / 人工更新开关 |
| `update-history.json` | 最近 50 次安装记录及恢复结果 |
| `backups/` | 更新前的可安装旧包和 profile 文件 |
| `downloads/` | 核对过的 GitHub 安装包，安装规格可能持续引用这些文件 |

不要删除仍被 profile 安装规格引用的下载或备份包。同一主目录的自动安装通过共享锁串行进行；同一实例内并发调用合并。检查 GitHub 不超过单轮请求预算，默认 40 个；正式包安装及其依赖下载由官方包管理器单独处理。

公开仓库不强制 token。私有仓库或更高 API 额度可通过用户环境变量 `DSH_GITHUB_TOKEN` 配置，或用 `githubTokenEnv` 指定变量名；不会读取 DSH 凭据文件，也不会把 token 写入报告。GitHub 检查与归档下载支持配置的 HTTP/HTTPS 代理，其次使用 `HTTPS_PROXY`；正式包安装使用官方 CLI 的网络和账号配置。

报告、备份和历史可能含私有仓库名或本地 profile 配置，保留本地。HTML 报告没有远程字体、脚本或统计请求，重新打开或刷新查看新结果。

独立源码 CLI 保持只检查，自动安装在 DSH 插件运行中执行：

```powershell
node bin/check.mjs --offline
node bin/check.mjs --data-dir 'D:/DSH-update-report'
```

## 开发与验收

```powershell
npm run check
npm test
npm pack
```

源码使用本机 Node.js 和随包附带的 MIT semver，无需安装开发依赖。验证口径见 [docs/VALIDATION.md](docs/VALIDATION.md)。合成 GitHub 响应与真实平台联网、安装文件验证与业务功能运行验证分别记录。

维护者更新 `package.json.version`、CHANGELOG 和 `docs/RELEASE.md` 后，推送对应 `v<版本>` 标签即可触发 Release 工作流。工作流在 Windows / Linux 上运行检查，再生成 `.tgz` 和 `SHA256SUMS.txt`，最后发布正式 Release，供默认自动更新使用。不要替换已经公开版本的安装包；修正应使用新版本。
