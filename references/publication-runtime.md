# 飞书上传优先与后续完善

`上架 / 请上架 / 确认上架` 在已交付的原批次保存 `publication`，绑定原发送人、聊天和实际绑定店铺。保存授权不改变创意任务的 ready 状态，不重新生图或重发资产包。发布状态独立为 requested、checking、needs_input、failed、submitted。

本地 `publication_executor.py` 由 `antigravity_executor.py` 轮询调用。线上发布能力来自实际在线执行器的心跳，不再固定为 false。缺少有效发布计划时只更新缺项，不调用 WB 写接口。资料补齐后在同聊天发送“继续上架”重新核验；指令去重，已有建卡、价格和库存断点保留。

## 私有发布计划

通过 `publication_executor.plan_path(task,config)` 确定路径：默认 `~/.config/wb-fission/publications/<任务ID的SHA256前16位>/<店铺>/plan.json`，可用私有配置 `PUBLICATION_ROOT` 调整。仅由维护 Agent/店主维护，不接受聊天指定本地路径或执行命令。

计划字段：task_id、source_nm_id、store、manifest_sha256、subject_id、warehouse_id、store_authorization_verified、facts_verified、visual_review_verified、base_price、currency、discount（50）、discount_stages（[30,50]）、payload、galleries。payload 使用 `construct_wb_cards_upload_payload` 的既有结构，十个 items 的标题/描述必须与已交付 manifest 一致，每项 version_id 唯一。galleries 按 version_id 提供现有1～30张可用图片，第一张哈希对应已交付主图，每套不可重复。少于八张时先上传，记录补图事项，不能用复制图片补数量。

store_authorization_verified 仅在实际卖家账户与目标店铺对应关系已核实后设为 true；内部店铺编号、有效令牌和仓库可访问不能单独证明目标正确。缺失或 false 时，包括重新发送上架命令的情况，都在获取凭据及任何卖家写入前停止。用户要求暂停后保留原资产与定价，不修改共享凭据或自动换店。此标记是维护者的核验记录，不是自动检测后续令牌变更的替代品。

品牌默认使用确认值；用户明确选择不填品牌时 payload 设置 `omit_brand:true` 且 brand 为空或缺省，建卡请求省略品牌字段。不能据此删除实物上的标识，也不能同时给出另一个品牌。包装参数须来自实测或已核验卖家数据；不能用 1×1 等默认数值补齐。用户明确确认的原值可以沿用。

facts_verified 代表建卡必需参数有实际依据；visual_review_verified 代表实际完成质量核查，两者不能伪造。图片质量与双平台对比可在上传后完善，visual_review_verified=false 不再阻塞建卡，也不自动改为 true。base_price、currency 与 discount 为确认的店铺定价输入，调价前读取新商品在目标账户中的实际币种（当前支持 RUB/CNY），源商品可以属于另一个店铺，梯度价格由既有 wb_pricing 按相同币种计算；不进行隐式汇率换算，不要把人民币价格当卢布或把未核实促销显示价直接使用。

## 执行和结果

先校验十款建卡必需资料、现有图片文件、计划/manifest 身份和目标店铺，再分配条码、创建卡片并上传现有图片。取得十个真实货号并读回图片记录后，保存 upload_verified=true、card_media_readback_verified=true、nm_ids；飞书立即可查询“商品上传成功”。随后继续 CDN 内容核验、梯度价格、折扣、目标仓库与新品5件库存。价格或仓库未确认不阻塞建卡，禁止用猜测值完成后续步骤。单个计划复用 cards.json 与 execution.json，不能通过删断点恢复执行。

折扣分两次：先提交30%，十款均读回确认后再提交50%；两阶段使用相同基准价格，不叠加折扣。各阶段独立记录提交与核验断点，前一阶段未生效不能进入后一阶段。价格任务未生效时只读回等待，不重复提交。按 WB 官方说明，新卡片需等待商品同步后再初始化库存，当前等待不少于30分钟；通过 resume_at 延后轮询，不阻塞生成任务。已经核验的库存不重复设为5，避免售出后自动补库存。提交价格或库存的响应不确定时只核验，不盲目重复写入。租约丢失后停止，过期记录标为需核对，避免重复建卡。

submitted 要求十个实际 nmID 以及图片、价格、库存读回成功；仍保存 storefront_verified:false。买家页面可见性另验，不能直接宣布平台审核通过。后续完善失败保留 upload_verified、真实货号、待完善清单和断点，不能报告整批上传失败；继续处理时复用现有卡片，不重复建卡。原创意包仍可下载。仓库不可用、身份变化、图片不足、数据错误均不能降级写入别店或使用另一商品。

此次修复没有将现有十张主图自动扩充/冒充八十张场景图。WB 1586452643 / RR010 的尺寸22×1×1厘米与不填品牌是用户新确认值；图库和图片核查完成情况仍须按证据填写。
