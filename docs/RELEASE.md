# DSH 插件自动更新 v0.2.1

首次公开 GitHub Release，支持直接安装及后续自动更新。默认自动更新开启，每 24 小时复查；人工间隔、开关、暂停和立即执行接口均保留。

## 安装

```powershell
dsh plugin --profile desktop add https://github.com/InariNGT-Ofiicial/dsh-plugin-updates/releases/download/v0.2.1/dsh-plugin-updates-0.2.1.tgz
```

桌面版命令未加入 PATH 时，也可把上述 Release URL 交给桌面版内置 CLI，或下载 `.tgz` 后安装。需要 Node.js 24+、DSH 0.2.1-rc.2。安装后重新加载对应 profile。

## 内容

- 自动发现已安装插件的原 GitHub 仓库，核对包名和版本。
- 通过官方 DSH CLI 安装精确版本，保留配置与启用状态。
- 安装前备份旧包和 profile 文件，失败时尝试回退，异常结果持久化。
- 本地 HTML / JSON 报告、检查时间设置与自动更新开关。
- 本插件声明自己的 GitHub 来源，安装此版后可发现后续正式 Release。

## 验证与范围

- 离线测试覆盖版本比较、来源、下载边界、缓存、备份、回退及人工设置。
- 已在 DSH 0.2.1-rc.2 的隔离 profile 验证实际安装、合成插件自动升级及重启后加载；该场景使用合成 GitHub 响应。
- 实际 GitHub 发布包下载和自身升级验证另在发布后进行，结果以仓库验证说明及交付记录为准，不提前视为已完成。
- 本地开发链接、仅分支版本以及缺少可安装包的多包仓库会标记原因。安装脚本保持关闭；安装完成不等于插件业务功能已重新验收。自动更新不会自动重启 DSH。

附件包含安装包与 `SHA256SUMS.txt`。GitHub 自动提供对应标签的源码归档。
