const JSON_HEADERS = { 'content-type': 'application/json; charset=UTF-8' };
const MAX_BODY_BYTES = 1024 * 1024;
const WECOM_TEXT_BYTES = 2048;
const wecomTokens = new Map();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return json({ status: 'ok', service: 'cloud-mail-webhook' });
    }

    if (request.method === 'POST' && (url.pathname === '/webhook' || url.pathname === '/test')) {
      if (!env.WEBHOOK_TOKEN) {
        console.error('WEBHOOK_TOKEN is not configured');
        return json({ error: 'Service is not configured' }, 503);
      }
      if (!constantTimeEqual(request.headers.get('Authorization') || '', env.WEBHOOK_TOKEN)) {
        return json({ error: 'Unauthorized' }, 401);
      }
      if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
        return json({ error: 'Content-Type must be application/json' }, 415);
      }
      const length = Number(request.headers.get('content-length'));
      if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
        return json({ error: 'Payload too large' }, 413);
      }

      let payload;
      try {
        payload = url.pathname === '/test' ? testEmail() : await request.json();
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }
      const email = normalizeEmail(payload);
      if (!email) return json({ error: 'Invalid Cloud Mail payload' }, 400);

      const deliveries = await deliver(email, payload, env);
      const failed = deliveries.filter((item) => !item.ok);
      for (const item of failed) console.error(`Delivery to ${item.channel} failed: ${item.error}`);

      // 非 2xx 会让 Cloud Mail 根据其“重试次数”设置重投。接收方应能处理重复消息。
      return json({ ok: failed.length === 0, deliveries }, failed.length ? 502 : 200);
    }

    return json({ error: 'Not found' }, 404);
  }
};

function normalizeEmail(value) {
  if (!value || typeof value !== 'object') return null;
  const strings = ['emailId', 'sendEmail', 'sendName', 'toEmail', 'toName', 'subject', 'text', 'content', 'code', 'createTime'];
  const email = Object.fromEntries(strings.map((key) => [key, string(value[key])]));
  // Cloud Mail 的 emailId 是数值；以此避免把任意 JSON 当作邮件通知。
  if (!email.emailId || !email.toEmail) return null;
  email.preview = truncate(toPlainText(email.text || email.content), 3500);
  return email;
}

async function deliver(email, originalPayload, env) {
  const jobs = [];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    jobs.push(send('telegram', `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: env.TELEGRAM_CHAT_ID, text: messageText(email), disable_web_page_preview: true
    }));
  }
  const wecomSettings = ['WECHAT_CORP_ID', 'WECHAT_APP_SECRET', 'WECHAT_AGENT_ID', 'WECHAT_TO_USER'];
  if (wecomSettings.some((key) => env[key])) {
    const missing = wecomSettings.filter((key) => !env[key]);
    jobs.push(missing.length
      ? Promise.resolve({ channel: 'wechat-app', ok: false, error: `Missing ${missing.join(', ')}` })
      : sendWeComApp(email, env));
  }
  if (env.FEISHU_WEBHOOK_URL) jobs.push(send('feishu', env.FEISHU_WEBHOOK_URL, {
    msg_type: 'interactive', card: { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '📧 新邮件' } }, elements: [{ tag: 'markdown', content: messageMarkdown(email) }] }
  }));
  if (env.DISCORD_WEBHOOK_URL) jobs.push(send('discord', env.DISCORD_WEBHOOK_URL, {
    embeds: [{ title: '📧 新邮件', color: 0x4285f4, fields: [
      { name: '发件人', value: from(email), inline: false },
      { name: '收件人', value: email.toEmail || '（未提供）', inline: false },
      { name: '主题', value: truncate(email.subject || '（无主题）', 1024), inline: false },
      { name: '正文', value: truncate(email.preview || '（无正文）', 1024), inline: false }
    ], timestamp: toIsoDate(email.createTime) }]
  }));
  if (env.OTHER_WEBHOOK_URL) jobs.push(send('other', env.OTHER_WEBHOOK_URL, {
    event: 'cloud_mail.received', email, originalPayload
  }));
  if (!jobs.length) return [{ channel: 'none', ok: true, status: 0 }];
  return Promise.all(jobs);
}

async function send(channel, url, body) {
  try {
    const response = await fetch(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${truncate(await response.text(), 300)}`);
    return { channel, ok: true, status: response.status };
  } catch (error) {
    return { channel, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function sendWeComApp(email, env) {
  try {
    const token = await getWeComToken(env);
    const chunks = splitUtf8(messageText(email), 1850);
    for (let index = 0; index < chunks.length; index++) {
      const prefix = chunks.length > 1 ? `【邮件正文 ${index + 1}/${chunks.length}】\n` : '';
      const response = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({
          touser: env.WECHAT_TO_USER,
          agentid: Number(env.WECHAT_AGENT_ID),
          msgtype: 'text',
          text: { content: prefix + chunks[index] },
          safe: 0
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.errcode !== 0) {
        throw new Error(`message/send ${response.status}: ${result.errcode ?? 'invalid response'} ${result.errmsg ?? ''}`.trim());
      }
    }
    return { channel: 'wechat-app', ok: true, status: 200, messages: chunks.length };
  } catch (error) {
    return { channel: 'wechat-app', ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function getWeComToken(env) {
  const cacheKey = `${env.WECHAT_CORP_ID}:${env.WECHAT_APP_SECRET}`;
  const cached = wecomTokens.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/gettoken');
  url.searchParams.set('corpid', env.WECHAT_CORP_ID);
  url.searchParams.set('corpsecret', env.WECHAT_APP_SECRET);
  const response = await fetch(url);
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.errcode !== 0 || !result.access_token) {
    throw new Error(`gettoken ${response.status}: ${result.errcode ?? 'invalid response'} ${result.errmsg ?? ''}`.trim());
  }
  wecomTokens.set(cacheKey, { token: result.access_token, expiresAt: Date.now() + Number(result.expires_in || 7200) * 1000 });
  return result.access_token;
}

function messageText(email) {
  return truncate(`📧 新邮件\n\n发件人：${from(email)}\n收件人：${email.toEmail || '（未提供）'}\n主题：${email.subject || '（无主题）'}${email.code ? `\n验证码：${email.code}` : ''}\n\n${email.preview || '（无正文）'}`, 3900);
}

function messageMarkdown(email) {
  return truncate(`**发件人：** ${from(email)}\n\n**收件人：** ${email.toEmail || '（未提供）'}\n\n**主题：** ${email.subject || '（无主题）'}${email.code ? `\n\n**验证码：** \`${email.code}\`` : ''}\n\n---\n${email.preview || '（无正文）'}`, 3900);
}

function from(email) {
  return email.sendName ? `${email.sendName} <${email.sendEmail || 'unknown'}>` : (email.sendEmail || '（未提供）');
}

function toPlainText(html) {
  return string(html).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim();
}
function splitUtf8(value, maxBytes) {
  const chunks = []; let current = ''; let bytes = 0;
  for (const character of string(value)) {
    const characterBytes = new TextEncoder().encode(character).length;
    if (bytes && bytes + characterBytes > maxBytes) { chunks.push(current); current = ''; bytes = 0; }
    current += character; bytes += characterBytes;
  }
  if (current || !chunks.length) chunks.push(current);
  return chunks;
}
function string(value) { return value == null ? '' : String(value); }
function truncate(value, limit) { return string(value).length > limit ? `${string(value).slice(0, limit - 1)}…` : string(value); }
function toIsoDate(value) { const date = new Date(value.replace(' ', 'T')); return Number.isNaN(date.valueOf()) ? new Date().toISOString() : date.toISOString(); }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS }); }
function testEmail() { return { emailId: 'test', sendEmail: 'hello@example.com', sendName: 'Cloud Mail 测试', toEmail: 'admin@example.com', subject: 'Cloud Mail Webhook 测试', text: '如果你看到了这条消息，Webhook 通知渠道已配置成功。', code: '123456', createTime: new Date().toISOString() }; }

function constantTimeEqual(a, b) {
  const aBytes = new TextEncoder().encode(a); const bBytes = new TextEncoder().encode(b);
  let difference = aBytes.length ^ bBytes.length;
  for (let i = 0; i < Math.max(aBytes.length, bBytes.length); i++) difference |= (aBytes[i] || 0) ^ (bBytes[i] || 0);
  return difference === 0;
}
