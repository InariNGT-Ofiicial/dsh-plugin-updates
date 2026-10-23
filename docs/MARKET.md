# 插件市场安装与展示

v0.2.2 增加 DSH 原生中英文展示信息、蓝白图标，以及 format 1 自定义市场索引。`dsh-plugin` 主题和包关键词用于支持 GitHub 搜索的第三方市场发现；是否默认收录由各市场维护者决定。本仓库未声称已进入某个第三方精选目录。

## 原生 Discover / 自定义索引

支持 DSH format 1 索引的市场中，添加：

```text
https://raw.githubusercontent.com/InariNGT-Ofiicial/dsh-plugin-updates/main/market/index.json
```

刷新后搜索 `插件自动更新` 或 `dsh-plugin-updates`，核对作者 `InariNGT-Ofiicial`、原仓库及版本，再安装。索引是维护者自己托管的来源，不是 DSH 官方推荐目录。

部分 DSH 版本需要先启用官方可选的自定义插件市场 bundle 才有 Discover；没有该页面时使用 README 的 Release `.tgz` 安装方式即可，不需要为了安装本插件先安装第三方市场。不同第三方市场的索引格式可能不同，不能把这个 JSON 地址当成通用格式。

市场安装源是固定到 **40 位发布提交 SHA** 的 Git 仓库，不使用移动的 main 分支或不受支持的 tarball 类型。安装后，自更新仍通过本插件的原 GitHub Release 检查。图标内嵌在索引中，不另外请求远程图片。

## 已安装插件展示

`locale/en.json`、`locale/zh.json` 和导出的 `package.json` 提供标题与说明；`icon.svg` 同时通过 manifest 与 `./icon` 导出。DSH 可在不执行插件的情况下读取元信息，适用于插件管理卡片、详情及设置列表。包内仍是已构建的 JavaScript bundle。

## 维护发布

发布新版本时，标签工作流在检查通过后生成安装包、校验文件及市场 JSON，先公开 Release，再只更新 main 的 `market/index.json`。索引提交与发布提交分离，避免自引用 SHA。索引生成时使用标签提交与该提交的 Unix 时间：

```sh
node scripts/market-index.mjs <40位标签提交SHA> <Unix秒数> dist/market-index.json
```

`scripts/publish-market.mjs` 只接受本仓库的 Actions 身份，只能写本仓库的该索引文件。无需用户 GitHub token，也不修改本地 DSH 配置。

协议依据：[DSH 插件元信息](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-package.md#plugin-display-metadata)、[市场格式](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/util/plugin-market-index)。
