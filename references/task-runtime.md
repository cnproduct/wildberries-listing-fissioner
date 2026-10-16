# 执行服务与故障恢复

## 当前运行结构

Cloudflare Worker → SQLite Durable Object 任务协调器 → 常驻 Python 执行器 → 原生生成适配器 → 资产审查与导出。

Worker 健康接口的在线状态来自 45 秒内的执行器心跳；不能把网关在线当作执行器在线。发布能力由实际在线执行器心跳报告；上传结果与后续质量、价格库存完善分别记录，见 publication-runtime.md。

任务领取是事务操作。只有持有当前租约的执行器可续租或写入进度；租约 180 秒，执行期间每 15 秒续租。异常退出后，云端每分钟恢复失效租约；最多三次尝试，超过次数标明失败，不无限重试。

临时连接失败与真正失去所有权分开处理：超时、连接错误、HTTP 408/429/5xx 可在已确认的租约期限内重试；只有收到服务端成功响应才延长本地期限。HTTP 401/403/409 立即停止；持续断网接近租约到期也停止，不能无限延长占用。生成进程每5秒检查租约，即使没有新的图片进度也不能在所有权丢失后继续。已通过图片仍保留在任务断点中，恢复后只制作剩余图片。

KV 保留旧任务及供 WB 读取的公开商品图片。新请求与进度采用 Durable Object 的一致状态；旧版“ready”示意结果迁移后标为待核验，不丢弃历史记录。

## 私有配置

维护者在工作区外创建 ~/.config/wb-fission/executor.json，权限 0600。配置字段：

- GATEWAY_URL
- EXECUTOR_SECRET
- FEISHU_APP_ID、FEISHU_APP_SECRET、FEISHU_VERIFICATION_TOKEN
- OUTPUT_ROOT、FACTS_ROOT
- ANTIGRAVITY_ACCOUNT：明确选择已登录的账号；多个有效登录时不得默默换号。
- FISSION_GENERATOR_CMD：由维护者指定的命令 argv 数组，不能由客户输入。

生成程序从 stdin 接收任务、确认事实、抓取证据与输出目录；stdout 返回标准导出数据。错误与诊断只写 stderr，不能输出令牌。

当前适配器为 scripts/native_generation_adapter.mjs。依赖已安装的 antigravity-native-image Skill、本机 Antigravity OAuth 登录及项目配置，默认使用该 Skill 的文本/图像模型。模型失败时真实报错；不调整认证权限或绕过订阅限制。

可执行 --probe 验证真实原生文本调用。该探测不验证图片效果或配额；图片效果需要真实商品原图才能验证。

## 服务启动

macOS：

    python3 scripts/install_executor_service.py
    python3 scripts/antigravity_executor.py --once

登录服务 com.cnproduct.wb-fission.executor 会在用户登录时启动，并在进程退出后重启。配置值不写入 plist；日志只记内部错误类型与服务状态。

本机休眠、关机、断网时无法继续执行，云端会显示离线并保留任务。需要全天在线时，迁到常开主机并配置等效的进程监督与生成登录环境。不能把登录服务称为不受机器状态影响的 7×24h 服务。

## 缺项补充

从飞书发送原图会记录该消息的资源引用；执行器凭应用权限下载原图。图片引用失败时标明失败，没有图片时不绘制虚构替代商品。

可在同一对话发送“资料:”后附 JSON。允许逐次补充，任务事实会合并。字段参考：

- product_name、brand、category、composition、country
- length_cm、width_cm、height_cm、weight_kg：包装后的实际测量
- sales_quantity：真实销售数量
- barcode 或 barcodes：卖家确认的实际条码
- 不接受 source_verified、任意本地路径或别的消息资源引用作为聊天输入；原图校验由执行器完成
- verified_features：有依据的功能列表

不要提供猜测数据或把图片中无法证明的性能当作事实。维护者还可在 FACTS_ROOT/<nmId>.json 保存确认资料及原图路径。聊天提交不接受任意本机原图路径，以免跨任务访问本地文件。

## 状态与交付

waiting_executor → validating → generating_text → generating_images → reviewing → ready。

缺原图时进入 needs_input，补充后重新处理。生成图文不要求条码和包装参数。生成接口失败进入 failed，注明原因。ready 需要10条场景图文和压缩包的实际飞书发送回执，不是上架成功；自动多模态对照仍需要卖家复核。

原生适配器使用原图编辑场景，保持主体、颜色、数量、Logo 与配件一致；逐张对照检查，失败时不伪称通过。不会自动补尺寸、重量、品牌、原产国、价格、条码或虚构 EAN。

正式建卡载荷需真实 subject_id、属性 ID、卖家货号和条码，包含 weightBrutto；不硬编码保温杯类目。API HTTP 200 不等于商品发布成功。

## 部署

scripts/deploy_gateway.py 在本机临时目录打包，避免云盘祖先目录读取超时。通过 stdin 上传私有 Secret，不把凭证放入仓库配置。新版采用 *_V2 Secret 绑定以避免与旧版明文变量冲突。

    python3 scripts/deploy_gateway.py --wrangler /absolute/path/wrangler/bin/wrangler.js --dry-run
    python3 scripts/deploy_gateway.py --wrangler /absolute/path/wrangler/bin/wrangler.js

部署完成后，应分别验证云端版本、执行器心跳、目标请求状态、恢复机制和真实生成结果。不能仅凭部署命令成功宣告业务闭环。

## 飞书创意交付

scripts/wb_source.py 通过鉴权网关读取对应 nmId 的公共商品信息和原图，缓存来源、名称及实际下载文件。当前公共 cards/v4/detail 请求包含 dest 参数。CDN 路由属于非官方稳定接口，失败时明确进入 needs_input，请求原图；不能用别款商品替代。

scripts/creative_bundle.py 只校验10套不同图片、标题、描述与商品一致性，生成图文工作簿、Markdown、manifest 和 ZIP。scripts/feishu_delivery.py 上传图片后发送10条富文本图文及一个ZIP，仅发送原请求 chat_id。每条消息使用稳定 UUID，上传/发送回执保存在私有输出目录，重试复用，避免重复发送。

生成适配器写 progress.json，执行器同步已完成张数到云端。已通过图片和生成方案按任务保存，异常恢复不重新生成已通过结果。API /api/tasks/retry 仅允许维护者鉴权后恢复非执行中任务。

当前 WB CDN 路由从官方页面使用的 https://cdn.wbbasket.ru/api/v3/upstreams 获取，解析 mediabasket_route_map 的 range/mod 数据，优先推荐节点、回退原始节点。不执行远程 JavaScript，不仅靠固定 basket 区间表猜测。路由变更仍需检查实际下载的对应 nmId 原图。

飞书应用需开通 im:resource（获取与上传图片或文件资源）并发布版本。未开通时真实 API 返回 99991672；本次排查实际验证了该缺项。十套已生成但上传/发送失败时保留资产及回执，标为 awaiting_delivery。权限修复后在原聊天发送“重试”，复用成品继续交付。不能把生成完成误标为交付完成。


## 故障保护与兼容（2026-10-10 全面检查）

飞书事件先保存到协调器再确认收件。后台处理失败后每分钟恢复，事件独占领取，最多5次；健康接口 `pending_events` / `event_failures` 显示未完成和需维护者处理的事件。已完成事件删除原始消息内容。消息回复带稳定 UUID；商品请求、补图和重试都防重复处理。

各执行器分别记录心跳，任何在线且可生成的执行器均计入生成能力；无生成配置的执行器不会领取制作任务。历史任务仍可读，凭据副本在恢复扫描中清除；店铺凭据仅保留于独立账号记录。最新请求按 sender_id + chat_id 定位，旧索引仅在原聊天相同时回退。

新检查点采用原子替换。资产包在暂存目录验证后整体提交，ZIP 随包保存；失败不会留下半成品目录。恢复时核对商品事实、图片 SHA-256、manifest 和 ZIP。已接受图片的检查点绑定原图、场景、事实及生成图像校验值；缺少绑定的旧图片会重新审查生成，不把仅有文件视为通过。

新发送回执绑定任务、chat_id 与 manifest 版本，上传后发送前再次核验租约。缺少绑定或损坏的历史回执需要维护者先读取历史飞书消息核对，不会自动假设已发送，也不会删除记录盲目重发。已完成任务通过飞书“重试”保持完成状态；新批次重新提交链接。

独立发布模块只允许显式 `authorized=True`、`facts_verified=True`、私有 `checkpoint` 和全部卡片图片齐备后写入。真实包装长宽高须为正整数厘米、重量为有限正数，不能修改同款的材质、容量或品牌。请求前写入发布检查点；建卡结果不确定时只读回核查，不重复建卡。本地图片走 `/content/v3/media/file` multipart；`media/save` 仅用于公开图片 URL。读取图片记录后仍须人工核验前台状态、价格库存和图片一致性。


任务网关默认直连，不沿用本机系统代理。线上检查观察到系统代理路径返回带旧字段的任务快照，而直连返回新版；这不是判断另一位用户引起故障的依据。网关 JSON 响应带 `Cache-Control: private, no-store` 和 `Vary: Authorization`。确实需要代理的其他部署环境可由维护者显式配置 `GATEWAY_USE_SYSTEM_PROXY=true`，并重新核验新鲜任务快照。此设置不改变原生生成服务自身的代理使用。

## 模型输出格式恢复（2026-10-14）

文本模型的原图分析、场景规划和视觉审查采用 JSON 输出模式；`structured_generation.mjs` 对完整对象及各阶段结构进行校验。格式或结构异常最多重新请求 3 次，并保留原图、事实和具体校验要求。传输重试保持独立，质量审查返回合法的“不通过”不会被格式重试改成通过。新场景方案全部验证后才写入缓存。

格式重试耗尽以 `generation_response_invalid` 和 source_analysis / scene_plan / image_review 阶段记录；只给聊天受控原因，不回传模型原始内容。Native 适配器每次任务重新加载；Python 诊断代码须在无活动任务时重启执行器后生效。


## 宣传图混入原图集（2026-10-14）

原图集中可以包含品牌人物图或文字图。源图分析必须为全部参考图保留索引，允许非商品图的 visible_surfaces 为空；整体仍需至少一个有依据的商品机位。规划不能将空表面参考选作产品结构依据，每个方案仍按自己的源图验证角度。不能删图后错位原索引，也不能把上下文图虚构为商品正面。维护诊断接口支持限定 stage，失败解释显示原图分析/场景规划/图片审查阶段。


### 2026-10-14 原图编辑优先

新任务分镜策略为 `2026-10-14-source-edit-v3`：同批选定单一商品底图，每次编辑只发送该底图；保留标签、外形、颜色、件数、角度及摆放关系，仅修改外部背景。取消机位多样性要求与失败后的机位轮换，审查允许复用原主体。历史 camera-v2/v1 分镜保留原 policy 身份和 accepted 哈希，不自动重做已交付图。源图编辑是提示与审查约束，不是底层像素锁定；样图经用户确认后才批量重做。


## 发布执行

已接入 publication 独立流程和本地 publication_executor.py，详细计划、币种及双阶段折扣、图库核验和断点规则见 [发布执行说明](publication-runtime.md)。发布能力依实际心跳报告；ready 仍是图文交付完成，发布状态读取 publication，不用重新生成图文。
