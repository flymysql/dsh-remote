# dsh-remote 心跳后端（Cloudflare Workers + D1）

替代三次因「余额/资源点不足」停服的 CloudBase 函数。免费层算术：DAU 千级写入/天
对着 D1 免费额度（10 万写、500 万读/天）有两个数量级余量；Workers 免费层
10 万次请求/天同理。

## 路由（与 CloudBase 时代同路径，便于客户端零改动灰度）

| 路由 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/dsh-hb/heartbeat` | POST | 无 | 最小安装心跳，204，body 不入库之外一律不落 |
| `/dsh-hb/stats?days=&key=` | GET | `key=STATS_KEY` | 聚合计数（看板/CI 快照用） |
| `/dsh-hb/health` | GET | 无 | 活性探针 |

隐私不变量在服务端强制执行：字段白名单 + idHash 必须是 32 位小写十六进制
伪名（原样 UUID 直接拒收），不存 IP / UA / 时刻。

## 一次性部署（约 5 分钟）

前置：Cloudflare 账号（免费）、本机 `npm i -g wrangler`（或用 `npx wrangler`）。

```bash
cd infra/heartbeat

# 1) 登录（浏览器授权）
npx wrangler login

# 2) 建 D1 数据库，把输出的 database_id 填回 wrangler.toml
npx wrangler d1 create dsh-remote-heartbeat

# 3) 建表
npx wrangler d1 execute dsh-remote-heartbeat --file=./schema.sql

# 4) 设置统计读口令（自己生成一个强随机串）
npx wrangler secret put STATS_KEY

# 5) 部署
npx wrangler deploy
```

部署后得到 `https://dsh-remote-heartbeat.<你的subdomain>.workers.dev`。

## 部署后烟测（对真 D1 跑通 SQL）

```bash
BASE=https://dsh-remote-heartbeat.<subdomain>.workers.dev
curl -fsS $BASE/dsh-hb/health
curl -fsS -X POST $BASE/dsh-hb/heartbeat -H 'content-type: application/json' \
  -d '{"idHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","version":"0.8.84","platform":"linux","arch":"x64","node":"24.0.0"}' -o /dev/null -w '%{http_code}\n'   # 期待 204
curl -fsS "$BASE/dsh-hb/stats?days=7&key=$STATS_KEY" | jq '{ok, installs, daily: .daily[-1]}'   # installs ≥ 1
```

## 接入插件

1. `lib/telemetry.js` 的 `DEFAULT_HEARTBEAT_URL` 指向 `$BASE/dsh-hb/heartbeat`；
2. `scripts/snapshot-stats.mjs` 的 `STATS_URL` 指向 `$BASE/dsh-hb/stats`；
3. GitHub repo secret `DSH_HB_STATS_KEY` 换成第 4 步的值；
4. 发版，老客户端自然消亡（旧地址下线即可，新版本只打新地址）。

## 日常运维

- **备份**：`npx wrangler d1 export dsh-remote-heartbeat --output dump.sql`；
- **手动查询**：`npx wrangler d1 execute dsh-remote-heartbeat --command "SELECT COUNT(*) FROM pings"`；
- **免费额度监控**：Cloudflare Dashboard → Workers → Metrics；超量会先 429/报错而不是悄悄停服（这正是我们要逃离的坑）。
