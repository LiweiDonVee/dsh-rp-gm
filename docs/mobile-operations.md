# 手机与 PC 持续操作

`rpGM.capabilities.operations === 1` 提供 PC 持有的长操作。HTTP、SSE 和页面销毁只结束已受理操作的客户端等待；明确取消使用 `cancelOperation`。原有直接 service 方法的 `signal` 保留显式取消语义。GM Web 面板通过新接口提交事实操作，旧 `startSample` / `startStory` HTTP action 也以稳定 launch 凭据受理后等待。Android 的正文采用走 LastStep 自己的操作接口。

所有请求继续使用已认证的 `/api/rp-gm/request`，新增 action 如下。服务 `rpGM` 提供同名方法（不带 action）。

| action | 字段 | 返回 |
| --- | --- | --- |
| `submitOperation` | `sessionId?`, `operationId`, `kind`, `input` | `{schemaVersion:1, operation}`；新受理 202，重复 200 |
| `operation` | `sessionId` 或 `launchId`，`operationId` | `{schemaVersion:1, operation}` |
| `operations` | `sessionId` 或 `launchId` | `{schemaVersion:1, operations:[]}` |
| `cancelOperation` | `sessionId` 或 `launchId`，`operationId` | `{schemaVersion:1, operation}` |
| `cancelTurn` | `sessionId`, `expectedTurnStartSeq`（正安全整数） | 当前原生回合的精确取消确认，见下文 |

`operation` 包含 `operationId`, `sessionId`（launch 受理时即可保留）、可选 `launchId`, `kind`, `status`, `revision`, `createdAt`, `updatedAt`，以及可选 `result` / `error:{code,message?}`。时间使用 ISO UTC。输入、指纹和内部 controller 不在读接口中公开。

状态为 `accepted | running | cancelling | complete | failed | cancelled | interrupted`。接纳记录先同步文件并原子替换 GM 现有 `state.json`，然后派发并返回 202。并发同 ID 只有一次执行。同 ID 不同 kind、输入、预期版本或恢复目标返回 `409 OPERATION_ID_CONFLICT`。同 ID 同输入返回已有状态，包括失败和中断。不存在时返回 `404 OPERATION_NOT_FOUND`，客户端可以原 ID、原输入重新提交。

服务返回的新受理 envelope 带非枚举 `Symbol.for('dsh.rp.operation.accepted') === true`，供 Studio 等 HTTP 适配层选取 202；该标记不进入 JSON，也不是业务字段。

## 输入

`input` 禁止包含 `sessionId`、`operationId`、`signal` 或伪造命令来源；上下文由服务端注入。支持：

| kind | input |
| --- | --- |
| `decideFacts` | `roundId`, `candidateId`, `action:'approve'|'custom'|'cancel'`, `expectedRoundVersion`, `expectedDatabaseRevision`, `custom?` |
| `regenerateFacts` | `roundId`, `expectedRoundVersion`, `instruction?` |
| `resumeFactDecision` | `targetOperationId?` |
| `resumeFactGeneration` | `targetOperationId?` |
| `resumeFactPresentation` | `roundId`, `targetOperationId?` |
| `startStory` | 原 `startStory` 请求（包括 `launchId`，排除 `signal`） |

每次明确恢复意图使用**新的外层 `operationId`**，`targetOperationId` 指向原领域决定或生成 ID。目标只在同一 session 内查找，不授予跨故事权限。省略 target 时为兼容旧领域操作使用外层 ID。不同 target 也是不同输入，不能复用同一外层 ID。

```json
{
  "action": "submitOperation",
  "sessionId": "story-id",
  "operationId": "resume-intent-uuid",
  "kind": "resumeFactDecision",
  "input": {"targetOperationId": "original-decision-id"}
}
```

`startStory` 不要求已有 session。受理时预留 launch/session 映射，之后可通过 `{action:'operation',launchId,operationId}` 查询。重复同 launch 不另建 session、初始化事实或首条 prompt；命令、Database 回执、已确认候选和正文继续是各领域自己的权威。素材 DTO 见 `src/core.mjs` 的 `normalizeStart`，公开完整样例见 `src/samples.mjs`。

## 取消和恢复

取消前先定位具体操作；过期或已完成 ID 不会取消后来操作。取消响应可能为 `cancelling`，应继续查询。若取消与持久事实／候选完成竞争，服务核对实际结果后返回 `complete`；已生效事实始终保留。取消发生在事实已批准、正文尚未完成时，结果或领域快照可能保留批准回执和中断的正文状态，应按回执继续呈现，不能再次生成事实。

普通玩家行动通过 DSH 原生 `session.prompt` 提交。停止时客户端带上当前原生 `turn/start` 的序号，请求 `cancelTurn({sessionId,expectedTurnStartSeq})`。GM 核对 active 的 RP 绑定及恢复锁，再读当前 Agent 的 `ctx.agents.turnBoundaryOf(agent.session).openTurnStartSeq`。只有 Agent 正在 running 且序号精确匹配时，GM 在同一同步调用内执行 `agent.cancel({kind:'user'},{keepInbox:true})`。

响应为 `{schemaVersion:1,sessionId,expectedTurnStartSeq,accepted,observedTurnStartSeq}`；没有已知 open turn 时 observed 为 null。旧请求、已完成或已切到下一回合时返回 `accepted:false,reason:'stale-or-complete'`，不会取消任何回合，也不会排队等待下一回合。未知 RP 绑定为 `404 STORY_NOT_FOUND`，恢复锁为 `409 STORY_RESTORING`，尚未 active 为 `409 STORY_NOT_ACTIVE`，非法序号或额外字段为 `400 INVALID_REQUEST`。

宿主正常退出先把未完成接纳记录写为 `interrupted`，再结束领域执行；不伪装为用户取消。启动后只读原生精确 command run/done、Database 决定／候选确认和 LastStep 已接受正文，能够证明完成时补齐本地结果；否则保留 `interrupted`，不盲重放工具或模型。`resumeFactGeneration` 没有已保存候选时仍拒绝模型重生。startStory 已接受的首条 prompt 通过原 `promptRequestId` 核对，ACK 丢失也不重复发送。

### 原生持久化边界

DSH 0.2.2-rc.1 的内建 `session-checkpoint-policy` 在带 sessionId 的模型请求、顶层工具执行及 agent pre-step 前调用每会话 `sessions.flush`。普通 `rp_begin_story` / `rp_commit_turn` / `rp_propose_turn` 工具复用该保证。

原生 commands 的 run/done 是不进入回合的 log-only append，未强制 flush。GM 因此仅补两处 owner 义务：保存审批 intent／生成来源前先 flush 对应 command/run；把 successful command/done 用于事实 finalize／候选确认前再 flush。flush 失败不能应用事实或报告成功；明确恢复可复用已存在的精确命令，不重新调用模型。

`startStory` 的纯 RPC 接纳也不等待 agent pre-step：GM 在 exact `promptRequestId` 对应的 user/message 或 pending inbox 插入记录可持久读回后才保存 prompt checkpoint。完成仅表示首个请求已受理，不等待正文生成。持久 checkpoint 已存在但精确原生请求缺失时返回 `OPENING_REQUEST_UNCONFIRMED`，不会盲发新 prompt。

旧版本可能把 operation 写为 complete 时原生 command/done 还在缓冲。冷启动会核对这些历史 complete 的原证明；缺失时改为 `interrupted` / `NATIVE_COMPLETION_UNCONFIRMED` 并保留原结果与回执供核对。合法历史 complete 保持原结果，即使当前已进入后续回合或分支，也不改写为当前 round 的快照。不自动重新生成或重放事实。

### 阅读关联凭据

`storyState`（HTTP `action:'state'`）的顶层 `reading` 返回已知的 `openingRequestId` 和可选 `openingFactReceiptId`。前者来自 `store.launch(binding.launchId).promptRequestId`，子分支仍沿用原 launch，不按子 sessionId 猜测。旧数据缺少 launch journal 时省略未知字段；不通过文本匹配推断请求 ID。

阅读客户端只按这个精确 RPC ID 隐藏自动开场控制请求。普通聊天事件、用户自己输入的相同文本但不同 RPC ID，以及原生存档事件均保留。此元数据读取仅访问 GM store，不调用 LastStep narratives，也不引入跨服务递归。

接纳记录存于本 PC 的 GM `state.json` 顶层。纯操作状态更新使用自己的 revision，SavedStory 导出沿用原有内容修订号与事实、候选、审批和正文恢复路径。

客户端发送前保存稳定凭据。ACK 丢失时先查询；断线状态应显示“正在核对”，不能据此判定失败、取消或成功。SSE 仍仅发 `connected` / `changed` 元数据，不提供事件回放：先订阅，再读取 operation、review 和 story 快照，读取期间发生 changed 则重读。重新呈现已批准事实使用新恢复意图和原决定 ID。

本仓测试覆盖可控制的模型／宿主合同与原生 UI 组件，不代表真实模型质量、Android 模拟器或 ARM64 真机验收。
