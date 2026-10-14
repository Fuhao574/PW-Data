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

这阵子一直在改首页，好不好看纠结了半天，后端倒是没怎么管。回头检查了一遍，才发现有些东西比按钮颜色重要多了：密钥直接写在代码里，JWT 密钥还是随手编的，验证码错多少次都能继续试，GitHub 登录也少了 state。

前端还在挑哪种边框顺眼，后端已经有这么多地方得补，我也是心挺大。于是先停下改页面，把这几处修一修。代码改完还没完，部署的时候又被我漏掉的一个文件绊了一下，下面一起记，免得以后再踩一遍。

# 一 · 为什么要动后端

本站前端在 Vercel，PHP 后端在自己的服务器上，数据库密码、Redis Token、GitHub Client Secret、邮件 API Key 和 JWT 密钥之前都塞进 `config.php`。代码要读，配置也要读，放一起写着是方便，但代码副本拿出去，密钥就跟着一起走了，这个方便还是别留了。

JWT 密钥更离谱，还是一串带 `change_me` 的临时口令。名字都在提醒该换了，结果一直没换，直接跑到了生产环境。知道密钥的人可以签出后端认可的 token，不是只能看看公开资料，而是能冒用别人的身份。站小归站小，这个不能拿没什么人来访问当理由。

# 二 · 体检报告

先把当时发现的地方列一下，严重程度是按本站场景粗分，不是完整审计报告。看着像几个配置问题，真顺着查下来，登录、上传和公共模块都得动，没法只换个密码就收工。

| 问题 | 严重度 | 一句话 |
|------|--------|--------|
| 敏感密钥全明文硬编码 | 🔴 高 | 密码、Token、Secret 全在源码里裸奔 |
| JWT 密钥是弱口令 | 🔴 高 | 可能被猜解，签名身份保障失效 |
| config.php 在 Web 根目录 | 🟠 中高 | PHP 一旦解析失败，密钥直接被当文本吐出来 |
| 验证码可暴力破解 | 🟠 中高 | 6 位数字 100 万种组合，没有尝试次数限制 |
| GitHub OAuth 缺 state | 🟠 中 | OAuth CSRF，攻击者能把账号塞进别人会话 |
| 头像上传 URL 信任 Host 头 | 🟡 中低 | Host 头可伪造，返回的图片地址会被污染 |
| 头像地址不校验协议 | 🟡 低 | 存进数据库的 URL 可能有 `javascript:` 之类的私货 |
| CORS 与响应函数重复 7 遍 | ⚪ 质量 | 150 行样板代码复制了 7 份，改一处要改 7 处 |

# 三 · 修补过程

## 把密钥请出代码

先把密钥从源码里拿出去，新建 `env.php` 负责读取配置。顺序是服务器环境变量、`$_SERVER`，再到 `.env` 文件，兼容不同部署方式。文件先找当前目录，再找上一级，这样可以放在 Web 根之外，不用为了让代码读得到，就把配置也摆在可能被直接访问的位置。

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

关键配置用 `envRequired()`，没配就报错，不给一个看着能跑的默认密钥。部署时少填了东西，应该让我立刻发现，而不是接口一直正常，背后却偷偷用着测试口令，这种贴心还是不要了。

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

这里没调用公共的 `respond()`，因为它在 `common.php`，而 `common.php` 又要先读环境配置，绕回去就循环依赖了。示例会返回缺失键名，实际生产也要考虑把详细信息放服务端日志，对外只报配置故障，别顺手把内部配置细节全讲给访客听。

替换完又用旧密钥的特征片段扫了一遍 PHP 文件，确认没有漏下来的硬编码。扫描只是检查的一步，不是没输出就证明所有凭据都绝对安全，历史副本、服务器配置和曾经暴露过的值还得分别处理。

```bash
$ grep -rnE "<旧密钥片段1>|<旧密钥片段2>|<旧密钥片段3>" *.php
# 无输出，干净
```

真实片段当然不贴，不能写着安全文章又把密钥发一遍。`config.php` 最后只留站点级公开常量，仓库放 `.env.example` 说明要填哪些键，再用 `.htaccess` 拦点文件和配置文件。注意 `.htaccess` 是 Apache 那边的规则，用 Nginx 得另外配，复制过去不会自动生效；已经暴露过的凭据也得轮换，只搬位置不算收回。

## 换掉 JWT 弱密钥

```bash
# 生成一把 256 位的
openssl rand -hex 32
```

上面命令生成 32 字节随机值，用十六进制保存，新密钥放进 `.env`，代码只负责读取。换完旧 token 都验不过，Friend 用户得重新登录。本站用户少，这次能接受；正常轮换可以设计过渡方案，但如果旧密钥已经泄露，就不能还为了省一次登录一直信任它。

## 验证码防穷举

验证码是 6 位数字，组合数一百万，看着挺多，但不能让人拿接口一直试。之前只有限制发送间隔 60 秒，验证的时候错了就返回错误，下一次照样能试。我还觉得有发送限流就差不多了，结果限制的是发短信那扇门，猜验证码的门根本没管。

这次给同一邮箱加失败计数，错 5 次锁 10 分钟，验证码正确后删除验证码和计数。下面是当时的简化逻辑，先看清流程；读计数再写回、读验证码再删除都不是原子操作，并发防护和一次性消费还得继续完善，不能只看见有计数器就觉得脚本一定绕不过去。

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

登录和改邮箱都补了同样的限制，Redis 负责保存计数和过期时间，过了窗口不用手动清理。还剩几次的提示主要让正常用户知道什么时候该停一下，脚本会不会听劝另说，真正的防护靠后端执行限制，不靠错误文案把人劝回去。

## GitHub OAuth 补 state

GitHub 登录之前直接拼授权 URL，`client_id`、`redirect_uri`、`scope` 都有，就是没带 state。state 应该用来关联发起登录的浏览器和授权回调，避免被别人的登录结果冒领流程，不是随便加一个随机字符串就完成防护。

当时先补了随机 state、Redis 过期和回调检查，过程如下。这里也得说明边界：示例只记录了 state 存在，没有展示它与发起浏览器的绑定，而且读取后再删不是原子消费。所以这段是当时补到哪一步的记录，不能说它已经完整堵住登录 CSRF。

```
前端请求 github-state.php  →  后端生成随机 state，存 Redis（10 分钟有效）
        ↓
前端把 state 拼进授权 URL  →  GitHub 授权
        ↓
GitHub 回调 github-callback.php，带上 state
        ↓
后端比对 Redis 里的 state，匹配则删除（一次性，防重放）
```

生成 state 的代码如下，32 字节随机值，保存十分钟。有效期可以限制旧流程拖太久，但服务端记得这个 state，不等于已经证明带它回来的人就是发起者，两件事别混在一起。

```php
// 生成 32 字节随机 state 并存入 Redis（10 分钟有效，一次性）
$state = bin2hex(random_bytes(32));
redisSet('github:state:' . $state, '1', 600);

respond(true, '', ['state' => $state]);
```

回调先拒绝空值和不存在的 state，用过就删。代码行数不多，但完整方案仍要考虑浏览器关联和原子消费，实际实现不能只以函数够不够短来判断安全性。

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

前端的 `handleGithubLogin` 也一起改，先从后端领 state，确认返回成功再继续授权。初始化都失败了就停下来提示，别还开着弹窗让用户以为只是 GitHub 响应慢。

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

前端先领 state，再跳转，领不到就提示失败，不继续拼一个空参数。这个改动得配合上线，后端开始拒绝无 state 请求时，旧前端就不能登录了。真部署要安排兼容或维护窗口，清楚这段时间会影响谁，不能各传各的，第二天才发现登录坏了一晚上。

## 三个小修

头像上传后返回的 URL 原本拿 `HTTP_HOST` 拼，客户端能改 Host，返回地址就可能跟着变。后来改用配置里的固定 `API_BASE_URL`，这是服务器自己知道的地址，不需要每次问请求从哪里来。

资料里的头像地址也补了 HTTPS 协议限制，之前只查长度是不够的。下面的正则只是开头检查，不是完整 URL 验证，更不是远程抓取防护；如果后端要主动下载，还得校验主机、解析结果和重定向，不能看见 https 就放心访问。

```php
if (!preg_match('#^https://#i', $avatarUrl)) {
    respond(false, '头像地址必须是 https:// 开头的合法 URL');
}
```

另外把重复代码收了一下，CORS、JSON 响应、PDO 连接之前在 7 个接口里各放一份，改起来太容易漏。抽到 `common.php`，统一用 `handleCors()`、`respond()`、`db()` 和 `requirePost()`，PDO 连接也在单次请求里复用。后来加新接口，终于不用先复制一大块开场代码了。

# 四 · 部署翻车记

代码改完，语法检查全过，本地是 PHP 8.5，服务器是 8.2。传上去一试，接口开始报 500，响应还是空的，连我写好的 JSON 错误都没出来。刚补完一轮安全，先把自己拦在门外了，这个确实没想到。

排查的时候先看是不是配置或文件没传齐，再按依赖缩小范围。下面这些是当时的检查顺序，不是重演一次线上故障，探针这种临时文件查完也要删掉，别留下一个能公开查看服务器状态的入口。

1. 先怀疑 `.env` 没传上去。但如果是环境变量缺失，我写的 `envRequired()` 会返回一段 JSON 告诉你缺哪个 key——**body 不会是空的**。排除。
2. 再怀疑新文件没传上去。传了个探针 `probe.php` 上去，逐个 `is_file()` 检查：`common.php` ok，`env.php` ok，`.env` ok。都能加载。排除。
3. 最后发现：**凡是依赖 Redis 的接口全挂，不依赖 Redis 的接口正常**。线索一下窄了。

最后发现漏的是 `redis.php`。`config.php` 里的 `REDIS_URL`、`REDIS_TOKEN` 已经删了，各个接口也改成读环境变量了，偏偏这个公共模块还在引用旧常量。前面改了那么多文件，它没动过，我就没继续看，结果最需要看的恰好是它。

PHP 8 引用未定义常量会直接报错，生产又关了错误回显，所以没走到统一响应函数就停了，留下一个空 500。关错误回显没错，详细错误本来就不该公开，只是排查得去看服务端日志，不能指望接口总能把原因告诉我。

```php
// 改之前：引用已经不存在的常量
$ch = curl_init(REDIS_URL . '/');  // 💥 fatal

// 改之后
$ch = curl_init(envRequired('REDIS_URL') . '/');
```

改法就是上面这一行，但排查花的时间不止一行。`php -l` 只保证语法能解析，不会替我执行 Redis 初始化，更不会检查服务器的配置是否齐全，所以以后不能看见语法通过就觉得部署稳了。

公共模块没改，不代表它不会被其他改动影响。以后动配置要顺着引用查一遍，部署后做最小检查，确认核心读接口和登录初始化能正常响应；涉及写入的测试则放隔离环境，别为了检查上线又往生产里塞测试数据。

# 尾声 · 现在的状态

改完的几个文件放在下面，公共配置、响应、JWT 和 Redis 各管一块。以后查问题至少知道该去哪找，不用先在每个接口里翻一遍重复代码。

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

部署时给服务器注入环境变量，或者在安全位置放 `.env`，真实值不提交，仓库只放模板。搬出源码只是这一层，历史泄露值轮换、配置访问限制和服务器权限也要一起管，不然只是把同一把钥匙换了个抽屉。

## 一张表收尾

| 改动 | 效果 |
|------|------|
| 密钥移出源码 | 减少随源码暴露的风险，已暴露值仍需轮换 |
| JWT 强随机密钥 | 降低弱口令被猜解的风险 |
| 验证码尝试限流 | 限制尝试次数，并发原子性仍需完善 |
| OAuth state 校验 | 补随机值与有效期，浏览器绑定和原子消费仍需完善 |
| 不用 Host 拼 URL | 返回地址改由固定配置决定 |
| 头像 https 校验 | 收窄协议范围，不代替完整 URL 与抓取校验 |
| 样板代码收敛 | 7 份重复 → 1 份公共模块 |

## 没做的

这次改完仍然有欠账。[JWT 那篇](/posts/jwt-login)提到的主动吊销还没做，换密钥能让所有旧 token 下线，却不能日常只踢一个用户。留言板也还是全量返回，没有分页，现在数据少还好，以后多了得再处理。

登录和修改资料的审计日志也没做，记录哪些信息、保留多久，还得先想清楚隐私边界。验证码与 state 示例里的并发、绑定问题同样不能忘，不能修完几项就把剩下的叫作没问题。

总之先把这次动过的地方记下来，下次回头检查还能知道当时做到哪里。页面颜色可以慢慢挑，临时密钥真别一直临时下去了，名字里写了 change me，也不会自己换哈哈哈。
