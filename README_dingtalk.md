# 钉钉机器人配置指南

本文档介绍如何在钉钉开放平台配置机器人，获取 ClaudeTalk 所需的凭据和权限。

## 前置条件

- 拥有钉钉企业管理员权限（用于创建企业内部应用）

## 配置步骤

### 1. 创建钉钉应用

1. 登录 [钉钉开放平台](https://open-dev.dingtalk.com)
2. 点击「创建应用」
3. 选择「**企业内部应用**」
4. 填写应用信息：
   - **应用名称**：如 `ClaudeTalk`
   - **应用描述**：如 `Claude Code AI 助手`
5. 点击「创建」

### 2. 启用机器人能力

1. 进入应用详情页
2. 点击左侧菜单「**机器人与消息推送**」
3. 找到「**机器人**」卡片
4. 点击「**添加机器人**」或「**启用**」
5. 填写机器人信息：
   - **机器人名称**：如 `ClaudeTalk`
   - **机器人描述**：如 `Claude Code AI 助手`

创建机器人应用
![创建机器人应用](https://down-cdn.dingtalk.com/ddmedia/iwELAqNwbmcDBgTRDW4F0QWcBrCGJnmU7-17zQmWXqczAm8AB9IB61N7CAAJqm9wZW4udG9vbHMKAAvSABBoig.png)

开启机器人功能
![开启机器人功能](https://down-cdn.dingtalk.com/ddmedia/iwELAqNwbmcDBgTRC4QF0QZoBrB4hMu8Zv-y7wmWXMLES2oAB9IB61N7CAAJqm9wZW4udG9vbHMKAAvSABb4qA.png)

### 3. 配置消息接收模式（Stream 模式）

1. 在「**机器人与消息推送**」页面
2. 找到「**消息接收模式**」
3. 选择「**Stream 模式**」
4. 确认配置

> **说明**：这是 WebSocket 长连接模式，无需公网 IP 即可接收消息。与 Webhook 方式不同，Stream 模式更稳定且不需要配置服务器。

### 4. 获取 AppKey 和 AppSecret

1. 点击左侧菜单「**凭证与基础信息**」
2. 记录以下信息：
   - **AppKey**（Client ID）：格式如 `dingxxxxxxxx`
   - **AppSecret**（Client Secret）：格式如 `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

### 5. 发布应用

1. 点击左侧菜单「**版本管理与发布**」
2. 点击「**创建版本**」
3. 填写版本号和更新说明
4. 点击「**发布**」
5. 应用发布后才能正式使用

> **重要**：配置完成后，需要在左侧菜单最后一项【版本管理和发布】发布后，会自动启动机器人。在钉钉里给机器人发消息即可开始对话。

### 6. 将机器人添加到群聊（可选）

1. 在钉钉中打开目标群聊
2. 点击群聊右上角「...」→「智能群助手」→「添加机器人」
3. 搜索并添加你创建的应用

## 获取用户的 userId

如需配置白名单，需要获取用户的 `userId`：

1. 在钉钉中打开用户资料
2. 点击「复制钉钉号」或「复制用户 ID」
3. 复制的 ID 即为 `userId`

## 下一步

配置完成后，请参考 [ClaudeTalk 主文档](README.md) 进行以下操作：

1. 在项目目录下运行 `claudetalk --setup` 配置凭据
2. 输入钉钉的 AppKey 和 AppSecret
3. 运行 `claudetalk` 启动机器人

## 相关文档

- [ClaudeTalk 主文档](README.md) - 核心使用指南
- [飞书机器人配置指南](README_feishu.md)
- [钉钉开放平台文档](https://open-dev.dingtalk.com)
