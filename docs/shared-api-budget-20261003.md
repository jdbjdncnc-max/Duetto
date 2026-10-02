# 与 Entangle 共用每日 API 预算

Duetto 的服务端模型请求现统一经过 Entangle `/api/budget/duetto-completion`，不再直接请求单独的模型供应商。Entangle 使用服务器配置的主上游密钥，Duetto 不向它传递原供应商密钥；Duetto 仍提供自己的提示词和模型 ID。请确认该模型 ID 在 Entangle 主上游可用。

默认复用已有 `context_url` 的网站来源和 `context_key`。如需指定独立入口，设置 `DUETTO_BUDGET_URL` 为完整预算接口地址、`DUETTO_BUDGET_KEY` 为 Entangle 网关密钥。不要使用原供应商密钥作为预算密钥。

先更新自己使用的 Entangle 后端，再更新本项目。这是自用 APP 的更新，不涉及应用商店上架、开放其他用户或改变仓库可见性。额度不足返回清楚的错误，不回退到直接付费请求。自动歌曲整理归入后台额度，用户主动问答归入聊天额度。此前已经存在的歌曲分析结果仍复用缓存。

本地完整 npm test 通过；核验预算请求发送到正确入口且不会转发原供应商密钥。未进行付费模型调用或线上验证。
