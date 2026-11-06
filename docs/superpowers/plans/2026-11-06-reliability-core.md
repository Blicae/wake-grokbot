# RD-001-G-A 可靠性核心（B3 / B5 / 过期）调查与实施计划

- 基线：`16d0db06901cbf236e9b2b7be7c20ead9dbede95`（分支 `dev/0.1-repair-core`）
- 日期：2026-11-06（北京时间）
- 性质：仅计划；本提交不改任何实现。行号均相对基线 SHA。
- 负责：一号（core/store/main/core 测试）。`sinks.ts`/`config.ts`/`envelope.ts`/schema/示例/包版本文档归二号（B4）。B6 迁移不做；真实发送/发版仅 Lead。

## 0. 以 RD-001-G 接口冻结 v1 为准（覆盖下文冲突处）
- `deliver(reply, to, ctx)` 不变；core 传 `ctx.delivery = { taskId, replyHash, revision }`（类型 `DeliveryContext` 由一号在 `src/delivery.ts` 导出，二号 import）。
- `revision`：core 锁内按任务持久分配单调递增整数（task receipt `last_revision`），补发沿用原值；task/reply/hash/revision 写入意图文件 `state/pending-replies/<replyId>.json` 后才可能调 sink。
- `SinkResult` 加 `outcome?: delivered|not_sent|unknown`、`state?: delivered|duplicate|superseded|conflict|failed`；duplicate/superseded 视为已安全处理（不重投）。旧回复补发不得回退业务终态（status 仅当 revision > status_revision 才更新）。
- `sinkReplaySafe(to)` 由二号实现；core 以可选导入 + 本地兜底（file/hufu-report=true，其余 false）。幂等头 `x-wake-grokbot-delivery-id = reply.id`（二号）。
- core：`attempt_started_at` 先于副作用落盘；unknown 不自动重发；watch/recover 只补 replaySafe 或明确 not_sent。
- 人工补发：新命令 `redeliver <reply-id>`；状态 unknown 且 sink 非 replaySafe 时须 `--accept-duplicate-risk`，否则 exit 1 并说明风险。
- P2 定稿：不新增 WakeState。过期策略（send/ingest/pump 一致）：新 id 已过期 → send 与 ingest 均 exit 1，不写信封/receipt/队列（Lead 11-06 09:57 裁定；send 为契约修正）；已知 id 幂等优先（0/7）；已入队条目在 pump 唤醒前若过期 → 移出队列、`wake.state=not_started`、detail `expired at …; not woken`，业务 status 不变（不视为失败）。
- P3：不改 fsutil。P4：故障注入仅 `EngineOptions.fault` 测试钩子，默认关，无环境变量。
- P5：沿用退出码：交付 not_sent/unknown → 5（历史语义"已写入但未唤醒或 sink 失败"），冲突 7，规则拒 1。
- 本轮不升版本、不加 sink 别名、不真实发送。

## 1. 核实结论（静态阅读，未复现）

### B3 回复终态与 sink 交付耦合 —— 与票面一致
- `Engine.reply`（core.ts 332-406）：锁内（360-382）依次 `atomicCreate` 回复信封 → 写回复 receipt → 入 outbox 队列 → **把原任务 `r.status` 改为终态并 push `replies[]`**（373-379）→ markRead → settleInflight。
- 锁外再 `deliver()`（386-391）；结果仅写 `rec.sink_result` 字符串（392-399），失败只让 exit=5（401）。
- 后果（静态成立）：
  1. 业务状态先于交付变 `done`；sink 失败后 receipt 仍是 done，只有自由文本 `sink_result`。
  2. 崩溃发生在 382 与 399 之间：任务 done、`replies[].sink_result` 缺失，无任何持久化"待交付"标记 → 报告永不交付，且 `status` 看不出。
  3. `watch`（main.ts 250-259）只调 `pump()`（wake），**不扫描/补发 sink**。
  4. 同回复 ID 重试被拒（363：同 hash → EXIT.RULE，异 hash → CONFLICT），没有"重试交付"入口；换新 ID 重试会产生第二封回复并再次覆盖任务状态。
  5. `deliver` 无幂等键：webhook 体是整封 reply，签名时间戳每次新取（sinks.ts 79），接收方无法凭头去重（可用 `reply.id`，但未约定）。

### B5 accept 多文件落盘窗口 —— 与票面一致，且更严重一处
- `Engine.accept` 锁内（121-141）：W1 `atomicCreate` 信封(132) → W2 `writeReceipt`(134) → W3 `saveOutbox` 入队(136-138)。三个独立原子写，无日志/意图记录。
- 崩溃于 W1 后、W2 前：重发同信封 → `readReceipt` 为空 → 过期检查被 `findEnvelope` 跳过(126) → `atomicCreate` 抛 **EEXIST 原始错误**（非 CliError，退出码非约定）→ 永远卡死，既不补 receipt 也不入队。
- 崩溃于 W2 后、W3 前：重发 → 走 `old` 分支(127-129) 返回"already accepted"，receipt `wake.state=queued`，但 outbox 中无此 id → **永不唤醒**（静默漏队）。
- `reply` 锁内（364-381）有同构窗口 R1 信封 / R2 回复 receipt / R3 入队 / R4 原任务 receipt。
- `prune`（466-468）先记 pruned 再删，已正确；`markRead` 用 rename，幂等。

### 过期 —— 部分一致，有额外不一致
- `isExpired`（envelope.ts 165-169）：`t <= now` 视为过期。
- `send`（main.ts 192）**不传 `rejectExpired`**：可写入已过期信封；`ingest`（200）传 `rejectExpired: true`。语义不一致。
- 已知 id 优先：顺序 pruned → 过期（124-126）符合"幂等/冲突优先"；测试 expires.test.ts:73 已覆盖。
- `pump`（162-291）**不检查过期**：已入队但已过期的条目仍会被唤醒（"已接收后过期被误执行"的入口）。
- `expiredOpen`/`status`（main.ts 221, 288-299）用 `Date.now` 而非 Engine 的 `now` 注入，测试可控性差；仅只读展示。
- `reply`/`ack` 不看过期（合理：接收方已开始执行时不应被拦；需在计划中明确）。

## 2. 目标状态机

业务状态（receipt.status，不变，归 envelope 定义）：`queued → working → needs_input → done|failed|declined`。**只表达任务结果，不再隐含"已交付"。**

交付状态（新增，按回复记录，存于 `replies[i].delivery`，一号定义于 store.ts）：
```
pending ──deliver ok──▶ delivered
   │ └─deliver 明确失败(未发出)──▶ failed_retryable ──retry──▶ pending
   │ └─deliver 结果不明(超时/已发出未确认)──▶ unknown   （禁止自动重发；仅人工 mark）
   └─崩溃(pending 且 attempt_started)──▶ 恢复时：file/hufu-report → 可重放；webhook/command → unknown
```
- 字段提案：`delivery: { state, attempts, attempt_started_at?, at?, detail? }`；保留 `sink_result` 字符串以兼容读者。
- 写序：锁内先写 `delivery=pending`（与业务状态同一次 receipt 写），锁外 deliver 前写 `attempt_started_at`，之后写终态。
- 过期状态：不新增业务状态；在 accept/pump 层产生 `wake.state = "expired"`（新增 WakeState，提案见 §5）或复用 `not_started` + detail（兼容备选）。

接受流程恢复（B5）：以 **信封文件为单一事实源**，receipt/outbox 为可重建派生物。
- accept 遇"信封存在、receipt 缺失"且内容 hash 相同 → 补写 receipt + 入队（视作 fresh）；hash 不同 → EXIT.CONFLICT。
- accept 遇"receipt.wake.state=queued 但不在任何 queue/inflight" → 补入队。
- 新增 `Engine.recover()`（锁内、幂等），由 `watch` 每轮及 `status` 概览前调用：修复上述两类 + reply 窗口（R2-R4 缺失时按回复信封重建）+ 交付 pending 的崩溃恢复。

## 3. 与 sinks 的调用契约（供 Lead 定界）

**一号不改 `sinks.ts`，但依赖以下契约。**

当前事实（基线）：
- 唯一调用点：core.ts 386 `deliver(reply: Envelope, to: ReplyTo, ctx: SinkContext): Promise<SinkResult>`，`SinkContext={cfg,inbox,env,timeoutMs}`，`SinkResult={ok:boolean, detail:string}`。
- 时机：reply 锁释放之后、pump 之前；每次 `reply` 调用至多一次；core 无重试。
- 错误：`deliver` 内部 try/catch 吞掉异常转 `{ok:false}`（sinks.ts 56-58）；core 不区分"未发出"与"发出后不明"。
- 副作用：`webhook` → HTTP POST（net.postJson；`ok = r.state==="started"`，超时/网络错时可能已送达）；`command` → 执行外部进程；`file`/`hufu-report` → 本地原子写（可安全重放）。

一号对 sinks 的需求（B4 应提供的稳定接口面）：
1. **签名保持**：`deliver(reply, to, ctx)` 名称/参数不变；`SinkResult` 只做**加法**扩展。
2. **结果三分**：新增 `SinkResult.outcome?: "delivered" | "not_sent" | "unknown"`。
   - `not_sent`：可证明请求未离开本机（配置缺失、URL 无效、密钥缺失、连接拒绝前失败）→ core 可安全重试。
   - `unknown`：请求可能已到达（超时、连接中断、5xx 后不明）→ core **禁止自动重发**。
   - 缺省（旧实现）时 core 按：`ok=true→delivered`；`ok=false` 且 sink∈{file,hufu-report}→not_sent；webhook/command→unknown（保守）。
3. **幂等键**：webhook 请求附带稳定头（建议 `x-wake-grokbot-delivery-id: <reply.id>`），每次重试相同；`command` 经 stdin 的 reply.id 即键。core 只要求"同一 reply 重试时键不变"。
4. **可重放性声明**：导出 `sinkReplaySafe(to: ReplyTo): boolean`（或常量表）：file/hufu-report=true，webhook/command=false。core 恢复时据此决定自动补交付还是置 unknown。
5. **无隐藏重试**：sinks 内部不得自行重试有副作用的投递；重试策略全在 core。
6. **不读写 receipt/outbox**：sinks 不触碰 store；交付状态只由 core 持久化。
7. **异常约定**：继续保证不抛出（或抛出即视为 `unknown`，core 兜底）。

禁止重发 webhook 的保证点（core 侧实现）：
- G1 deliver 前持久化 `attempt_started_at`；恢复时见到它且 `!replaySafe` → 置 `unknown`，**不自动发送**。
- G2 `outcome=unknown` 永不进入自动重试；仅新 CLI `reply --redeliver <reply-id>`（人工、显式）或 `mark-delivery` 可推进。
- G3 `watch`/`recover` 只自动补交付 replaySafe sink 与 `not_sent` 状态。
- G4 测试以假 HTTP 服务计数请求次数断言（见 §6）。

若 B4 不提供 2/3/4：core 走缺省保守映射，功能可用但 webhook 失败一律需人工。

## 4. 一号实施范围与不改清单

改：
- `src/core.ts`：reply 拆为"锁内写业务+pending → 锁外 deliver → 锁内写 delivery"；新增 `redeliver(replyId)`、`recover()`；accept 的 EEXIST/漏队恢复；pump 跳过过期条目；同回复 ID 同 hash 重试 → 若交付未完成则走 redeliver 而非 EXIT.RULE（兼容见 §7）。
- `src/store.ts`：`ReplyRecord.delivery` 类型；`WakeState` 若经 Lead 同意加 `expired`；辅助 `allQueuedIds(ob)`。
- `src/main.ts`：`send` 传 `rejectExpired: true`（见 §7）；`watch` 每轮先 `recover()`；`reply --redeliver`；`status` 显示 delivery；`expiredOpen` 使用注入时钟。
- `tests/`：新增 `reliability-core.test.ts`，必要时扩展 crash.test.ts（只增不删）。

不改：`src/sinks.ts`、`src/config.ts`、`src/envelope.ts`、schema、examples、README/CHANGELOG 中的包版本段落、`package.json` 版本；不做 B6 迁移；不碰 channels 实现。

## 5. 需 Lead 协调的共享改动（提案，不擅自实施）
- P1 `SinkResult.outcome` + 幂等头 + `sinkReplaySafe`（sinks.ts，二号）。
- P2 `WakeState` 增 `"expired"`（store.ts 定义，但 `codeFor`、文档、schema 若枚举需同步，二号文档侧）；备选：不加，复用 `not_started`+detail。
- P3 fsutil：新增 `atomicCreateOrSame(file, data): "created" | "same" | "different"`，供 accept/reply 恢复判断；或一号在 core 内用 `readJson+contentHash` 自行实现，fsutil 不动（默认此方案）。
- P4 fsutil 测试钩子：故障注入需要可替换写函数。提案在 Store 增注入点 `store.hooks.beforeWrite(name)`（仅测试用），不改 fsutil 公共 API。
- P5 退出码：`reply --redeliver` 结果 unknown 是否用 EXIT.UNKNOWN（errors.ts 现有），需 Lead 确认文档描述。

## 6. 测试计划（先写失败测试，再实现；不删除/弱化既有测试）
故障注入方式：Store 测试钩子在指定写点抛出模拟崩溃，然后用新 Engine 实例（模拟重启）继续。

窗口清单：
- A1 accept：W1 后崩 → 重发同内容 = 补 receipt+入队，exit 0，唤醒一次；异内容 = 7。
- A2 accept：W2 后崩 → 重发/`watch` = 补入队，唤醒恰一次。
- A3 accept：W3 后崩（正常完成）→ 无重复入队。
- R1-R4 reply：每个落盘点后崩 → `recover` 后回复 receipt、入队、原任务 replies 与 delivery=pending 完整，无重复回复。
- D1 deliver 前崩（pending，无 attempt_started）→ 恢复自动交付一次。
- D2 deliver 中崩（attempt_started）：file/hufu → 自动重放一次，.DONE 正确；webhook → `unknown`，假服务器请求计数不增。
- D3 webhook 超时 → unknown，`watch` 多轮计数仍 1；`--redeliver` 后为 2 且幂等头相同（依赖 P1，未就绪则 skip 标记待办）。
- D4 sink not_sent（缺配置）→ 修好配置后 `watch` 自动补交，exit/状态正确；任务状态始终 done 不回退。
- D5 同 reply id 同内容重试：交付已完成 → 原行为（EXIT.RULE）；未完成 → 触发 redeliver。
- E1 `send` 过期 → exit 1 不写入（行为变更）。
- E2 入队后过期 → pump 不唤醒，wake.state=expired（或 not_started+detail），status/watch 列出。
- E3 已知 id 过期后重发：同内容 0 / 异内容 7（保持 expires.test.ts:73）。
- E4 reply/ack 对已过期任务仍允许（明确语义）。
既有：crash.test.ts:94 "killed mid-send … never resent" 保持通过；ratelimit/wake/report-loop 全绿。

## 7. 兼容影响与迁移（无 B6）
- receipt 新字段 `replies[].delivery` 为可选；旧 receipt 无该字段 → 视为历史，`sink_result` 以 "ok:" 开头 → delivered，否则 `unknown`（不自动重发）。不做数据迁移。
- `send` 拒绝过期信封：行为变更，exit 1；需 CHANGELOG 记一条（二号/Lead 负责文案）。
- 入队后过期不再唤醒：行为变更；可能出现以前会被唤醒的条目现在停在 expired。
- 同 reply id 重试：对未交付回复从 EXIT.RULE 改为补交付；已交付保持原码。
- `watch` 增加 recover 与 file/hufu 自动补交付：可能在升级后首次运行时补写此前失败的报告文件（本地、幂等）。webhook 不会被补发。

## 8. 验收命令（在本 worktree）
```
npm ci --ignore-scripts   # 仅在依赖缺失时；不发布
npm run lint
npm run typecheck
npm test
npm run build
node scripts/check-pack.mjs
# 安全扫描（可用则跑）：npm audit --omit=dev；gitleaks/semgrep 若本机已装
git diff --stat 16d0db0 -- src/sinks.ts src/config.ts src/envelope.ts schema examples   # 必须为空
```

## 9. 风险与停点
- 风险：reply 拆锁后并发 `reply` 同任务的顺序；以回复 sent_at+id 排序，测试覆盖。
- 风险：`recover` 在 `status` 中执行写操作改变"status 只读"语义 → 默认只在 watch/release/send/reply 前调用，status 只读展示。
- 风险：P1 未落地时 webhook 一律保守 unknown，用户需人工处理更多次。
- 停点 S1：失败测试写完、跑红后，报 Lead 确认窗口清单再实现。
- 停点 S2：任何需要改 sinks/config/envelope/schema 的点 → 停，提 Lead。
- 停点 S3：P2/P5 决议前，用备选方案实现并标注。
- 不 push、不合 main、不发版、不真实叫醒。

## 10. 实施记录（冻结 v1 后）
- 新增 `src/delivery.ts`（DeliveryContext / DeliveryRecord / ReplyIntent / ExtendedSinkResult，`replaySafe`、`outcomeOf` 本地兜底：可选读取 sinks 的 `sinkReplaySafe`，二号实现后自动生效）。
- 回复意图文件 `state/pending-replies/<replyId>.json` 先于一切回复文件落盘；`Engine.recover()` 由 `watch` 每轮调用；`redeliver <reply-id> [--accept-duplicate-risk]`。
- status 行加 ` report=<delivery.state>`；契约快照仅新增（help 一条命令；receipt `replies[].revision/delivery`、`last_revision`、`status_revision`）。
- 二号对接：`ctx.delivery` 已传；SinkResult 的 `outcome/state` 被 `outcomeOf` 识别。

## 11. 给二号的兼容文字（过期语义变更，Lead 11-06 09:57 裁定）
- **变更**：`send` 现与 `ingest` 一致：新 id 且已过 `expires_at` → exit 1，`envelope expired at <t>; nothing written`，不落信封、receipt、队列。此前 `send` 会写入。
- **不变**：已知 id（含崩溃后只剩信封文件的 id）先走幂等/冲突：同内容 0、异内容 7，不查过期；已 prune 的 id → 1。
- **新增**：已接收、排队期间过期的条目在叫醒前移出队列，`wake.state=not_started`，detail `expired at <t>; not woken`，业务 `status` 不变（不是失败结论），exit 5（"已写入未唤醒"）。
- 文档已同步：CHANGELOG 0.1.0 条目、docs/protocol.md、docs/engine-interface.md、docs/threat-model.md 中过期描述。README/安装文档未动。
- 测试：expires.test.ts 两条改为"用注入时钟在过期前接收"，属契约修正。

## 12. 整合时必须去掉静默兜底（待二号最终 SHA）
- 只读核对 3ab5bf8 `src/sinks.ts` 导出：`SinkOutcome`、`SinkState`、`SinkResult{ok,detail,outcome?,state?}`、`SinkDelivery{taskId,replyHash,revision}`、`SinkContext.delivery?: SinkDelivery`、`sinkReplaySafe(to: ReplyTo): boolean`、`DELIVERY_ID_HEADER`、`STATE_FORMAT`、`DONE_FORMAT`、`deliver(reply,to,ctx)`。与冻结 v1 一致。
- 整合时：`src/delivery.ts` 改为直接 `import { sinkReplaySafe, type SinkDelivery, type SinkOutcome, type SinkState } from "./sinks.js"`，`DeliveryContext = SinkDelivery`；删除可选反射与"旧 sink 推断 not_sent/unknown"兜底；`outcome` 缺失视为契约违反（按 unknown 并记日志），并加测试断言每次 core 调用的 SinkResult 都带 outcome。
