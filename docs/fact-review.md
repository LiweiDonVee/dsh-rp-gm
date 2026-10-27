# 事实审批与两种重新生成

新故事默认直接提交事实。插件配置 `factApprovalDefault` 默认 `false`，只决定新故事的初始设置；原生 GM 面板的“本故事先审批事实”持久保存每个故事的设置。旧故事缺字段按关闭读取。设置只在空闲时修改，并校验 revision。

开启后，GM 的 `rp_propose_turn` 保存完整候选并结束当前原生回合。面板显示当前已生效事实、候选变化及完整公开方向。通过、重试事实、自定义和取消是不同操作；自定义场景、事实与公开方向由人类精确提交，不经过模型改写。候选等待期间不能用另一个事实提交绕过审批。关闭开关也不会自动批准当前候选。

owner 请求的调用方在发起操作前生成 `operationId`，重试时复用同一身份；原生 UI 在请求前生成，自动采用流程的映射身份由 GM 持久保存。服务器将它绑定到规范化的不可变请求 SHA-256，据此发起真实 `/rp-gm-fact-decision` 命令。handler 验证准确 `commandId` 关联的公开 run，只记录 intent。对应的真实成功 done 可见后，Database 才应用选定事实并生成回执。run-only、失败命令和状态标记都不是成功事实。事实被接受后，即使正文失败也不会撤回事实。

**事实重生** 仅面向最近普通回合，使用被捕获的回合前 scene/facts、玩家输入、角色资料与已取得工具结果。模型只请求一次，通过 `rp-gm.revise` 的实际 Loop 路由选择模型；未设路由时沿用当前原生模型设置。请求不带原生历史或工具。输出先暂存，真实生成命令成功后才发布为待审候选。原工具与固定工作操作不会重放；模型的自然语言一致性仍须由人类判断。没有可靠基线的旧回执显示不可用。

审批周期内重试始终保持待审。对已接受回合发起新一轮事实重生，则捕获当前开关；关闭时由独立真实决定命令自动采用，而后正常写作。新事实供后续 GM 和 Database 使用，旧事实与正文保留审计。GM 原生历史不被重写；Database 当前回执／revision 才是当前事实权威。

**正文重新生成** 独立调用 LastStep，读取其实际有效 NarrativeRef，并复用该事实版本的完整冻结 composition。正文生成阶段只重跑 writer，不重新判断事实、不运行 GM 工具、Context 或模块组装；原生 owner 调度可能另有受限主模型请求，须与 writer 分别计数。新正文成功接受后成为有效正文；失败保留原有效正文。所有原始结果只追加，不替换旧日志字节。

恢复按钮有固定边界：

- `resumeFactDecision` 只确认／应用原决定，全程零模型。
- `resumeFactGeneration` 只结算已保存的候选，全程零模型；关闭审批时可继续独立决定，但返回 approved + presentation not-requested。没有已保存候选时返回 `GENERATION_NOT_STAGED`，应明确发起一个新操作。
- `resumeFactPresentation` 才开始或重试写作。它使用同一个已接受回执及持久 presentation operation，不重复提交事实。

“自定义不调用模型”指人类事实 payload 不经事实模型改写；正常通过／自定义后的写作不是全模型零调用。只有 `resumeFactDecision`、`resumeFactGeneration` 两个结算恢复端点全程零模型；未冻结的已批准事实首次呈现仍可能需要 Context、组装与 writer，以及原生主模型调度。

确定性的事实基线或权限拒绝保留审计并释放该 intent；同一失败操作不会在权限改变后偷偷生效。重新通过／自定义／取消需新的 operationId。I/O 或取消等暂态故障保留最近持久状态供恢复。

分支继承设置与 Database 的实际前缀事实。父 generation/request/hash 不重绑为子任务；子分支审核候选时生成新的子 operation。继承的已生效、未呈现事实可在子分支单独呈现，使用子分支自己的 LastStep operation，不再次 finalize 父决定。SavedStory 传输只由各 owner 校验自己的数据；旧 payload 仍以关闭设置读取，新功能数据要求对应能力。

本仓库聚焦测试使用明确的 Database、LastStep 和宿主合同 fixtures，组件结果单独记录。后续 V6 实际产品包已在官方 rc.3 隔离 home 完成审批／两层重生五组功能断言，包含真实命令、done、原生工具终止、两个实际中断窗口及全部模型计数。受测身份、冷恢复、跨 home 与发行验证边界见[当前原生证据](native-acceptance.md)。
