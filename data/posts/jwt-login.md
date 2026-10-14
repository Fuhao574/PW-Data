---
title: JWT 登录校验的选型与手写实现
description: 登录选 Session 还是 JWT，纠结完还是得动手试。记一下本站当时的选择，再拆开 PHP 示例，看看 token 到底怎么签、怎么验，哪些地方不能直接抄。
published: 2026-08-30T10:30:00
category: 教程
tags:
  - JWT
  - 认证
  - PHP
  - 前后端分离
  - 安全
image: https://img.fuhao574.cyou/images/jwt-login/jwt-login-cover.webp
---

做登录的时候，光选 Session 还是 JWT 就纠结了好几天，最后先用了 JWT。以前只知道请求头里会带一长串东西，真做到自己站上，才开始看这串东西到底装了什么。这篇前半段聊为什么这么选，后半段拆 PHP 示例，想看实现的可以往下跳，不用陪我从头纠结一遍。

先提醒一下，下面保留的是当时用来理解流程的简化代码，不是拿来就能上线的认证库。严格解码、必填字段、异常输入、密钥缺失和会话吊销都得另补，生产项目优先考虑成熟库。自己拆开学一遍可以，别因为函数短，就觉得认证只有这么点事。

# 一 · 选型篇：为什么是 JWT

## 背景：一个 www，一个 api

先说本站的情况，前端是 React SPA，放在 `www.fuhao574.cyou`，后端是 PHP 接口，放在 `api.fuhao574.cyou`，用户存 MySQL，验证码存 Upstash Redis。前后端是两个源，浏览器请求要处理 CORS，不过同为 HTTPS、同一主域的子域通常还是同站，跨源和跨站不是一回事，别像我一开始那样混着理解。

登录又分成两种，普通逛站不用先建账号，需要上传头像、修改资料这些功能时再用真实账号。两个模式名字分别叫 Visitor 和 Friend，听着没那么像进网站还要先办手续。

- **Visitor（游客）**：填个昵称就能进，纯前端身份，不参与任何鉴权，状态存 localStorage，90 天过期——来观光的，不查证件；
- **Friend（朋友）**：真实用户，走 GitHub OAuth（唯一的用户创建入口）或邮箱验证码登录，持有 JWT，可上传头像、修改资料——办了年卡的。

Friend 下的上传头像、修改资料、同步 GitHub 头像都要验证 JWT，Visitor 的本地状态不能当凭据。名字可以叫朋友，后端该查的证件还是要查，不然谁改个 localStorage 都能变成站长了。

## 候选方案：Session 还是 JWT

我主要比较的是服务端 Session 和自己签发的 JWT。Session 可以想成取号，浏览器带着 Session ID，后端再去会话存储里查是谁；JWT 则把声明放进 token，再用签名验证有没有被改过，基础验签不用先查会话表。

不过这两个东西不能跟 Cookie、Header 完全绑死，JWT 也能放 Cookie，Session ID 也能手动放请求头。我实际选的是 JWT 加 Bearer Header 这套组合，下面的理由都是针对本站，不是说 JWT 在所有场景都更好。

## 理由一：想让凭据跟请求显式走

Cookie 并不是跨子域就不能用，只是前端跨源调用 API 时，携带凭据和服务端放行都要配好。我当时更想让请求里明摆着带什么 token，不想一边查登录问题，一边猜这次 Cookie 有没有送到。若选 Cookie 方案，至少要一起检查下面这些。

1. 后端 CORS 配置加 `Access-Control-Allow-Credentials: true`——告诉浏览器：这个跨域请求允许带证件；
2. 前端 fetch 用 `credentials: 'include'`，Axios 则是 `withCredentials: true`，同时检查 Cookie 的 Domain、Path 是否匹配；
3. 根据实际同站或跨站情况设置 SameSite。跨站发送才通常涉及 `SameSite=None; Secure`，同站子域不能直接套这个结论。

Cookie 会被浏览器自动携带，涉及写操作时得考虑 CSRF，SameSite、Origin 检查或 CSRF Token 怎么配，要按具体流程来。不是配完 CORS 就什么都防住了，CORS 主要管浏览器能否跨源读响应，也不是后端的身份认证。

本站把 token 放进 `Authorization: Bearer <token>`，由自己的代码显式附加，能避开依赖自动 Cookie 的那类传统 CSRF。注意只是这类请求，GitHub OAuth 回调仍要防登录 CSRF，页面如果有 XSS 也一样会出事，不能因为用了 JWT 就觉得全站自带免疫。

## 理由二：基础验签不用查会话

Payload 可以带上后端签发的身份声明，本站当时放了下面这些字段。示例数据是虚构的，昵称和头像方便展示，真正关联账号还是看 `user_id`，不是昵称叫站长就能当站长。

```json
{
  "user_id": 42,
  "nickname": "Fuhao574",
  "avatar_url": "https://avatars.githubusercontent.com/u/xxx",
  "exp": 1787595600
}
```

验签、字段和过期检查都通过后，可以从 payload 读 `user_id`，基础身份校验不用先查一遍会话存储。昵称和头像则是签发时的值，不会因为用户改资料就自动更新，需要最新资料的接口还是得查数据库，这个不能偷懒。

PHP 默认 Session 常用文件保存，也可以换 Redis 等共享存储，并不是做不了多机部署。JWT 的好处只是少维护一份服务端会话状态，以后多台机器验签也不用同步 Session。但密钥分发、轮换和权限更新照样要管，离零成本还远着呢，先别替这个小站规划成大厂。

## 理由三：两个登录入口用同一套凭据

账号从 GitHub OAuth 创建，但 GitHub 返回的 access token 是调用 GitHub API 的凭证，不应该直接拿来当本站登录态。回调拿到第三方身份、查出本站用户后，还得签发自己的凭据，后续访问本站就不用每次再去问 GitHub 你是谁。

当时的实现把本站 JWT 放在 localStorage，流程大概如下。这里只画身份转换，不是完整 OAuth 安全流程，state、回调校验和凭据传递方式都要另外处理，不能看这条箭头觉得登录接完了。

```
GitHub OAuth 授权 → 回调 → 签发自己的 JWT → 后续请求全部用 JWT
```

邮箱验证码登录也是验证完身份后调用 `generateJWT()`，两种入口共用一套后续校验，少写两份逻辑挺省事。不过 Session 也能这么做，这点是流程统一的好处，不是 JWT 独占的本事。

## 理由四：过期控制前后端对称

我当时把有效期设成 90 天，代码里按 2160 小时计算，口头上叫三个月，并不是按日历月份加三个月。token 带着 `exp`，前端能自己判断是不是已经过期，不用每次进站先发一个请求问后端。

- **Friend 模式**：前端解析 JWT 读 `exp`，过期即清除本地登录态；
- **Visitor 模式**：localStorage 存 `_savedAt` 时间戳，90 天过期。

Visitor 看本地保存时间，Friend 看 `exp`，界面上的过期处理就比较好统一。只是前端解析不代表验签，用户改本地时间或 payload 都不能改变服务端判断，真正能不能操作，还是后端说了算。

## 四条理由，一张表

| 维度 | Session + Cookie | JWT + Bearer Header |
|------|-----------------|-----|
| 跨源携带 | 配凭据请求、CORS 和 Cookie 属性 | Header 显式携带，也要配 CORS |
| 基础校验 | 查询会话存储 | 验签与声明检查，业务可能仍查库 |
| CSRF | 自动携带 Cookie 的流程需要防护 | Header 方案避开传统 Cookie CSRF，OAuth 仍需防护 |
| 多登录入口 | 可以共用会话创建逻辑 | 可以共用签发函数 |
| 过期判断 | 服务端掌握会话，可额外提供前端信息 | 前端可读 exp，最终由后端校验 |
| 主动吊销 | 删除会话 | 单靠无状态验签不行，需额外机制 |

表里最后一项是我当时最在意的代价，后面再聊。选型不可能只看方便的部分，尤其 90 天这么长，万一 token 丢了，事情可不会随着关掉浏览器就结束。

# 二 · 实现篇：手写 JWT 的每一步

下面不引库，把核心流程拆开看：编码、签发、验证，再从请求头取 token。函数确实不长，适合用来学原理，但代码短不等于安全检查齐了。示例保持当时的写法，需要补的地方我会在旁边说清楚，不把学习代码包装成生产方案。

## 第 0 步：先看清 token 长什么样

先看 HS256 签名 JWT 的形状，三段字符串用点号连接，分别是 Header、Payload、Signature。平时看到的一长串就是这么拼的，先拆开认识一下，后面再看函数就没那么吓人了。

```
eyJhbGciOiJIUzI1NiJ9 . eyJ1c2VyX2lkIjo0Mn0 . SflKxwRJSMeKKF2QT4fwpMeJ...

第一段 Header    →  手环的说明书：{"alg": "HS256"}——声明用哪种算法盖的章
第二段 Payload   →  手环上印的信息：user_id、nickname、exp
第三段 Signature →  那道防伪章：用密钥对前两段做 HMAC-SHA256
```

前两段只是 **Base64Url 编码，不是加密**，拿到 token 的人能读里面的内容，别放密码或其他秘密。想试可以拿虚构数据在本地解码，不要把正在用的生产 token 粘到在线调试网站，研究登录的时候顺手把登录凭据送出去就不太好了。

第三段签名才是防篡改的关键。前两段改了，重算的签名就对不上，后端应该拒绝。它保证的不是内容保密，而是验证内容有没有被持有密钥的人签过，另外还要检查算法、过期时间和业务声明，签名对了也不是所有操作都能放行。

## 第 1 步：base64Url 编解码

JWT 用的是 Base64Url，把标准 Base64 里的 `+` 换成 `-`，`/` 换成 `_`，再去掉末尾的 `=`，放在不同传输环境里更省事。不过 URL 安全只是编码规则，不代表应该把登录 token 放进 URL，地址栏、历史记录和日志都可能把它留下。

```php
function base64UrlEncode(string $data): string
{
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

function base64UrlDecode(string $data): string
{
    return base64_decode(
        strtr($data, '-_', '+/') . str_repeat('=', (4 - strlen($data) % 4) % 4)
    );
}
```

编码函数从里往外看就三个动作，下面分别列一下。解码则反着来，先换回字符，再把去掉的填充补回来，最后交给 Base64 解码器。

- `base64_encode($data)`：先做标准 Base64；
- `strtr(..., '+/', '-_')`：按照两个字符串的位置逐字符替换，`+` 对应 `-`，`/` 对应 `_`；
- `rtrim(..., '=')`：把末尾的 `=` 全剃掉——反正解码时能算出来该补几个，先剃了省事。

解码里稍微绕一点的是补 `=` 的公式，长度刚好是 4 的倍数时不用补，其他情况补到 4 的倍数。理解这个就行，别看着两个取余就以为在做什么加密。

- `strtr($data, '-_', '+/')`：先把字符换回去；
- `str_repeat('=', (4 - strlen($data) % 4) % 4)`：Base64 规定长度必须是 4 的倍数，编码时剃了几个 `=`，解码就得补回几个。这个公式就是在算该补几个：长度对 4 取余，再用 4 减它。那为什么外面还要再包一层 `% 4`？处理刚好整除的情况——`4 - 0 = 4`，但其实一个都不用补，再取一次余把 4 归零。一个公式兜住两种情况，Base64Url 的经典补位写法，见着认识就行。

## 第 2 步：管好密钥

密钥不能随手编，得用足够长的密码学安全随机数。先生成一次，保存在服务器环境变量或 Web 根之外的配置里，不是每个请求重新生成，不然后端刚签完自己都验不回来。

```php
// 生成一把：php -r "echo bin2hex(random_bytes(32));"
// 然后写进服务器的环境变量，代码里永远只这样取：
$secret = getenv('JWT_SECRET');
```

命令里的两个函数分别负责生成随机字节和转成方便保存的文本，下面拆一下。这里的环境变量读取也只是示例，正式实现还要检查缺失和长度，不能拿空值继续签 token。

- `random_bytes(32)`：生成 32 字节的 **密码学安全随机数**。32 字节 = 256 位，正好匹配 HS256 的强度。注意是 random_bytes，不是 rand()——后者是能被预测的伪随机，拿它做密钥等于把密码设成 123456 还贴在门上；
- `bin2hex(...)`：把每个字节写成两个十六进制字符，32 字节出来 64 个字符，这就是你的密钥；
- 生成完放哪？服务器的环境变量，或者 Web 根之外的 `.env` 文件。**不进代码、不进 Git**——提交过一次的东西，Git 都替你记着，工作区的文件删了它也不删记忆，比谁都有记性。

密钥一旦泄露，别人就能签出后端认可的 token，所以不能觉得藏在 PHP 文件里就行了。误提交过的密钥应该轮换，删掉当前文件不等于 Git 历史和别人手上的副本都消失，这个后面还会提到。

## 第 3 步：签发 generateJWT()

签发先准备 Header 和 Payload，编码后用 `hash_hmac` 计算签名，再把三段连起来。HS256 的核心就是 HMAC-SHA256，名字长一点，函数倒没那么长，先看下面这份简化实现。

```php
function generateJWT(int $userId, string $nickname, string $avatarUrl): string
{
    $header  = ['alg' => 'HS256', 'typ' => 'JWT'];
    $payload = [
        'user_id'    => $userId,
        'nickname'   => $nickname,
        'avatar_url' => $avatarUrl,
        'exp'        => time() + 2160 * 3600,  // 3 个月
    ];

    $base64Header  = base64UrlEncode(json_encode($header));
    $base64Payload = base64UrlEncode(json_encode($payload));

    $signature = hash_hmac('sha256',
        $base64Header . '.' . $base64Payload, getenv('JWT_SECRET'), true);

    return "{$base64Header}.{$base64Payload}." . base64UrlEncode($signature);
}
```

Header 固定声明 HS256 和 JWT，Payload 放本站用到的字段，`exp` 是当前时间加 2160 小时，也就是 90 天。先 `json_encode`，再分别做 Base64Url 编码，前两段就有了。实际还要处理 JSON 编码失败，不要失败了也继续往下拼。

签名用下面这句，把编码后的前两段用点号连起来，再配上密钥计算。签发和验证必须使用完全相同的这段文本，不是解码后重新排一下 JSON 再算，否则内容看着一样，字节顺序却可能变了。

```php
$signature = hash_hmac('sha256', $base64Header . '.' . $base64Payload, getenv('JWT_SECRET'), true);
```

`hash_hmac` 可以理解成 **带钥匙的哈希**。普通哈希（md5、sha256）谁都能算，输入一样输出就一样；HMAC 多了一把钥匙——没有钥匙，同样的输入你也算不出同样的输出。四个参数挨个数：`'sha256'` 算法；原料是前两段用点号拼起来的字符串；钥匙是你的密钥；最后的 `true` 表示 **给我原始二进制**——不传的话返回的是十六进制字符串，长度翻倍还没必要。

签名返回的是二进制，也要转成 Base64Url 才能拼进去。最后三段用点号连上就得到 token，这一步倒不复杂，真正麻烦的是密钥、字段和错误处理不能随便省掉。

## 第 4 步：验证 verifyJWT()

验证先检查是不是三段，再用前两段重新计算签名，与收到的第三段比较。下面的示例只演示主线，尤其 `exp` 缺失时会被放过，严格 Base64Url 解码、Header 和 `user_id` 检查也不齐，生产使用不能只复制这一段。

```php
function verifyJWT(string $jwt): ?array
{
    $parts = explode('.', $jwt);
    if (count($parts) !== 3) return null;

    [$header, $payload, $signature] = $parts;

    $expectedSig = base64UrlEncode(
        hash_hmac('sha256', $header . '.' . $payload, getenv('JWT_SECRET'), true)
    );

    // hash_equals 恒定时间比较，防时序攻击
    if (!hash_equals($expectedSig, $signature)) return null;

    $data = json_decode(base64UrlDecode($payload), true);
    if (!is_array($data)) return null;

    if (isset($data['exp']) && $data['exp'] < time()) return null;

    return $data;  // user_id、nickname、avatar_url 都在这
}
```

先按示例走一遍，认识每行在做什么。理解完还得把缺的检查补上：只接受指定算法，要求 `exp` 存在且类型正确，当前时间达到过期时间就拒绝，用户标识也要符合约定。

- `explode('.', $jwt)`：按点号拆成三段，还原出 Header、Payload、Signature；
- `count($parts) !== 3`：先验明格式——连三段都不是的，直接出局，后面统统不用算；
- 重算签名那几行：和第 3 步一模一样的配方，同样的前两段、同样的密钥。哈希是 **确定性** 的，输入一样输出永远一样。所以验签根本不需要什么解密——我算一遍，看你带的和我算的是不是同一个，就完了；
- `hash_equals($expectedSig, $signature)`：新手必踩的坑，下面单独说；
- `json_decode(base64UrlDecode($payload), true)`：把 payload 从 Base64Url 解回 JSON 再解成 PHP 数组。第二个参数 `true` 表示要关联数组（按键取值），不要 stdClass 对象；
- `$data['exp'] < time()`：示例在 exp 存在且小于当前时间时拒绝，正式校验还需处理字段缺失、类型及到期边界；
- 通过这些示例检查后返回 `$data`，接口仍要验证用户状态和操作权限，不能直接当成所有业务都已经放行。

签名比较用了 `hash_equals`，不是普通的 `===`。它是用来做时序安全比较的，避免比较过程因为匹配到哪里而泄露额外线索。不是说随便测几次响应就一定能猜出密钥，也不是说用这一行整个接口就恒定耗时，但既然 PHP 提供了专门的比较函数，这里没必要自己省掉。

## 第 5 步：接口收口 verifyJWTFromHeader()

token 从请求头进来，还需要一个函数负责提取和调用验证。通过就把 Payload 交给接口，失败统一返回 401，别让每个文件都复制一份正则，最后有的接口严格，有的接口只看见 Bearer 就放行。

```php
function verifyJWTFromHeader(): array
{
    $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (preg_match('/^Bearer\s+(\S+)$/i', $auth, $m)) {
        $payload = verifyJWT($m[1]);
        if ($payload !== null) return $payload;
    }

    http_response_code(401);
    header('Content-Type: application/json');
    echo json_encode(['ok' => false, 'message' => '未登录或登录已过期']);
    exit;
}
```

这里主要看怎么读取 Authorization、怎么取 Bearer 后面的内容，以及失败时怎么结束请求。鉴权失败就及时退出，后面的修改资料、上传文件不应该继续执行。

- `$_SERVER['HTTP_AUTHORIZATION']`：PHP 取请求头的姿势——头名全大写、横线换下划线、前面加 `HTTP_`，Authorization 就变成了 HTTP_AUTHORIZATION。第一次见会觉得诡异，见多了就认识了；
- `preg_match('/^Bearer\s+(\S+)$/i', $auth, $m)`：前端发的是 `Authorization: Bearer eyJxxx...`，正则把 Bearer 后面那串抓出来。`\S+` 匹配一串非空白字符，末尾的 `i` 表示忽略大小写，bearer、BEARER 都认；
- 验不过的兜底：回 401 + 一段 JSON + `exit`。401 的官方含义是 **没带有效证件**——前端看到这个状态码，就知道该清登录态、请用户重新登录了。

接口需要登录时先调用它，再根据业务查询用户状态、检查操作权限。验签能确认 token 来源，不等于已经确认账号仍存在，更不等于这个用户有权操作所有资源。

```php
$user = verifyJWTFromHeader();  // 能走到这的，一定是验签通过的有效用户
```

## 第 6 步：前端配套

前端这边主要是带凭据和处理过期。请求该带 token 的时候加上 Authorization，拿到 401 就清掉失效登录态、引导重新登录，别一直拿同一串过期 token 重试。

```ts
const res = await fetch(`${API}/profile`, {
  headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
});

if (res.status === 401) clearLogin();  // 清登录态，引导重新登录
```

界面还可以先解析 `exp`，已经过期就别假装用户还登录着。不过下面这段同样是简化示例，实际要捕获解析异常、处理 Base64 补位，并校验 `exp` 类型，格式不对就按无效登录处理，不能让坏 token 把整个页面弄白屏。

```ts
function isExpired(token: string): boolean {
  const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  // payload 里有中文昵称，必须用 TextDecoder 解 UTF-8，直接用 raw 会乱码
  const payload = JSON.parse(new TextDecoder().decode(
    Uint8Array.from(raw, c => c.charCodeAt(0)),
  ));
  return payload.exp * 1000 < Date.now();
}
```

这里最容易忽略的是中文和时间单位。Base64 解出的是字节内容，UTF-8 昵称需要正确还原；`exp` 按秒，`Date.now()` 按毫秒，比较前得统一，不然有效期会差得很离谱。

- `token.split('.')[1]`：按点号拆开，取第二段——payload；
- `.replace(/-/g, '+').replace(/_/g, '/')`：把 URL 安全字符换回标准 Base64——就是第 1 步 PHP 里那个反向操作的 JS 版；
- `atob(base64)`：Base64 解码。坑来了——atob 解出来的字符串按 Latin-1 处理，一个字符当一个字节；可 payload 里的中文昵称是 UTF-8 编码，一个字占三个字节，直接用 `raw` 全是乱码；
- `Uint8Array.from(raw, c => c.charCodeAt(0))` + `new TextDecoder()`：所以先把字符串按字节还原成数组，再让 TextDecoder 按 UTF-8 重新解码，中文昵称就完好无损了。代码里那行注释不是装饰，是我对着满屏乱码发过呆换来的；
- `payload.exp * 1000 < Date.now()`：最后一步单位对齐——`exp` 是秒级时间戳，`Date.now()` 返回毫秒级，乘 1000 才在同一个单位下比较。

主流程到这里就串起来了，至少以后看见那串 token，知道它怎么来的、后端在验什么。不引库是为了拆开学，不是因为库多余，真做生产认证时少写几个函数反而可能更省心。

# 三 · 尾声：代价与选择

## 方便归方便，代价也在

最明显的是主动吊销。只做无状态验签时，退出登录删掉的是本地副本，别人拿走的那枚 token 并不会跟着消失。可以通过黑名单、用户版本号、短期凭据和轮换等机制处理，但就得增加状态或流程；换密钥能让旧 token 全失效，却会把正常用户也一起踢下线。90 天有效期的暴露窗口不短，这是当时方案的缺口，不是个人站就天然没事。

localStorage 也有 XSS 风险，恶意脚本一旦进页面就可能读走 token。控制用户内容和第三方脚本很重要，但不能保证永远没有漏洞。HttpOnly Cookie 能减少凭据被脚本直接读取的机会，同时又需要把 Cookie 和 CSRF 防护做好，没有换个存储位置就全部解决的捷径。

Payload 不是秘密保险箱，邮箱等没必要带的数据就别放。权限声明不是不能放，而是会有过期和更新不及时的问题，敏感操作不能只看一份很久以前签发的权限快照。密钥更要妥善保管，泄露了就轮换，别等别人帮我测试登录安全。

## 结语

最后把当时想解决的问题放在下面，不是给 JWT 发冠军奖状。它确实适合我想练习的这套流程，但该补的校验、凭据保护和会话管理，一项都不会因为选了它就自己长出来。

| 场景约束 | JWT 的回应 |
|---------|-----------|
| 跨子域前后端分离 | Header 显式传 token，配合 CORS；OAuth 等流程仍需防护 |
| 轻量部署、不想多一层会话存储 | 基础验签不查会话存储，业务校验可能仍查库 |
| OAuth + 验证码双登录入口 | 统一收敛到同一个签发函数 |
| 前后端各自判断过期 | `exp` 声明天然自描述 |

如果做的是同域应用，或者经常需要踢人下线的后台，Session 可能反而更直接，别为了用 JWT 把简单的事绕复杂。我这次算是把 token 拆开认识了一遍，接下来拿它去做真正要登录的功能，看看还会遇到什么问题。
