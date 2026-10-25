# DSH 新旧宿主兼容

本次维护同时支持 **DSH 0.2.1-rc.2 与 0.2.1-rc.3**。保留原有工具名、配置键、数据目录和人工设置；已有安装可原位升级，无需版本豁免，也不要求升级 DSH。未重跑模型训练、音频推理或真实平台写入。

插件使用 `engines.dsh: >=0.2.1-rc.2 <0.3.0`；直接引用的 DSH peer 允许 `rc.2 || rc.3`。声明范围用于安装检查，当前实测范围仅为上述两版，不保证所有后续版本。Node.js 随宿主使用 24+；独立脚本原有环境要求见 README。

GitHub Actions 在 Windows / Linux × 两个宿主版本上，打包后使用官方 `app-boot`、Cordis 和 ToolRuntime 检查 manifest、bundle patch、版本门禁、工具注册、参数 schema、输出校验与策略拒绝、渲染和卸载。测试只读/离线代表性调用，不代表 GPU、媒体处理、平台写入或桌面 UI 的完整业务验收。

## 复现

```powershell
node scripts/install-dsh-test-host.mjs 0.2.1-rc.2
node scripts/test-dsh-host.mjs
node scripts/install-dsh-test-host.mjs 0.2.1-rc.3
node scripts/test-dsh-host.mjs
```

测试宿主仅安装在仓库的 `work/dsh-host`，不读写用户 DSH profile、账号、凭据或会话。可用 `DSH_HOST_MODULE_ROOT` 指向已有官方运行时模块根目录；`DSH_TEST_PLUGIN_ROOT` 可指向解包后的发行包。宿主模块版本必须一致，测试不接受未声明的宿主版本。
