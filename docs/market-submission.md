请求将原 Title Merge 投稿更新为 **zotero-centers**，支持 Zotero **10.0.x**。

- 仓库：https://github.com/mapengsen/zotero-centers
- 正式发行版：https://github.com/mapengsen/zotero-centers/releases/tag/v1.1.1
- 安装包：https://github.com/mapengsen/zotero-centers/releases/download/v1.1.1/zotero-centers-1.1.1.xpi
- 自动更新：https://github.com/mapengsen/zotero-centers/releases/latest/download/updates.json
- 插件 ID：`zotero-centers@mapengsen.github.io`
- 协议：MIT
- 分类：`metadata`、`utility`

集成原 Global Search、Inline Extra 和 Title Merge 的全部功能，另增加文库总数、目录及全部子目录的文献总数，以及按当前列表顺序从 1 编号的 Index 首列。「我的文库」总数包含未分类文献，各群组文库分别统计。无需安装三个独立插件，也不依赖 Zoplicate。包含跨文库原生列表搜索、短标题/其他/笔记行内编辑、右侧一键跨类型同标题合并与进度/停止操作。只统计普通文献，附件与笔记不占目录计数和 Index；同一条记录在多个子目录重复归类时，祖先总数只计一次。

主条目优先级为期刊论文 > 会议论文 > 预印本 > 其他，保留主条目字段并补空值。合并通过 Zotero 原生事务保留附件、批注、笔记、标签、分类和引用替代关系，另归档原始元数据。目录数量和 Index 仅用于显示，不写入文献字段。本插件没有遥测；更新检查由 Zotero 使用上述 GitHub 更新地址执行。

Windows / Zotero 10.0.8 独立文库已通过 84 项集成检查、20 项核心测试、5 项 SQLite 测试，包括跨类型合并、真实鼠标编辑、笔记原生保存与撤销/重做、笔记冲突和失败重试、合并后保留笔记、跨个人/群组搜索、文库与未分类文献总数、深层目录累计与去重、移动子目录、Index 数字在图标之前及原生箭头点击、排序筛选、启停清理及三个旧插件停用/恢复。其他操作系统尚未实测。验证报告见新仓库 `docs/validation-1.1.1.json`。

替代的旧插件仓库为 `mapengsen/zotero-title-merge`，旧采集器 PR 为 syt2/zotero-addons-scraper#305。请使用新仓库替换旧来源；新旧插件 ID 不同，用户需安装 Centers，由它自动停用旧插件，不能把新 XPI 当成旧插件 ID 的自动升级包。原 Global Search / Inline Extra 只有本地安装版，没有独立公开仓库。

请通过 `discoverReleases: true` 自动采集正式发行版；中文商店清单请求 `publishInShadow: true`，供维护者审核安装包及兼容范围后，在外部 scraper 更新前发布。保留两个投稿 fork，后续继续使用新仓库维护。

1.1.0 新增默认空白的「笔记」列，默认位于「出版物」后，单击可编辑；首次保存非空内容时创建原生子笔记，支持 Zotero 同步。已有普通子笔记不自动填入新列。

1.1.1 将 Index 列调整为数字在前、文献类型图标在后，附件展开箭头仍位于左侧。
