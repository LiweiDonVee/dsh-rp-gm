# DSH RP GM

一个供所有故事共用的原生 GM 插件。选择已审阅的角色、玩家身份与开场后，主 Agent 决定并提交事实，Database 保存状态，LastStep 呈现正文；Context 可选参与选材。无需为每张卡编写 runtime。

当前是 **0.1.0 / GM-B 开发检查点**，尚未发布。包含独立 owner 状态传输与恢复执行门。真实 rc.3 验收使用已打包的 Database、LastStep、Loop 和本地确定性模型；具体版本、SHA 与运行记录见 [原生验收](docs/native-acceptance.md)。

## 安装与依赖

| 组件 | 要求 |
|---|---|
| 官方 DSH | `0.2.1-rc.3` 起的受支持 0.2.x；本插件未验收 rc.2 |
| Node.js | 24 或更新受支持版本 |
| RP Database | 本轮 `0.2.0`，提供 `apiVersion === 2`、原子事实回执与 v2 来源绑定 |
| RP LastStep | 本轮 `0.3.0`，提供事实回执呈现、builtin profile 与因果分支继承 |
| RP Context | 可选，本轮 `0.2.0`，通过材料 facade 选材 |
| Loop Studio | 可选，已有 `0.1.0`；沿用主 Agent 的模型路由 |

先安装对应 Database 与 LastStep 版本。完全退出 DSH 后，将独立构建的 tarball 加入目标 profile，再重启：

```powershell
dsh plugin --profile desktop add ./artifacts/dsh-rp-gm-0.1.0.tgz
```

Web profile 将 desktop 改为 web。Windows 未配置 PATH 时，可用官方启动器：

```powershell
$gmCli = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'
& $gmCli plugin --profile desktop add ./artifacts/dsh-rp-gm-0.1.0.tgz
```

在宿主正常配置页选择可用的主模型，并将 tools 模式设为 native。writer／模块组装模型沿用 LastStep 的配置和可选 Loop 路由。GM 不保存 provider 凭据，也不自带付费模型配置。本地模型验收覆盖实际工具、日志与 owner 服务；故事质量仍取决于选用的模型。

## 不借助 StoryKit 开始

1. 点击会话顶部 **故事 GM**，或右侧页签中的 **故事 GM**。
2. 阅读原创公开样例“雨夜客栈”，在两个开场中选一个。
3. 点击 **开始所选故事**。插件固定资料版本、建立空 sources 绑定和 @session 初始状态、绑定 ready profile，随后提交一次普通原生首轮提示。
4. 面板显示原生会话 ID；在会话列表打开该故事，输入你的行动。

开场原文由真正的 `rp_begin_story` → `rp_present({factReceiptId})` 原生工具流程呈现，主模型不能替换所选开场。只有 canonical 成功呈现后，故事状态才变为进行中。示例对话是风格参考，不算已经发生的事件。

GM 面板显示场景与事实。正文、冻结材料、失败重试和候选稿在 LastStep 的 **最后一步** 面板阅读；可选 Studio 提供沉浸阅读入口。

![故事 GM 原生侧栏](docs/images/gm-sidebar.png)

依赖未安装时，故事库和诊断仍可打开，启动操作返回明确错误。连接中断时点击 **重试这个开局**：面板保留相同 launchId 和开场；启动日志只允许同一份已审阅输入继续，不会因重试另建会话或重置事实。完整页面关闭后，其他内容来源的调用方仍须保留原始 owner 请求以恢复部分启动。

## 事实与正文

- `rp_gm_state` 读取当前场景、已确认事实、Database revision 和当前回执。
- `rp_begin_story` 从绑定和 Database 取得已审阅开场状态，重复恢复返回同一有效开场回执。
- `rp_commit_turn` 校验 scene/facts，按实际原生工具来源提交一个原子批次。相同重试返回稳定回执；冲突返回 `TURN_ALREADY_COMMITTED` 与 `receiptId`。
- `rp_present({factReceiptId})` 单独终结呈现。GM 交给 LastStep 固定的 title、character、persona、examples 和公开方向包，Context 缺席时这些固定资料也会保留。

人类 readOnly／disabled／required 策略始终有效。注册事实只由事实 facade 提交；材料、临时备注和示例不能自行升级为发生过的事件。角色固定 description/personality/scenario 是来源资料，当前 Database 事实和已提交方向包优先。没有数值 RPG 引擎、NPC ACL、每卡代码或第二套世界真值。

writer 失败后事实仍已提交。继续使用原事实回执；已有冻结失败稿通过 LastStep 的 `rewriteOf` 流程重试。LastStep 的原生 **仅重试正文** 可以包含一次受限主模型分发和一次 writer 请求，复用原冻结材料，事实和模块组装不重跑。成功正文的表达候选使用 LastStep Draft API；同一事实回执不能以新工具上下文再次发表正式正文。

## 分支、回退与恢复执行门

`forkStory` 使用公开 session/fork。`rollbackStory` 选择最近普通事实回合的 turn/start 前一个有效前缀，创建子故事并保留原分支；不会删除原日志，也不会回退开场到非法空 head。子故事在 Database 前缀、LastStep 正确历史 profile/overlay 和可选 Context 计划就绪后才可继续。能力返回 `{rollback,fork,autoplay:false}`；通用 GM 没有旧 RP autoplay 驱动。

StoryKit 可在恢复前调用 plugin-only `reserveRestore`，占住已预检的目标 ID。reserved/restoring 状态会拒绝原生 play；`activateRestored` 必须验证同一 job 的绑定、真实 Agent、Database 状态、当前 ready profile 和应有的 canonical 开场，再解除执行门。两个方法不提交 prompt 或重播开场。

`StoryBinding.profile` 记录开局固定版本，作为来源保留。后续换风格与前缀继承由 LastStep 保存当前绑定；GM 不把它改回开局风格。恢复须保留初始版本并验证 LastStep 实际当前绑定可用。

`StoryBinding.sources` 同样只记录开局来源。当前资料组合从 Database 的 `effectiveV2` 读取；owner 追加文档或兼容重配后，GM 不同步第二份当前组合，也不会回绑开局列表。保存与恢复校验初始库的精确版本仍可读取，并验证 Database 当前注册事实、有效状态和真实回执。StoryKit 用已有 additionalDatabaseRefs 保留初始库版本。

GM 的四个 transfer 方法只传自己的 metadata。完整故事保存与恢复由 StoryKit 协调各 owner 和公开宿主 persistence；不能只导入 GM 就报告故事恢复完成。跨存储恢复中断时保持执行门。若宿主已创建 Session 而协调器尚未记录创建归属即崩溃，不能仅因日志相同接管已有 ID，须保留冲突供 owner 处理。

## 服务与 owner 路由

可选服务名 `rpGM`，`apiVersion:1`：

```text
startStory({launchId,title,character,persona,opening,examples,sources,profile?,initialScene,initialFacts,signal?})
binding({sessionId,signal?})
storyState({sessionId,agent?,signal?})
listStories({signal?})
presentation({sessionId,agent,factReceiptId,signal?})
forkStory({sessionId,atSeq?,signal?})
rollbackStory({sessionId,signal?})
reserveRestore({restoreId,sessionIds,signal?})
activateRestored({restoreId,sessionIds,signal?})
contentRevision({signal?}) -> {revision}
exportState({sessionIds,signal?}) -> {schemaVersion:1,revision,payload}
preflightRestore({sessionIds,state,signal?}) -> {supported,conflicts,requirements}
restoreState({restoreId,sessionIds,state,expectedRevision,signal?}) -> {revision,restoredSessionIds}
```

`presentation` 是 LastStep 的受信接口。它拒绝其他故事／失效来源／被后续事实取代的回执，以及已有正式呈现的回执；不会把 receiptId 塞进旧 packet 白名单。native 工具不接受 session、owner、source、turnKey 或 stage 参数。

`preflightRestore` 不要求目标 Session 已存在。`restoreState` 在 owner 队列中先校验结构、revision、真实 canonical 来源和已恢复依赖，再一次写入 restoring metadata；失败不改变数据或 revision。同 restoreId 与相同 payload/set 幂等，不同输入返回 `RESTORE_ID_CONFLICT`。安全无 prompt resume 后才执行 Agent 专属回执验证并 activate。`exportState` 取本 store 原子快照，检查生成状态与前后来源/revision；协调器持有跨 owner maintenance 锁，GM 不嵌套申请。

原生 owner Connection 路由：POST `/api/rp-gm/request`（library、startSample、startStory、state、binding）和 GET `/api/rp-gm/events?sessionId=…`。SSE 只有变更元数据，正文和事实通过授权 owner request 读取。具体边界见 [架构说明](docs/architecture.md)。

## 数据与备份

GM 自己仅保存 `${DSH_HOME}/app-data/rp-gm/state.json` 的 binding、启动进度、指纹、回执／来源指针和恢复执行门。它不保存 initialScene、initialFacts 或当前事实副本。没有 DSH_HOME 时使用用户 `.dsh`。

备份时关闭宿主，连同原生日志和 Database、Context、LastStep、Loop、StoryKit 各自的数据一起保留。仅复制 GM metadata 不能恢复世界状态、正文或依赖资产。动态 preset 每次加载重新注册，卸载时释放 disposer；不是写入 profile 的永久声明。

## 开发与验证

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm package
```

package 生成 `artifacts/dsh-rp-gm-0.1.0.tgz` 与 SHA256SUMS，并检查 tarball 中独立 bundle 的 host/client 可以加载、没有 sibling workspace 依赖。测试覆盖启动响应丢失、重复提交、政策、分支、回退、provider 原子性、恢复执行门和原生面板。真实隔离 home 验收入口见 [native runner](scripts/native/README.md)。

MIT License。
