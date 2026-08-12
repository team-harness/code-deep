# code-intel 演进建议

## 决策摘要

下一阶段应先修复两个已经复现、会直接损害审查可信度的问题，再补持续验证和外部调用的可靠性契约。`ReviewAnalyzer` 拆分、图查询并发、进程回收、更多 MCP 宿主和 `explore` 结构化均不应立即承诺；它们需要基准、所有权或用户需求证据。

优先顺序如下：

1. 消除首次自动初始化造成的审查输入污染。
2. 建立 PR/main 持续验证、包级 smoke 门禁并修正文档/协议漂移。
3. 用标注样本治理风险信号与排序可信度。
4. 为 Git、索引和 MCP 后端调用定义分阶段超时、取消与清理契约。
5. 用基准、所有权和用户需求证据决定后续性能、进程和集成方向。

## 当前状态

code-intel 的基础不是失控重构，而是可用产品上的定向加固：

- CLI、公共 `CodeIntelClient`、外层 MCP、`ReviewAnalyzer`、图适配器和持久 bridge 已有清楚边界；对外 MCP 仍只暴露 `explore` 和 `review`，应保持这一窄接口。
- TypeScript 使用严格检查；工程基线包含 `npm run typecheck`、当前测试套件、`npm run build` 和 `npm pack --dry-run --json`，并检查包入口、CLI 可执行位和固定的 CodeGraph `1.5.0` 依赖。
- bridge 已有连接复用、断线后一次重连和会话内索引去重；图分析失败、截断和低置信度会显式进入 warning 或风险信号，不会伪装为完整的低风险结果。
- 发布流程具备 tag/version 校验、npm 幂等发布和 GitHub Release 幂等创建，但唯一 workflow 只在 tag 或手动触发时运行（`.github/workflows/publish.yml:3-12`）；`prepublishOnly` 中的类型、测试和构建检查（`package.json:35-41`）没有形成 PR 反馈门禁。

目标用户仍是三类：通过 MCP 做改动前定位和改动后审查的 Agent，通过 CLI 排查的工程师，以及通过 `CodeIntelClient` 嵌入流水线的集成者。现阶段核心承诺是“可信、可解释、按风险排序的代码审查”，不是增加工具数量。

## 团队共识与分歧收敛

### 已达成共识

1. 当前架构和测试基线健康，不需要重写；窄公共接口、固定后端版本和只读进程诊断边界应保留。
2. `.codegraph/.gitignore` 污染和 `schema` 误判都有可复现失败路径，应先于 `ReviewAnalyzer` 大拆分修复。
3. PR/main CI、外部调用超时和文档一致性都是必要的工程加固，可与产品正确性修复组成同一近期阶段。
4. `architecture.md` 关于“仅显式 init”、53 项测试的描述，以及 README 中硬编码的旧包版本，均已与实现或当前版本漂移。

### 已解决的分歧

| 分歧 | 最终取舍 | 理由 |
| --- | --- | --- |
| 先做 CI，还是先修用户可见错误 | 首个窄改动先修首次污染；评分样本、评分修复和 CI 紧随其后 | CI 防止新回归，但不能纠正当前稳定输出的错误；首次污染成本最低且确定复现 |
| 先拆 `ReviewAnalyzer`，还是先修信号 | 先用回归样本保护正确性，再考虑拆分 | `src/review.ts` 已有 940 行，重构会扩大本可窄修的变更半径；性能收益尚未基准证明 |
| 进程数量是否足以支持 `gc` | 否；先补聚合、归属和退出残留遥测 | 复核样本中的进程均被归类为 active、shared 或 healthy，且 `suspect=0`、`cleanupCandidate=0`；数量不能证明泄漏或可安全回收 |
| top 3 是否必须不同分 | 否；改用带人工真值的相关性指标 | 合法的同风险项可以同分，强制分数不同只会引入任意 tie-breaker |

两个产品问题的适用范围也已校正：评分误报发生在 `schema`、`migration` 等高频但非敏感符号相关的 diff；首次污染发生在自动初始化且项目根未忽略 `.codegraph/` 的仓库。它们影响面大且伤害信任，但不是每一次 `review` 都必然发生。

## 排序建议

### 1. 零污染首次审查

**目标**：自动初始化不得把工具自己的索引产物报告为用户改动；干净工作树应给出明确的“无变更”结果。

**范围**：

- 仅在工作树模式中过滤 code-intel/CodeGraph 自身生成的索引路径，不改变 caller 提供的 `diff` 或显式 `base`/`head` 范围。
- 在摘要中显式记录过滤行为；干净树不再渲染空的 Changed symbols、Impact 和 Diff 段。
- 增加“新仓库、首次自动初始化、只修改一个用户文件”的端到端回归测试。

**证据**：`CodeIntelClient.review` 和 MCP `review` 会先确保索引；随后 `readGitDiff` 使用 `git ls-files --others --exclude-standard` 收集全部未跟踪文件（`src/review.ts:319-369`）。在项目根未忽略 `.codegraph/` 时，上游自我保留的 `.codegraph/.gitignore` 会进入同一次报告，实测一个用户文件被报告为两个文件。

**依赖与风险**：需要确认索引目录的稳定识别方式。写死路径可能隐藏用户有意审查的 `.codegraph` 内容，因此过滤只应用于隐式工作树采集，并在结果中可见。

**成功指标**：新仓库首次 `review` 对一个用户改动报告 `summary.filesChanged: 1`，且 `files`、Markdown 和 MCP `minimal`/`standard` 输出都不包含 `.codegraph`；干净树的 `summary.filesChanged` 为 0、`reviewItems` 为空且不渲染空的 Changed symbols、Impact 和 Diff 段；现有 range 和 caller-supplied diff 行为不变。若记录过滤信息，必须能区分“被工具过滤的路径”和“用户实际改动”。

**成本**：低，预计 0.5-1 天。

### 2. PR/main 持续验证与发布前 smoke

**目标**：把当前健康基线前移到每个 PR，并验证声明支持的 Node 版本和实际发布包，而不是等 tag 发布时才发现问题。

**范围**：

- 新增独立 verify workflow，在 `pull_request` 和主分支 push 上运行 `npm ci`、typecheck、test、build。
- 使用 Node 20、22、24 矩阵覆盖 `package.json:32-34` 的声明范围。
- 在一个 Node 24 job 中执行 `npm pack`，安装生成的 tarball，并做根导入、`code-intel --help` 和 bin 权限 smoke。
- 将 workflow 设为分支保护的 required check。

**证据**：当前 `.github/workflows` 只有发布 workflow，触发条件是 `v*` tag 和手动 dispatch；质量脚本虽然存在于 `prepublishOnly`，但不是 PR 门禁。

**依赖与风险**：依赖仓库分支保护配置。三版本矩阵会增加执行时间，可把 pack smoke 固定在 Node 24，其他版本只跑核心检查。

**成功指标**：所有 PR 和主分支 push 必须通过 Node 20/22/24 核心检查；Node 24 的发布包 smoke 必须验证 tarball 根导入、`code-intel --help` 和 bin 可执行权限；分支保护将 verify job 设为 required，发布 workflow 不再是第一处发现常规质量问题的地方。

**成本**：低，预计 0.5-1 天。

### 3. 风险信号可信度治理

**目标**：minimal 模式最稀缺的前三个位置优先呈现真实高风险改动，同时保留敏感正例召回率和确定性排序。

**范围**：

- 建立本仓库历史 diff 与代表性外部仓库的人工标注样本，至少覆盖敏感正例、普通 schema/类型常量负例、大文件多符号和测试证据场景。
- 给 `isSensitiveReviewTarget` 增加路径、符号种类或数据流上下文；不要只因名称含 `schema`/`migration` 就加敏感分。
- 将 `large-file-change` 从同文件所有符号共享的粗粒度信号，改为更贴近符号实际改动范围的证据；同分时只要求稳定排序，不制造虚假差异。
- 在 `tests/review.test.ts` 固化正例与误报负例，在 `tests/mcp-server.test.ts` 固化 minimal top 3 投影。

**证据**：`isSensitiveReviewTarget` 把 `schema` 加入词表（`src/review.ts:651-668`），命中后单项增加 25 分（`src/review.ts:508-514`）；`large-file-change` 使用整文件增删行数给同文件符号统一加分（`src/review.ts:562-569`）。实测 `REVIEW_OUTPUT_SCHEMA` 被判为 high 52/100，而 MCP minimal 响应只保留前三项（`src/mcp-server.ts:278-282`），误报会占用三分之一展示位。

**依赖与风险**：需要先约定样本真值和最低召回门槛。过度降权可能漏掉真实认证、权限、支付或迁移风险，不能用删除词表代替评估。

**成功指标**：先在冻结样本上记录基线，再设定 `precision@3`、敏感正例 recall、误报率与同输入排序稳定性的门槛；`REVIEW_OUTPUT_SCHEMA` 这类协议/类型常量负例不得仅凭名称进入 high。指标必须注明候选集范围：当 `symbolsOmitted > 0` 时，precision@3 只对已分析候选计算，或先完成不依赖图查询的全量轻量排序；任何指标退化都由 CI 阻断。

**成本**：中，预计 2-4 天，其中样本建设先于评分调整。

### 4. 外部调用超时、取消与清理契约

**目标**：Git、首次索引或 MCP 后端不响应时，CLI、外层 MCP 和库调用都能在有界时间内失败，并允许下一次调用恢复。

**范围**：

- 分别为 Git、索引和图查询定义可配置阈值，不用一个短超时覆盖大型仓库首次索引。
- 在公共调用链传递可选 `AbortSignal`；超时或取消后终止 code-intel 直接拥有的子进程，重置 bridge 的 connecting/client 状态。
- 错误必须包含阶段、项目路径和时限；新增永不响应的 fake server、索引 runner 和 Git fixture。

**证据**：bridge 的 ensure/connect/call 链路直接等待（`src/codegraph-bridge.ts:32-45,80-130`），索引 spawn 没有 timer/signal（`src/project-index.ts:135-154`），Git `execFile` 只配置 cwd、encoding 和 maxBuffer（`src/review.ts:319-369`）。现有测试覆盖崩溃重连和连接期间关闭，但未覆盖永不响应。

**依赖与风险**：需要确认 MCP SDK 的 timeout/abort 接口和跨平台子进程终止策略。阈值过短会误伤大型仓库，因此必须按阶段配置并保留诊断信息。

**成功指标**：第一阶段先让模拟挂起的 Git、index、connect 和 call 在各自配置的阈值内返回带阶段/路径/时限的错误；第二阶段再验证 `AbortSignal` 取消、直接子进程终止、bridge 状态重置，以及同一 client 的下一次调用可以成功。清理范围仅限 code-intel 直接创建的子进程，不触碰 CodeGraph 共享 daemon。

**成本**：中，预计 2-4 天。

### 5. 契约一致性与证据门控的后续探索

**目标**：先消除已知文档/协议漂移，再用测量决定是否投资性能、进程生命周期和更多集成面。

**范围**：

- 修正 `architecture.md` 中“仅显式 init”和 53 项测试的旧描述，移除 README 中硬编码的旧包版本；以结构/行为断言保护核心 `ReviewReport` v1 到 MCP 投影 v2 的同步。
- 为 `ReviewAnalyzer` 记录不同仓库和 diff 规模的分阶段 p50/p95、图调用数、失败率和资源峰值；只有图查询被证明是瓶颈后，才拆分职责并引入有界并发。
- 为 `ps` 增加按宿主/项目聚合、归属 token、启动来源、父连接状态和宿主退出后残留率；只有出现 stale registry、父进程消失或可验证所有权时，才设计默认 dry-run 的回收命令。
- 先提供第三方宿主配置模板或 `--print-config` 并收集需求；`explore` 结构化输出也先验证集成者是否需要，再承担上游文本解析契约。

**证据**：MCP 已说明首次 `explore`/`review` 自动初始化（`src/mcp-server.ts:37-47,214-235`），但 `architecture.md:123,239` 仍描述仅显式 init；`architecture.md:307` 的旧测试基线也已落后于当前测试套件。installer 只有 Codex/Claude（`src/installer.ts:14,59-71`），`CodeIntelClient.explore` 仍返回原始字符串（`src/client.ts:33-39`）。`ReviewAnalyzer.analyze` 当前顺序执行最多 20 次符号、12 次影响查询和一次 explore，但这只是理论调用上限，不是已证实的用户瓶颈。

**依赖与风险**：文本快照过细会产生维护噪声，优先断言结构和行为。性能并发可能放大 daemon 负载并破坏结果可复现性；进程回收若无强所有权证据可能误杀共享服务；第三方宿主格式会增加持续维护成本。

**成功指标**：文档漂移（自动初始化、测试基线、包版本）在近期阶段修正并由检查保护；核心 `ReviewReport` v1 到 MCP 投影 v2 的字段/截断行为由契约测试保护。性能、进程和安装方向都必须有预先记录的基线、决策阈值和 go/no-go 结论，未达到阈值则不进入实现路线。

**成本**：文档与契约检查 1-2 天；其余先安排 2-3 天 discovery，再依据证据估算实现。

## 阶段路线图

| 阶段 | 时间盒 | 交付 | 退出条件 |
| --- | --- | --- | --- |
| 近期 | 第 1 周 | 首次污染修复与回归测试；自动初始化/测试基线/包版本文档漂移修正；PR/main verify workflow 与 Node 24 tarball smoke；核心/MCP schema 契约测试 | 新仓库只报告用户改动，干净树返回 0 个变更；核心报告与 MCP 投影字段及截断行为一致；当前测试套件、Node 20/22/24 核心检查和 Node 24 tarball smoke 全部通过 |
| 中期 | 第 2-3 周 | 风险评分标注集；敏感信号上下文与大文件粒度调整；Git/index/MCP 阶段级 timeout；随后补 AbortSignal、取消和直接子进程清理 | 冻结样本上的 precision@3、敏感 recall、误报率和排序稳定性达到预设门槛；所有挂起 fixture 在对应阶段阈值内失败，并验证取消后的 bridge 可恢复 |
| 长期 | 第 4 周后，按证据启动 | ReviewAnalyzer 基准后的拆分/并发；进程生命周期策略；宿主扩展；explore 结构化 | 每个方向都有基线、所有权边界和 go/no-go 阈值；没有证据则维持现状 |

近期工作可以并行，但发布顺序应保持：先合入首次污染的窄修复，再接入 PR/main CI 与文档契约检查，随后用冻结样本保护评分正确性；大模块重构不得成为这些工作的前置。

## 不进入当前承诺的事项

1. 不因单次看到 75-77 个进程就实现 `gc`；复核没有发现 suspect 或 cleanup candidate。
2. 不要求 top 3 必须不同分；相关性和召回率比视觉区分度重要。
3. 不先拆分或并发化 940 行 `ReviewAnalyzer`；先测 p50/p95 和资源峰值。
4. 不扩大外层 MCP 工具面；第三方宿主与结构化 `explore` 先验证需求。

## 两分钟内可启动的动作

新建一个 issue，标题为“首次自动初始化不得把 `.codegraph` 产物计入工作树 review”，正文只写复现步骤和验收句：在未忽略 `.codegraph/` 的新 Git 仓库中首次运行 `review`，一个用户文件改动必须得到 `filesChanged: 1`。这会成为第一项实现和回归测试的共同边界。
