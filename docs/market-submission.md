**zotero-centers** 已收录于 Zotero 中文插件商店，支持 Zotero **10.0.x**。商店通过现有条目自动采集正式发行版。

- 仓库：https://github.com/mapengsen/zotero-centers
- 正式发行版：https://github.com/mapengsen/zotero-centers/releases/tag/v1.2.1
- 安装包：https://github.com/mapengsen/zotero-centers/releases/download/v1.2.1/zotero-centers-1.2.1.xpi
- 插件商店：https://plugins.zotero-chinese.com/
- 自动更新：https://github.com/mapengsen/zotero-centers/releases/latest/download/updates.json
- 插件 ID：`zotero-centers@mapengsen.github.io`
- 协议：MIT
- 分类：`metadata`、`utility`

集成原 Global Search、Inline Extra 和 Title Merge 的全部功能，另增加文库总数、目录及全部子目录的文献总数，以及按当前列表顺序从 1 编号的 Index 首列。「我的文库」总数包含未分类文献，各群组文库分别统计。无需安装三个独立插件，也不依赖 Zoplicate。包含跨文库原生列表搜索、短标题/其他/笔记行内编辑、右侧一键跨类型同标题合并与进度/停止操作。只统计普通文献，附件与笔记不占目录计数和 Index；同一条记录在多个子目录重复归类时，祖先总数只计一次。

主条目优先级为期刊论文 > 会议论文 > 预印本 > 其他，保留主条目字段并补空值。合并通过 Zotero 原生事务保留附件、批注、笔记、标签、分类和引用替代关系，另归档原始元数据。目录数量和 Index 仅用于显示，不写入文献字段。本插件没有遥测；更新检查由 Zotero 使用上述 GitHub 更新地址执行。

1.2.1 支持按 DOI、标题等批量添加文献，或通过 Zotero 原生向导导入 BibTeX、RIS、Zotero RDF。右键可核对多来源元数据并原位更新已有条目。标识符和标题查询使用公开接口，用户可在预览里查看各来源的返回状态。

Windows / Zotero 10.0.8 独立文库验证见 `docs/validation-1.2.1.json`，包括打开原生文件导入向导、导入 RIS、查重、原位元数据更新和备份。

收录记录见 [中文插件商店 #357](https://github.com/zotero-chinese/zotero-plugins/issues/357) 和 [插件爬虫 #306](https://github.com/syt2/zotero-addons-scraper/pull/306)。
