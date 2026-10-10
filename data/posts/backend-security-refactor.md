---
title: 给后端做了一次安全体检
description: 密钥明文躺在代码里、JWT 密钥是弱口令、验证码能被穷举、GitHub 登录没防 CSRF。逐条修完，还顺手在部署时翻了个车。
published: 2026-09-17T10:00:00
category: 记录
tags:
  - 安全
  - 后端
  - PHP
  - JWT
  - OAuth
  - 建站
image: https://img.fuhao574.cyou/images/backend-security-refactor/backend-security-refactor-cover.webp
---

站上线一阵子了，前阵子把首页来回推翻重做了几版，后端一直没动。前几天回头一扫——前端光鲜，后端门开着。

不是那种 **教科书式的安全建议**，是几个实打实的洞：密钥明文写在代码里、JWT 密钥是弱口令、验证码可以被人按在地上穷举、GitHub 登录没防 CSRF。这篇记一下体检报告和修补过程，最后附赠一次部署现场的翻车——我的，不是攻击者的。

# 一 · 为什么要动后端

先说动机。网站前后端分离，前端 React 挂 Vercel，后端 PHP 挂在自己的服务器上。所有接口里摸得到的敏感东西：数据库密码、Redis Token、GitHub Client Secret、邮件 API Key、JWT 密钥。

这些东西之前全写在一个 `config.php` 里。它干的是环境变量的活，但它不是环境变量——它是一份**提交进代码库的、任何人都能读到的明文表格**。

更要命的是 JWT 密钥。写 `jwt.php` 的时候我随手敲了一串 `fuhao574_jwt_secret_2024_change_me`，字面上写着 **change me**，然后就这么一直 change 不下去，跑在生产环境里。

JWT 的验签逻辑里，密钥即一切——**谁拿到它，谁就能伪造全站任何用户的身份**，想登谁的号登谁的号。这个站虽然没什么资产，但 **任何人都能变成我** 这件事，想着还是睡不着。

# 二 · 体检报告

逐条列。按严重程度排。

| 问题 | 严重度 | 一句话 |
|------|--------|--------|
| 敏感密钥全明文硬编码 | 🔴 高 | 密码、Token、Secret 全在源码里裸奔 |
| JWT 密钥是弱口令 | 🔴 高 | 猜得出来，等于没加密 |
| config.php 在 Web 根目录 | 🟠 中高 | PHP 一旦解析失败，密钥直接被当文本吐出来 |
| 验证码可暴力破解 | 🟠 中高 | 6 位数字 100 万种组合，没有尝试次数限制 |
| GitHub OAuth 缺 state | 🟠 中 | OAuth CSRF，攻击者能把账号塞进别人会话 |
| 头像上传 URL 信任 Host 头 | 🟡 中低 | Host 头可伪造，返回的图片地址会被污染 |
| 头像地址不校验协议 | 🟡 低 | 存进数据库的 URL 可能有 `javascript:` 之类的私货 |
| CORS 与响应函数重复 7 遍 | ⚪ 质量 | 150 行样板代码复制了 7 份，改一处要改 7 处 |

一条条说怎么修的。

# 三 · 修补过程

## 把密钥请出代码

核心动作：新建 `env.php` 当加载器，所有密钥改为从环境变量读取。查找顺序三级：服务器环境变量 → `$_SERVER` 兜底 → `.env` 文件。前两级给 Docker、systemd、Nginx `fastcgi_param` 这类注入机制用；都没有就落 `.env` 文件，加载器先在当前目录找，再去上级目录——**放在 Web 根之外更安全**，反正它自己会往上找。

```php
function env(string $key, ?string $default = null): ?string
{
    // 服务器环境变量（getenv 在 PHP-FPM 下也能读到 Nginx fastcgi_param）
    $serverValue = getenv($key);
    if (is_string($serverValue) && $serverValue !== '') {
        return $serverValue;
    }

    // $_SERVER 兜底（部分配置下 getenv 取不到）
    if (isset($_SERVER[$key]) && is_string($_SERVER[$key]) && $_SERVER[$key] !== '') {
        return $_SERVER[$key];
    }

    // 懒加载 .env（同一请求内只解析一次）
    static $fileVars = null;
    if ($fileVars === null) {
        $fileVars = [];
        // 查找顺序：当前目录 → 上级目录（Web 根之外更安全）
        foreach ([__DIR__ . '/.env', dirname(__DIR__) . '/.env'] as $candidate) {
            if (is_file($candidate) && is_readable($candidate)) {
                $fileVars = parseEnvFile($candidate);
                break;
            }
        }
    }

    return $fileVars[$key] ?? $default;
}
```

关键的密钥用 `envRequired()` 读——**缺失直接返回 500，不给默认值**。宁可用不了，也不能用错：

```php
function envRequired(string $key): string
{
    $value = env($key);
    if ($value === null || $value === '') {
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode([
            'success' => false,
            'message' => '服务器环境变量缺失：' . $key,
            'data' => [],
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }
    return $value;
}
```

这几行没有调用现成的 `respond()`，是就地手写的——`respond()` 住在 `common.php` 里，而 `common.php` 自己要靠 `env.php` 读数据库配置，循环依赖，公共底座只能自己照顾自己。

改完一扫，源码里一个敏感值都不剩。拿旧密钥的几个特征片段当关键词扫一遍所有 PHP 文件：

```bash
$ grep -rnE "<旧密钥片段1>|<旧密钥片段2>|<旧密钥片段3>" *.php
# 无输出，干净
```

真实片段就不贴了——写安全的文章自己先泄密，成何体统。

顺手做了三件配套的事：`config.php` 瘦身成只剩站点级常量（站长邮箱这种公开信息）；仓库里放一份 `.env.example` 模板，键名照着抄，值自己填；再加 `.htaccess` 拒绝外部直接访问点开头的文件和 `config.php`（Apache 生效，Nginx 得在站点配置里写等效规则——这个坑差点又踩一次）。

## 换掉 JWT 弱密钥

```bash
# 生成一把 256 位的
openssl rand -hex 32
```

新密钥写进 `.env`，源码里永远只有 `envRequired('JWT_SECRET')` 这一句。

代价要诚实说：**密钥一换，之前签发出去的旧 token 全部失效**。所有 Friend 模式的用户会被踢下线，需要重新登录。个人站，用户一只手数得过来，可以接受。要是百万用户量的产品，换密钥得做双密钥并行过渡——那是另一套工程了。

## 验证码防穷举

6 位数字验证码，组合数 10 的 6 次方。如果接口不限制尝试次数，攻击者拿着一个已知邮箱，并发请求总能蒙对。

之前的逻辑是 **从 Redis 取验证码，比对，错就拒绝**——对是对了，就是不数对方错了多少次。发送侧本来就有 60 秒间隔，但校验侧完全没设防，等于前门上锁、后门敞着。

补上计数器。同一邮箱失败 5 次，锁 10 分钟：

```php
// 1. 尝试次数限流：同一邮箱失败 5 次，锁定 10 分钟
$attemptKey = 'email:' . $email . ':attempts';
$attempts = redisGet($attemptKey);
if ($attempts !== null && (int)$attempts >= CODE_MAX_ATTEMPTS) {
    $ttl = redisTTL($attemptKey);
    $minutes = $ttl !== null && $ttl > 0 ? (int)ceil($ttl / 60) : CODE_LOCK_MINUTES;
    respond(false, "尝试次数过多，请 {$minutes} 分钟后再试");
}

// 2. 从 Redis 取验证码
$storedCode = redisGet($redisKey);

if ($storedCode === null || $storedCode !== $code) {
    // 累加失败次数，设置锁定窗口
    $newAttempts = $attempts === null ? 1 : (int)$attempts + 1;
    redisSet($attemptKey, (string)$newAttempts, CODE_LOCK_MINUTES * 60);

    $remaining = CODE_MAX_ATTEMPTS - $newAttempts;
    respond(false, $remaining > 0
        ? "验证码错误或已过期，还可尝试 {$remaining} 次"
        : '验证码错误次数过多，请 10 分钟后再试');
}

// 3. 验证码正确 → 删除验证码与失败计数，防止重放
redisDel($redisKey);
redisDel($attemptKey);
```

每错一次都告诉对方还剩几次，不是好心提醒，是劝退——让脚本知道再试也是锁，比让它蒙到最后一次更省大家的时间。登录接口和改邮箱接口是同一条逻辑，都补上了。Redis 当计数器刚好合适：**自带过期**，不用自己清理。

## GitHub OAuth 补 state

OAuth 流程里，state 参数的作用是确认 **回调的人，就是刚才发起授权的人**。没有它，攻击者可以构造一个授权链接骗受害者点，受害者授权后，攻击者的账号就绑进了受害者的会话——经典 OAuth CSRF。

之前的流程是前端直接拼授权 URL，`client_id` + `redirect_uri` + `scope`，没有 state。

修法是前后端配合：

```
前端请求 github-state.php  →  后端生成随机 state，存 Redis（10 分钟有效）
        ↓
前端把 state 拼进授权 URL  →  GitHub 授权
        ↓
GitHub 回调 github-callback.php，带上 state
        ↓
后端比对 Redis 里的 state，匹配则删除（一次性，防重放）
```

新增的 `github-state.php` 很短：

```php
// 生成 32 字节随机 state 并存入 Redis（10 分钟有效，一次性）
$state = bin2hex(random_bytes(32));
redisSet('github:state:' . $state, '1', 600);

respond(true, '', ['state' => $state]);
```

回调侧的校验也是四行的事：

```php
if ($state === '') {
    redirectError('no_state');
}
$stateKey = 'github:state:' . $state;
if (redisGet($stateKey) === null) {
    redirectError('state_invalid');
}
redisDel($stateKey);  // 用过即删，防重放
```

前端那边，`handleGithubLogin` 改成先领 state 再开弹窗：

```ts
// 先从后端领取一次性 state（存于 Redis），防 OAuth CSRF
const stateRes = await fetch(`${API_BASE}/github-state.php`);
const stateData = await stateRes.json();
if (!stateData.success || !stateData.data?.state) {
  showToast('登录初始化失败，请重试', 'error');
  return;
}
// ... '&state=' + encodeURIComponent(stateData.data.state)
```

领不到 state 就不开门，避免拿着空 state 去撞后端。

**注意**：这个改动要求前后端一起上线。后端开始强校验 state 的那一刻，旧前端因为没有 state 参数，GitHub 登录会直接失败。所以部署顺序是：**先传后端，立刻跟上前端**，中间别隔夜。

## 三个小修

**Host 头注入。** 头像上传后返回的图片 URL，原本用 `$_SERVER['HTTP_HOST']` 拼接。Host 头是客户端可控的，攻击者伪造一个，返回的图片地址就指向别处。改成从环境变量读固定的 `API_BASE_URL`，不信客户端任何输入。

**头像地址协议校验。** 修改资料接口传进来的 `avatar_url`，之前只查长度。现在必须 `https://` 开头才收，`javascript:`、`data:` 之类的一律拒收——这地址最后是塞进 `<img src>` 的，马虎不得：

```php
if (!preg_match('#^https://#i', $avatarUrl)) {
    respond(false, '头像地址必须是 https:// 开头的合法 URL');
}
```

**样板代码收敛。** CORS 白名单、JSON 响应函数、PDO 连接，7 个接口文件里逐字重复了 7 遍。抽进 `common.php`，一个文件一套：`handleCors()`、`respond()`、`db()`、`requirePost()`。顺带把 PDO 连接改成请求内单例，一次请求不再重复建连接。后来加 `github-state.php` 的时候，一行 CORS 都没写——白拿。

# 四 · 部署翻车记

代码改完，lint 全过，本地 PHP 8.5 跑得欢天喜地，传上服务器——**所有接口 500**。

而且是很没礼貌的 500：HTTP 状态码 500，`content-type: text/html`，**body 空的**，一个字都不肯说。

排查过程值得记一笔，因为教科书式的错误处理在这里全都失效了：

1. 先怀疑 `.env` 没传上去。但如果是环境变量缺失，我写的 `envRequired()` 会返回一段 JSON 告诉你缺哪个 key——**body 不会是空的**。排除。
2. 再怀疑新文件没传上去。传了个探针 `probe.php` 上去，逐个 `is_file()` 检查：`common.php` ok，`env.php` ok，`.env` ok。都能加载。排除。
3. 最后发现：**凡是依赖 Redis 的接口全挂，不依赖 Redis 的接口正常**。线索一下窄了。

真相是这样的。我重写 `config.php` 时，把 `REDIS_URL` 和 `REDIS_TOKEN` 两个常量删掉了——它们本来由 `config.php` 定义，`redis.php` 只管引用。新代码里所有接口都改成了从环境变量读，**唯独 `redis.php` 这个公共模块被漏掉了**，它还在用那两个已经不存在的常量。

PHP 8 里引用未定义常量是 **fatal error**，不是警告，脚本当场死亡；而生产服务器关掉了错误回显，于是死得悄无声息——空 body，500，连个遗言都没有。

```php
// 改之前：引用已经不存在的常量
$ch = curl_init(REDIS_URL . '/');  // 💥 fatal

// 改之后
$ch = curl_init(envRequired('REDIS_URL') . '/');
```

一行代码的事。但这一行让我学了三件事：

**lint 过了不等于能跑。** `php -l` 只查语法，不查常量是否定义、环境是否就绪。它说的是 **No syntax errors**，它没说 **能跑**。

**公共模块是最容易漏的盲区。** 改接口的时候逐个都照顾到了，唯独觉得 redis.php 没动过，不用看。**没动过的文件，恰恰可能因为别人动了而坏掉**——依赖是双向的。

**本地和生产的环境差异会咬人。** 本地 PHP 8.5，服务器 8.2；本地 `.env` 就在眼前，服务器上一切都隔着 SSH。这类问题以后早点加一个最小的冒烟测试：部署完先 `curl` 一圈核心接口，比任何 lint 都管用。

# 尾声 · 现在的状态

改完之后的架构：

```
浏览器
  │  Authorization: Bearer <JWT>
  ▼
PHP 接口
  ├── env.php  ← 读环境变量（服务器配置 或 .env）
  ├── common.php  ← CORS / 响应 / 数据库连接（收敛了 7 份重复代码）
  ├── jwt.php  ← 密钥来自环境变量，弱口令已换
  ├── redis.php  ← 连接信息来自环境变量（翻车那次修的就是它）
  └── github-state.php  ← 新增，发一次性 state 防 CSRF
```

部署方式：`.env` 放在服务器上（不提交任何代码库），或用服务器的环境变量注入。源码里一个密钥都没有。

## 一张表收尾

| 改动 | 效果 |
|------|------|
| 密钥移出源码 | 代码库泄露不再等于密钥泄露 |
| JWT 强随机密钥 | 无法猜解，无法伪造身份 |
| 验证码尝试限流 | 6 位数字穷举不再可行 |
| OAuth state 校验 | 堵上 OAuth CSRF |
| Host 头不信任 | 图片地址无法被污染 |
| 头像 https 校验 | 阻断协议注入 |
| 样板代码收敛 | 7 份重复 → 1 份公共模块 |

## 没做的

诚实交代边界：

**JWT 依然无法主动吊销。** 这点在[上一篇](/blog/jwt-login)里说过，换密钥等于变相的全站下线，但日常做不到单用户踢出。个人站接受。

**留言板没有分页。** 一次性全量返回，现在数据少没感觉，等留言多了会慢。排进了待办。

**没有登录态的审计日志。** 谁在什么时候登录、改了资料，目前无记录。要不要做，得先想清楚隐私边界。

安全这东西没有 **做完了** 这一说，只有 **目前已知的问题都处理了**。这份报告今天是完整的，明天可能就不是。先这样。

> 密钥这东西，放在代码里最方便，也最危险——方便是自己的，危险是大家的。
