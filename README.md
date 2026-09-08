# Cloud Mail Webhook Worker

Cloud Mail 收到邮件后，将真实邮件格式转换并同时推送到 Telegram、企业微信自建应用、飞书、Discord，以及可选的其他 HTTP API。

## 已核实的 Cloud Mail 请求协议

Cloud Mail 向配置的 URL 发起 `POST`，请求头为 `Content-Type: application/json`。在 Cloud Mail 的 **Webhook 密钥** 非空时，还会发送 `Authorization: <密钥>`。本 Worker 以该请求头验证身份；不要使用 URL 查询参数传递密钥。

请求体（附件不会出现在 payload 中）：

```json
{
  "emailId": 1,
  "sendEmail": "hello@example.com",
  "sendName": "hello",
  "toEmail": "admin@example.com",
  "toName": "admin",
  "subject": "Hello",
  "text": "Hello",
  "content": "<div>Hello</div>",
  "code": "123456",
  "createTime": "2099-12-30 23:59:59"
}
```

## 部署

```bash
cd cloud-mail-webhook
npm install
npx wrangler login
npx wrangler secret put WEBHOOK_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler deploy
```

其他渠道按需设置对应 Secret；未设置的渠道会自动跳过：

| Secret | 用途 |
| --- | --- |
| `WECHAT_CORP_ID` | 企业微信管理后台“我的企业”中的企业 ID |
| `WECHAT_APP_SECRET` | 企业微信自建应用的 Secret |
| `WECHAT_AGENT_ID` | 企业微信自建应用的 AgentId |
| `WECHAT_TO_USER` | 接收消息的成员 UserID；多个成员用 `|` 分隔。可用 `@all` 发给应用可见范围内的全部成员 |
| `FEISHU_WEBHOOK_URL` | 飞书群机器人 Webhook 地址 |
| `DISCORD_WEBHOOK_URL` | Discord Webhook 地址 |
| `OTHER_WEBHOOK_URL` | 任意兼容 JSON 的 HTTP API；会收到 `event`、`email` 和 `originalPayload` |

本地开发可复制 `.dev.vars.example` 为 `.dev.vars` 后执行 `npm run dev`。`.dev.vars` 含密钥，已被 Wrangler 默认忽略，不要提交。

### 仅通过 Cloudflare 网页界面部署

此方式适合不使用 Git 或本地终端的场景。它与上面的 Wrangler 命令行部署二选一；不要将不同版本的代码交替从两处部署，以免难以判断当前线上版本。

1. 登录 Cloudflare 控制台，打开 **Workers 和 Pages** → **创建** → **创建 Worker**，填写名称，例如 `cloud-mail-webhook`，然后点击 **部署**。
2. 进入刚创建的 Worker，点击 **编辑代码**（有的中文界面显示为“快速编辑”）。打开本项目的 [src/index.js](./src/index.js)，复制其**全部内容**，覆盖编辑器中的示例代码。
3. 点击编辑器右上角的 **部署**。部署完成后记录 Worker 的 `https://<worker>.<subdomain>.workers.dev` 地址。
4. 打开 Worker 的 **设置** → **变量和机密**（或 *Variables and Secrets*）→ **添加**。所有下表中的值都选择 **机密（Secret）** 类型，而不是文本变量；逐项填写名称和值。
5. 点击页面底部的 **部署** / **保存并部署**，使变量进入生产版本。随后用本文末尾的 `/test` 验证。

| 必填 Secret | 值 |
| --- | --- |
| `WEBHOOK_TOKEN` | 自己生成的高强度随机字符串；稍后在 Cloud Mail 的 Webhook 密钥中填写相同内容 |
| `TELEGRAM_BOT_TOKEN` | Telegram BotFather 提供的机器人 Token（若启用 Telegram） |
| `TELEGRAM_CHAT_ID` | 接收 Telegram 消息的 Chat ID（若启用 Telegram） |
| `WECHAT_CORP_ID` | 企业微信企业 ID（若启用企业微信应用） |
| `WECHAT_APP_SECRET` | 企业微信自建应用 Secret（若启用企业微信应用） |
| `WECHAT_AGENT_ID` | 企业微信自建应用 AgentId（若启用企业微信应用） |
| `WECHAT_TO_USER` | 企业微信接收成员的 UserID（若启用企业微信应用） |

飞书、Discord 和通用 API 的变量见上方“其他渠道”表，按需添加即可。修改代码时重复第 2–3 步；修改变量时重复第 4–5 步。Cloudflare 的 Dashboard 对变量/机密需要通过 **Deploy** 才会应用到 Worker 版本。[官方变量说明](https://developers.cloudflare.com/workers/configuration/environment-variables/)

> 若 Dashboard 没有出现“部署”或“保存并部署”按钮，或保存后 `/test` 仍读取不到新变量，请使用更可靠的 `npx wrangler secret put <变量名>` 设置该变量；此命令会创建并立即部署一个新版本。不要将 Secret 写入在线代码或 `wrangler.toml`。

### 企业微信自建应用配置

本 Worker **不再使用** `WECHAT_WEBHOOK_URL` 群机器人变量，而是通过企业微信自建应用发送消息。按以下步骤配置：

1. 登录企业微信管理后台，进入 **应用管理 → 自建 → 创建应用**（已有应用可直接使用）。
2. 在应用详情中记录 `AgentId` 和 `Secret`；在 **我的企业** 中记录企业 ID（CorpID）。
3. 在应用的 **可见范围** 中加入需要收取通知的成员，并确认应用处于启用状态。
4. 到 **通讯录** 获取成员的 **UserID**。它不是手机号、昵称、邮箱或微信号。多个接收人用竖线 `|` 分隔；需要通知该应用可见范围内所有成员时填 `@all`。
5. 在 Worker 项目目录执行下列命令并依次输入对应值：

```bash
npx wrangler secret put WECHAT_CORP_ID
npx wrangler secret put WECHAT_APP_SECRET
npx wrangler secret put WECHAT_AGENT_ID
npx wrangler secret put WECHAT_TO_USER
```

变量对应关系：

| Worker Secret | 企业微信后台位置/值 |
| --- | --- |
| `WECHAT_CORP_ID` | 我的企业 → 企业信息 → 企业 ID |
| `WECHAT_APP_SECRET` | 自建应用详情 → Secret |
| `WECHAT_AGENT_ID` | 自建应用详情 → AgentId |
| `WECHAT_TO_USER` | 通讯录中成员的 UserID，如 `zhangsan`；多人示例：`zhangsan|lisi` |

每次执行 `wrangler secret put` 都会创建并立即部署一个包含该密钥的新版本。应用消息单条文本最大 2048 字节；Worker 会自动按 UTF-8 字节边界拆分长邮件正文，并加上“邮件正文 1/N”标记。企业微信 API 的 `errcode` 非 0 也会作为投递失败返回，让 Cloud Mail 按其重试设置重试。

设置完成后，使用本文末尾的 `/test` 请求验证。响应中的 `deliveries` 出现 `{"channel":"wechat-app","ok":true}` 即表示企业微信应用已成功接收；若失败，`error` 会包含企业微信接口返回的错误信息。

## Cloud Mail 后台配置

在 **系统设置 → Webhook** 中：

1. 启用 Webhook。
2. 请求地址填写 `https://<你的-worker>.<你的子域>.workers.dev/webhook`（或绑定的自定义域名）。
3. 密钥填写与 Worker `WEBHOOK_TOKEN` 完全相同的随机字符串。
4. 重试次数建议设为 `2`。如果任一已配置渠道通知失败，Worker 返回 502，Cloud Mail 会按这里的次数重试；接收端应容忍重复通知。

## 检查与测试

健康检查：`GET /` 返回服务状态。部署完成后，可用以下命令给所有已配置渠道发送一封测试邮件：

```bash
curl -X POST 'https://<worker-url>/test' \
  -H 'Authorization: <WEBHOOK_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{}'
```

实际接收端为 `POST /webhook`。成功返回 200；没有任何通知渠道被配置时返回 200 且 `deliveries` 为 `none`。
