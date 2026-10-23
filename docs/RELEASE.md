# DSH 插件自动更新 v0.2.2

本次补齐插件市场与插件管理展示适配。默认开启自动更新、每 24 小时检查、手动设置周期和安装开关均保持原有行为，人工设置继续保留。

## 安装

```powershell
dsh plugin --profile desktop add https://github.com/InariNGT-Ofiicial/dsh-plugin-updates/releases/download/v0.2.2/dsh-plugin-updates-0.2.2.tgz
```

需要 Node.js 24+、DSH 0.2.1-rc.2。安装后重新加载对应 profile。

## 市场适配

- 增加导出的中英文名称与说明、作者和内嵌可用的蓝白图标。
- 提供 DSH format 1 自定义市场索引：
  https://raw.githubusercontent.com/InariNGT-Ofiicial/dsh-plugin-updates/main/market/index.json
- 市场安装固定到本版本的 Git 提交；Release 公开后工作流刷新索引。
- 未安装可选 Discover 的用户仍使用上面的 Release 安装；本说明不表示已被第三方精选市场收录。

## 验证与范围

运行 JavaScript 语法、离线测试、包内逐文件审计；市场格式和展示信息另使用 DSH 0.2.1-rc.2 本地原生读取器验证。上一版已完成真实 GitHub 发布包的自身升级与隔离宿主重启验证。本次不改变自动安装逻辑，也不等同于对全部第三方插件业务功能重新验收。

附件包含可直接安装的版本化 `.tgz` 与 SHA256SUMS.txt。安装完成后需要重新加载或重启 DSH，不自动重启。
