---
title: JWT 登录校验的选型与手写实现
description: 跨子域前后端分离场景下的登录态方案。上篇分析 Session 与 JWT 的取舍，下篇用原生 PHP 手写完整实现——五个函数、不到百行，逐步拆解，不依赖任何库。
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

做登录这块的时候，我在 Session 和 JWT 之间来回横跳了好几天，最后拍板 JWT。这篇分上下两篇：上篇讲为什么选它，四条理由一条条摆开；下篇讲怎么写，五个函数全部手写，一行一行讲给你听。代码抄走就能用——密钥除外，那个是我的。赶时间想直接抄代码的，跳到下篇；想听我唠为什么的，从头看。

# 一 · 选型篇：为什么是 JWT

## 背景：一个 www，一个 api

先把舞台搭好。前端是 React SPA，挂在 `www.fuhao574.cyou`；后端是原生 PHP 接口，挂在 `api.fuhao574.cyou`。数据层一边 MySQL 存用户，一边 Upstash Redis 存邮箱验证码。

注意这个细节：一个 www，一个 api。在浏览器眼里，这是 **两个站**。这是后面所有纠结的根源，四条理由里有一半是它贡献的。

登录体系做了双模式设计：

- **Visitor（游客）**：填个昵称就能进，纯前端身份，不参与任何鉴权，状态存 localStorage，90 天过期——来观光的，不查证件；
- **Friend（朋友）**：真实用户，走 GitHub OAuth（唯一的用户创建入口）或邮箱验证码登录，持有 JWT，可上传头像、修改资料——办了年卡的。

Friend 模式下所有需要身份的接口——上传头像、修改资料、同步 GitHub 头像——都靠 JWT 校验。为什么是它？往下看。

## 候选方案：Session 还是 JWT

查来查去，主流方案就两条路。为了不抽象，先打个比方。

**Session + Cookie 像游乐园的储物柜**。入场时把身份存进柜子，工作人员发你一块手牌（Session ID）。之后每次进场，出示手牌，工作人员跑回柜子核对——身份信息永远存在乐园那边（服务端），你手上只有一块手牌。

**JWT 像演唱会的防伪手环**。入场时工作人员把你的信息直接印在手环上——座位号、日期，再盖一道官方防伪章。之后每次进出，工作人员只看那道章：真章，放行。没有柜子，没有登记簿，验完即走。

两条路都能把人送进乐园，但在我的场景里，JWT 的优势是压倒性的。一条条说。

## 理由一：跨子域，Cookie 太别扭了

最直接的原因。前端在 `www.`，后端在 `api.`——再念一遍，浏览器眼里这是两个站。

用 Cookie + Session 的话，同源策略不允许浏览器把 `api.fuhao574.cyou` 的 Cookie 自动带给跨域请求。想让它带上，得凑齐三件套：

1. 后端 CORS 配置加 `Access-Control-Allow-Credentials: true`——告诉浏览器：这个跨域请求允许带证件；
2. 前端每个请求开 `withCredentials: true`——告诉浏览器：这次请把 Cookie 带上；
3. Cookie 设置 `SameSite=None; Secure`——告诉浏览器：跨站也发，别拦。现代浏览器不加这个直接拒发。

三步都做完，恭喜，附赠一个全新攻击面——CSRF，赠品不退不换。Cookie 是浏览器 **自动携带** 的，第三方页面诱导用户发的跨站请求照样带着凭证，我还得再加 CSRF Token 或校验 `Origin` 头来防。

JWT 走的是 `Authorization: Bearer <token>` 头：浏览器从不自动发送，必须我的 JS 代码亲手附加。**CSRF 这个攻击类别直接从架构上消失了**——不是被防御了，是不存在了。跨域只剩标准的 CORS 白名单（我的后端只认 `www.fuhao574.cyou` 一个来源），干净利落。

## 理由二：无状态验证，不碰数据库

JWT 的 payload 是自包含的，我的 token 里装着这些东西：

```json
{
  "user_id": 42,
  "nickname": "Fuhao574",
  "avatar_url": "https://avatars.githubusercontent.com/u/xxx",
  "exp": 1787595600
}
```

验签通过，`user_id`、昵称、头像 URL 直接从 payload 里读——信息就印在手环上，检票员看一眼就放行，不用跑回登记处查你是谁，**一次 MySQL 查询都省了**。跑在轻量服务器上的个人博客，每个鉴权请求的开销就是一次 HMAC 运算，微秒级。

Session 则每个请求都得回柜子查一次。PHP 原生的 Session 是文件存储，绑死在单机；换 Redis 也只是把 **查库** 变成 **查缓存**，还多一层运维心智负担。

顺带一提，无状态还意味着 **水平扩展零成本**——哪天流量真大到要加机器（个人站，这天大概率排在很远的未来），共享同一个 `JWT_SECRET`，谁来验签都行，不用做会话同步。

## 理由三：和 GitHub OAuth 天然衔接

这个站的用户全部经 GitHub OAuth 创建。回调流程跑完，GitHub 给我的是一个 access token——但那是 **GitHub 的凭证**，相当于别人家乐园的手环，不能直接拿来在我家进场：语义不对、没法自定义过期、也没装我需要的用户信息。

所以回调的最后一步，是把第三方身份 **转换** 成自有会话：查库拿到 user_id，签一枚自己的 JWT。前端拿到后存 localStorage，从此和 GitHub 再无关系：

```
GitHub OAuth 授权 → 回调 → 签发自己的 JWT → 后续请求全部用 JWT
```

JWT 是做这种 **身份转换** 最顺手的载体。邮箱验证码登录也是同一条路的另一个入口——验证码校验通过，同样落到 `generateJWT()` 这一个函数上。两条路，殊途同归。

## 理由四：过期控制前后端对称

JWT 规范内置 `exp` 声明（过期时间），我设了 3 个月。有意思的是，这让前端也能独立判断登录态：

- **Friend 模式**：前端解析 JWT 读 `exp`，过期即清除本地登录态；
- **Visitor 模式**：localStorage 存 `_savedAt` 时间戳，90 天过期。

两种模式的过期逻辑就这么对称上了。前端不用发探测请求去问服务端 **我还登录着吗**——claim 里写着答案。服务端验签时同样检查 `exp`，双重保险。

## 四条理由，一张表

| 维度 | Session + Cookie | JWT |
|------|-----------------|-----|
| 跨子域携带 | CORS + Cookie 策略三件套，别扭 | Header 显式携带，天然跨域 |
| 每请求开销 | 查一次会话存储 | 一次 HMAC 运算，微秒级 |
| CSRF | 需额外防御 | 架构上不存在 |
| 多登录入口 | 会话表各落一条，各自维护 | 统一收敛到一个签发函数 |
| 过期判断 | 前端得发探测请求 | `exp` 自描述，前后端对称 |
| 主动吊销 | 删会话即可 | 做不到（除非上黑名单） |

最后一行是 JWT 唯一输掉的地方，留到最后说。

# 二 · 实现篇：手写 JWT 的每一步

全程不引库，核心就五个函数，加起来不到一百行。别慌，每个都掰开揉碎讲——看完这篇，你就可以说 JWT 我手写过。

## 第 0 步：先看清 token 长什么样

动手之前先拆开看看。JWT 一点都不神秘：三段字符串，拿点号连起来，没了。

```
eyJhbGciOiJIUzI1NiJ9 . eyJ1c2VyX2lkIjo0Mn0 . SflKxwRJSMeKKF2QT4fwpMeJ...

第一段 Header    →  手环的说明书：{"alg": "HS256"}——声明用哪种算法盖的章
第二段 Payload   →  手环上印的信息：user_id、nickname、exp
第三段 Signature →  那道防伪章：用密钥对前两段做 HMAC-SHA256
```

有两件事必须现在说清，不然后面全是坑：

**前两段只是 Base64Url 编码，不是加密。** 谁拿到 token 都能解开看，明明白白——不信把自己的 token 丢到 jwt.io 里试试。所以 payload 里别放秘密，它是印在手环 **外面** 的字，不是塞在手环里的纸条。

**真正保平安的是第三段签名。** 前两段哪怕被改动一个字节，用密钥算出来的签名都对不上，token 立刻作废。信息可以随便改，章你盖不出来——这就是 JWT 的全部底气。

结构就这么点东西，剩下的全是体力活。

## 第 1 步：base64Url 编解码

JWT 会跑到各种地方——HTTP 头里、URL 里、localStorage 里——所以它用的是 **URL 安全特供版** Base64。标准 Base64 会产出 `+`、`/`、`=` 三个字符，它们在 URL 里全有编制：`+` 会被读成空格，`/` 是路径分隔符，`=` 用来分隔查询参数，谁碰上谁出事。特供版的处理简单粗暴：`+` 换成 `-`、`/` 换成 `_`、末尾的 `=` 干脆不要。

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

编码就三个动作，从里往外读：

- `base64_encode($data)`：先做标准 Base64；
- `strtr(..., '+/', '-_')`：按对照表把两个危险字符换成安全字符。strtr 是 PHP 的 **字符串翻译器**，给一张"谁换谁"的表，逐字符替换；
- `rtrim(..., '=')`：把末尾的 `=` 全剃掉——反正解码时能算出来该补几个，先剃了省事。

解码是反向操作，玄机全在补 `=` 那一行：

- `strtr($data, '-_', '+/')`：先把字符换回去；
- `str_repeat('=', (4 - strlen($data) % 4) % 4)`：Base64 规定长度必须是 4 的倍数，编码时剃了几个 `=`，解码就得补回几个。这个公式就是在算该补几个：长度对 4 取余，再用 4 减它。那为什么外面还要再包一层 `% 4`？处理刚好整除的情况——`4 - 0 = 4`，但其实一个都不用补，再取一次余把 4 归零。一个公式兜住两种情况，Base64Url 的经典补位写法，见着认识就行。

## 第 2 步：管好密钥

密钥是整个方案里唯一真正要严防死守的东西，先把规矩立下：

```php
// 生成一把：php -r "echo bin2hex(random_bytes(32));"
// 然后写进服务器的环境变量，代码里永远只这样取：
$secret = getenv('JWT_SECRET');
```

这行命令拆开看：

- `random_bytes(32)`：生成 32 字节的 **密码学安全随机数**。32 字节 = 256 位，正好匹配 HS256 的强度。注意是 random_bytes，不是 rand()——后者是能被预测的伪随机，拿它做密钥等于把密码设成 123456 还贴在门上；
- `bin2hex(...)`：把每个字节写成两个十六进制字符，32 字节出来 64 个字符，这就是你的密钥；
- 生成完放哪？服务器的环境变量，或者 Web 根之外的 `.env` 文件。**不进代码、不进 Git**——提交过一次的东西，Git 都替你记着，工作区的文件删了它也不删记忆，比谁都有记性。

为什么这么较真？密钥泄露等于任何人都能伪造全站用户的身份。尾声有一整段说它。

## 第 3 步：签发 generateJWT()

HS256 听着唬人，其实就是一次 `hash_hmac`。整个函数按 **备料 → 编码 → 盖章 → 拼装** 四步走：

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

**备料。** header 是说明书，两个键：alg 用哪种算法、typ 什么类型，固定写法。payload 是要带的信息，四个字段里 `exp` 是重点——`time() + 2160 * 3600`，当前时间戳加上 2160 个小时，正好 3 个月，过期时间就定在这。

**编码。** `json_encode` 把 PHP 数组变成 JSON 字符串，再各自过一遍第 1 步的 `base64UrlEncode`，变成两段 URL 安全的文本。前两段到此完工。

**盖章。** 核心就一句：

```php
$signature = hash_hmac('sha256', $base64Header . '.' . $base64Payload, getenv('JWT_SECRET'), true);
```

`hash_hmac` 可以理解成 **带钥匙的哈希**。普通哈希（md5、sha256）谁都能算，输入一样输出就一样；HMAC 多了一把钥匙——没有钥匙，同样的输入你也算不出同样的输出。四个参数挨个数：`'sha256'` 算法；原料是前两段用点号拼起来的字符串；钥匙是你的密钥；最后的 `true` 表示 **给我原始二进制**——不传的话返回的是十六进制字符串，长度翻倍还没必要。

**拼装。** 签名是二进制数据，什么字节都有，直接拼进 token 会乱套，所以也要过一遍 `base64UrlEncode` 变成文本。三段拿点号一连，return——一枚新鲜出炉的 JWT。

## 第 4 步：验证 verifyJWT()

验证就是把签发倒着放：原料相同、钥匙相同，重算一遍签名，跟 token 里带的那段比。

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

逐行过：

- `explode('.', $jwt)`：按点号拆成三段，还原出 Header、Payload、Signature；
- `count($parts) !== 3`：先验明格式——连三段都不是的，直接出局，后面统统不用算；
- 重算签名那几行：和第 3 步一模一样的配方，同样的前两段、同样的密钥。哈希是 **确定性** 的，输入一样输出永远一样。所以验签根本不需要什么解密——我算一遍，看你带的和我算的是不是同一个，就完了；
- `hash_equals($expectedSig, $signature)`：新手必踩的坑，下面单独说；
- `json_decode(base64UrlDecode($payload), true)`：把 payload 从 Base64Url 解回 JSON 再解成 PHP 数组。第二个参数 `true` 表示要关联数组（按键取值），不要 stdClass 对象；
- `$data['exp'] < time()`：过期了？出局。伪造得再像，过期也是白搭；
- 都过了，返回 `$data`——user_id、昵称、头像全在里面，接口随便用。

**为什么用 hash_equals 不用 ===？** 普通字符串比较是个急性子：从头逐字节比，发现第一个不同的字节立刻返回 false。听起来很高效？但这泄露了信息——理论上攻击者可以拿一堆伪造 token 去试，靠 **服务器响应的快慢** 推断签名前几个字节是对的（对得越多，比较耗时越长），一个字节一个字节爆破出完整签名。这叫 **时序攻击**。`hash_equals` 是个见过世面的门卫：不管暗号对到第几个字，摇头都摇满全程——对上三个字摇一秒，一个没对上也摇一秒，掐表也看不出区别，这个侧信道就此堵死。一行代码的事，没有理由不用。

## 第 5 步：接口收口 verifyJWTFromHeader()

裸的 `verifyJWT()` 还不能直接用——token 是从 HTTP 头里来的，得有人去取。这层壳就是 `verifyJWTFromHeader()`：

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

三个知识点：

- `$_SERVER['HTTP_AUTHORIZATION']`：PHP 取请求头的姿势——头名全大写、横线换下划线、前面加 `HTTP_`，Authorization 就变成了 HTTP_AUTHORIZATION。第一次见会觉得诡异，见多了就认识了；
- `preg_match('/^Bearer\s+(\S+)$/i', $auth, $m)`：前端发的是 `Authorization: Bearer eyJxxx...`，正则把 Bearer 后面那串抓出来。`\S+` 匹配一串非空白字符，末尾的 `i` 表示忽略大小写，bearer、BEARER 都认；
- 验不过的兜底：回 401 + 一段 JSON + `exit`。401 的官方含义是 **没带有效证件**——前端看到这个状态码，就知道该清登录态、请用户重新登录了。

所有需要鉴权的接口，第一行都是它：

```php
$user = verifyJWTFromHeader();  // 能走到这的，一定是验签通过的有效用户
```

一行，安全感拉满。

## 第 6 步：前端配套

前端只要做两件事。

**第一件，每个请求把 token 带上：**

```ts
const res = await fetch(`${API}/profile`, {
  headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
});

if (res.status === 401) clearLogin();  // 清登录态，引导重新登录
```

**第二件，不发请求就能判断过期。** `exp` 就明明白白写在 payload 里，自己解析就行：

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

这十来行值得逐行拆，因为每一行都在填坑：

- `token.split('.')[1]`：按点号拆开，取第二段——payload；
- `.replace(/-/g, '+').replace(/_/g, '/')`：把 URL 安全字符换回标准 Base64——就是第 1 步 PHP 里那个反向操作的 JS 版；
- `atob(base64)`：Base64 解码。坑来了——atob 解出来的字符串按 Latin-1 处理，一个字符当一个字节；可 payload 里的中文昵称是 UTF-8 编码，一个字占三个字节，直接用 `raw` 全是乱码；
- `Uint8Array.from(raw, c => c.charCodeAt(0))` + `new TextDecoder()`：所以先把字符串按字节还原成数组，再让 TextDecoder 按 UTF-8 重新解码，中文昵称就完好无损了。代码里那行注释不是装饰，是我对着满屏乱码发过呆换来的；
- `payload.exp * 1000 < Date.now()`：最后一步单位对齐——`exp` 是秒级时间戳，`Date.now()` 返回毫秒级，乘 1000 才在同一个单位下比较。

数一下：五个函数，不到一百行，全程没跑过一次 composer install。看到这里，你已经手写过 JWT 了。

# 三 · 尾声：代价与选择

## 诚实的代价

选 JWT 不是没有成本，这几条我都掂量过：

**无法主动吊销。** JWT 签发后的 3 个月里，服务端没有任何办法作废它——**退出登录** 只是前端把 localStorage 删了，token 本身到过期前始终有效，好比工牌扔了，门禁系统里你还是正式员工。真泄露了，最坏情况是攻击者能以我的身份改资料传头像，直到过期。要根治得上 **黑名单**（本质是把无状态方案退化回有状态），违背了选它的初衷。个人博客的资产敏感度，我接受这个风险。

**localStorage 有 XSS 窃取风险。** token 存 localStorage，一旦页面被注入恶意脚本，token 就能被读走。缓解方式是控制攻击面：这个站没有第三方评论、没有广告脚本、用户输入全部转义渲染。要是金融类应用，该考虑 HttpOnly Cookie + refresh token 的组合。

**payload 是明文。** Base64 是编码不是加密，谁拿到 token 都能解出里面的内容。所以 payload 要按 **明信片** 的标准来写——反正路过的人都能看；user_id、昵称、头像 URL 这种本来就公开的信息可以放，邮箱、权限级别这种日记本内容，一概不进。

**密钥即一切。** `JWT_SECRET` 泄露等于任何人都能伪造全站用户的身份。生产环境务必用长随机密钥并妥善保管——这也是 JWT 方案里唯一真正要严防死守的东西。

## 结语

技术选型没有银弹，只有场景匹配。我的决策依据，收进一张表：

| 场景约束 | JWT 的回应 |
|---------|-----------|
| 跨子域前后端分离 | Header 传 token，绕开 Cookie 跨域与 CSRF |
| 轻量部署、不想多一层会话存储 | 无状态验签，零查询开销 |
| OAuth + 验证码双登录入口 | 统一收敛到同一个签发函数 |
| 前后端各自判断过期 | `exp` 声明天然自描述 |

如果你的项目形态和我不一样——单体应用、同域部署、需要 **踢人下线** 的管理后台——Session 或许仍是更省心的选择。但如果你的约束碰巧和我这几条重合，希望这篇能帮你少走一点弯路：理由在上面，代码在下面，都齐了。
