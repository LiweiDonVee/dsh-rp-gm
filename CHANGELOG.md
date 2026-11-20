# Changelog

## 0.2.4

- 为事实提交与提案共用完整的场景、公开事实、方向包与 Database v2 操作 schema，兼容 DSH 0.2.2-rc.1 的工具 schema 子集。
- 公开变量在输入边界接受字符串、有限数字与布尔值并统一保存为字符串；错误指出具体字段及正确形状。
- 继续严格使用事实条目的 `{id,text}`，拒绝 `key`、`visibility` 等扩展，不将隐藏内容自动转为公开事实；事实审批与 Database 权限沿用。
- 提案允许与前序读取/检索同批，只要求是该消息最后一个直接工具调用；保留事实审批与精确来源，不允许工具排在终止调用之后。
- 事实再生只捕获模型生成当前消息前已可见的工具观察，排除同消息前序工具的输出，避免原生按序执行时被 Database 的事实捕获校验拒绝。

## 0.2.3

- 增加手机长操作的持久受理、状态查询和明确取消；断开客户端后，已受理的开局及事实审阅继续在 PC 执行。
- 通过 DSH 原生回合边界精确停止当前玩家回合，保留待执行输入。故事读状态公开精确开场请求与事实回执标识。
- 原生会话确认开场和审批命令时执行持久化同步。旧事实审阅、会话血缘、分支与存档接口沿用。

## 0.2.1 — 2026-10-31

- 配合 RP Studio 1.5.0 收纳会话顶部与空白页入口；Studio 运行时加载或卸载后，独立入口实时隐藏或恢复。
- 保留独立原生页签、导航指南和旧版 Studio 工作区贡献入口。
- 管理页与表单使用宿主 UI 字体、字号及统一标题层级；样式由插件自己的根节点约束。
- 原有事实、正文、资产和持久化接口保持兼容；本次界面原生验收使用 DSH 0.2.1-rc.5，既有验收记录保留原受测版本归属。

## 0.1.0 — GM-A fix round 1

- Keep failed branch setup gated through read-only observations; retry installed dependencies before native admission.
- Match Database inactive-turn selector errors and keep earlier active receipt recovery available.
- Bind native panel facts/errors to the selected story and ignore obsolete asynchronous reads.

## 0.1.0 — GM-A checkpoint

- Shared native GM preset, reviewed story startup and metadata-only recovery journal.
- Database-owned atomic fact receipts and canonical opening acceptance.
- Optional story discovery/state/presentation service, causal fork/rollback and restore execution gates.
- Original rainy-inn sample, standalone native panel, independent bundles and package verification.
- Contract fixtures and UI verification; actual registered-service/native acceptance remains GM-B.
