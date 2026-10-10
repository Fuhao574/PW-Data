---
title: 留言板从一张表长成楼中楼
description: 访客只读、Friend 留言、楼中楼回复、IP 属地、设备图标——一个个人站留言板的完整实现：表结构、原生 PHP 接口、React 楼中楼渲染，外加三个上线后才现形的坑。
published: 2026-09-09T10:00:00
category: 教程
tags:
  - 留言板
  - React
  - PHP
  - MySQL
  - 前后端分离
image: https://img.fuhao574.cyou/images/guestbook/guestbook-cover.webp
---

留言板是这个站第二个长出后端的功能，第一个是登录。它挂在关于页最底下，标题叫 **到此一游**：访客只能围观（门票免费，实在不好意思要求更多），Friend 登录后可以留言、回复，每条留言自动带上 IP 属地和设备图标，我的回复挂站长标记——整面墙上唯一带荧光笔的名字。

这篇按数据流的顺序讲：先建表，再写 PHP 接口，再写 React 楼中楼，最后是一段和 VPN 斗智斗勇的属地探测。代码全贴，拿去就能用。登录态那套 JWT 是上一篇的现成积木，这里不重复讲，只当 `verifyJWTFromHeader()` 一行黑盒用。

# 一 · 设计篇：动手前想清楚的三件事

## 身份不存快照

留言表最省事的做法：发留言时把昵称、头像一并塞进行里，读取时直接展示。省一次 JOIN，但埋了个雷——用户改了昵称，历史留言全是旧名字；换了头像，历史留言全是旧头像。人家明明已经改头换面重新做人，你墙上还钉着人家的旧名片。

我的做法是 messages 表只存 `user_id`，昵称、头像、站长标记读取时实时 JOIN users 表。改昵称立刻全站生效，不用写一行迁移代码。用户被删了呢？LEFT JOIN 兜底，留言还在，昵称显示 **已注销**。

代价是每次 GET 都多一次 JOIN。个人站的量级，这点开销可以忽略。

## 原始 IP 不入库

属地是给访客看的，原始 IP 是要替访客保管的——两码事。库里只存解析后的字符串（**江苏 南京** 这种），原始 IP 用完即弃。真要排查滥用，访问日志里有，没必要进业务表。

## 楼中楼用自引用

回复谁？一列 `parent_id` 搞定：NULL 是顶层留言，非 NULL 指向被回复的那条。查询不分页、全量拉（id 升序），树在前端组——个人站的留言量级，全量拉是最简单的方案，树也最好组。

```sql
CREATE TABLE IF NOT EXISTS `messages` (
  `id`         INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  `parent_id`  INT UNSIGNED    NULL DEFAULT NULL COMMENT '回复目标留言 id，NULL 为顶层留言',
  `user_id`    INT UNSIGNED    NOT NULL COMMENT '发言者 users.id',
  `content`    VARCHAR(500)    NOT NULL COMMENT '留言内容',
  `region`     VARCHAR(64)     NULL DEFAULT NULL COMMENT 'IP 属地（省 市 / 国家）',
  `device`     VARCHAR(16)     NULL DEFAULT NULL COMMENT '设备类型 windows/apple/linux/android',
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_parent` (`parent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='留言板';
```

# 二 · 后端篇：一个文件，两个入口

接口就一个 `messages.php`，两种请求方式两种命运：

| 方法 | 鉴权 | 入参 | 返回 |
|------|------|------|------|
| GET | 无 | — | 全部留言（含回复） |
| POST | Bearer JWT | content、parentId、region（可选） | 新建的那条 |

## CORS 先收口

前端 `www.`，后端 `api.`，跨子域，先解决谁能调。

先补个背景：浏览器对跨域请求自带一套安检流程——真正发 POST 之前，它会先悄悄替你发一个 OPTIONS 请求探路，问一句 **我接下来要带这些头、用这个方法，行不行**。这一步叫 **预检（preflight）**。服务器点头，正主才出门；不点头，请求根本发不出去。

所以代码要应付两种客人：OPTIONS 探子来了，直接回 204——**没有内容** 的意思，探子问完就走；正主来了，按白名单验明正身——生产域名精确匹配，本地开发用正则放行 localhost 任意端口，其余一律不放。

```php
$ALLOWED_ORIGINS = ['https://www.fuhao574.cyou'];
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$isDevOrigin = preg_match('#^https?://(localhost|127\.0\.0\.1)(:\d+)?$#', $origin) === 1;
if (in_array($origin, $ALLOWED_ORIGINS, true) || $isDevOrigin) {
    header("Access-Control-Allow-Origin: {$origin}");
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization');
}
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}
```

## GET：一条 SQL 拿全部

身份实时 JOIN，时间直接在 SQL 侧格式化成带 +08:00 的 ISO 串（为什么绕这一圈，下面时区坑里说）：

```php
$stmt = $pdo->prepare(
    'SELECT m.id, m.parent_id, m.content, m.region, m.device,
            DATE_FORMAT(m.created_at, "%Y-%m-%dT%H:%i:%s+08:00") AS created_at_iso,
            u.nickname AS author, u.avatar_url AS avatar_url,
            (u.email = :admin_email) AS is_admin
     FROM messages m
     LEFT JOIN users u ON u.id = m.user_id
     ORDER BY m.id ASC'
);
$stmt->execute([':admin_email' => ADMIN_EMAIL]);
respond(true, '', array_map('rowToMessage', $stmt->fetchAll()));
```

站长标记没有角色表，就是 `u.email = :admin_email`。这里有个小巧思值得单独说：SELECT 不只能选列，还能直接写 **表达式**——`u.email = :admin_email` 是个比较，结果非真即假，MySQL 里就是 1 或 0。相当于把 if 判断下放进数据库，白拿一个现成的 0/1 字段，PHP 侧 `(bool)` 一转就能用。

config 里的常量和自己的邮箱比对，对上就是站长。土办法，但单管理员场景够用——为一个人建一整张角色表，杀鸡不止用牛刀，是把牛刀厂都征用了。顺带一提，这行比较的大小写不敏感是 utf8mb4_unicode_ci 排序规则送的，和 POST 侧的 `strcasecmp` 行为刚好对齐。

行转 JSON 时把 LEFT JOIN 的兜底落实。两个运算符长得像双胞胎，干的不是一件事：`author` 用 `??`，只拦 **null**——LEFT JOIN 没配上的已注销用户，昵称兜成 **已注销**；`avatarUrl` 用 `?:`，拦 **一切假值**——空字符串也算，一律兜成空串。一个问 **存在不存在**，一个问 **有没有内容**：

```php
function rowToMessage(array $row): array
{
    return [
        'id'        => (int)$row['id'],
        'parentId'  => $row['parent_id'] !== null ? (int)$row['parent_id'] : null,
        'author'    => $row['author'] ?? '已注销',
        'avatarUrl' => $row['avatar_url'] ?: '',
        'isAdmin'   => (bool)$row['is_admin'],
        'content'   => $row['content'],
        'region'    => $row['region'] ?: '',
        'device'    => $row['device'] ?: '',
        'createdAt' => $row['created_at_iso'],
    ];
}
```

## POST：五道闸

POST 是唯一写入入口，整个流程像过机场安检：五道闸挨个走，哪道不过哪道请回。下面按真实顺序过一遍——先验证件，再开行李，最后放人登机：

```php
$payload = verifyJWTFromHeader();   // ① 验 JWT，不过直接 401
$userId  = (int)$payload['user_id'];

$rawInput  = file_get_contents('php://input');
$jsonInput = json_decode($rawInput, true);
$content   = trim($jsonInput['content'] ?? '');
$parentId  = $jsonInput['parentId'] ?? null;
$clientRegion = is_string($jsonInput['region'] ?? null) ? trim($jsonInput['region']) : '';

if ($content === '') {
    respond(false, '留言内容不能为空');                          // ② 内容
}
if (mb_strlen($content) > MESSAGE_MAX_LEN) {
    respond(false, '留言最长 ' . MESSAGE_MAX_LEN . ' 字');
}
if ($parentId !== null && (!is_int($parentId) || $parentId < 1)) {
    respond(false, '参数错误');                                 // ③ 回复目标：格式
}
```

③ 还要补一刀：parentId 得在表里真实存在，不然就是回复一条幽灵留言。

```php
if ($parentId !== null) {
    $stmt = $pdo->prepare('SELECT id FROM messages WHERE id = :id LIMIT 1');
    $stmt->execute([':id' => $parentId]);
    if ($stmt->fetch() === false) {
        respond(false, '要回复的留言不存在');
    }
}
```

④ 现查最新身份。JWT payload 里明明装着昵称和头像，但那是签发那一刻的旧值——拿旧登记照办今天的新业务，柜台不该认，数据库也不认。所以昵称、头像、站长标记都重新查库：

```php
$stmt = $pdo->prepare('SELECT email, nickname, avatar_url FROM users WHERE id = :id LIMIT 1');
$stmt->execute([':id' => $userId]);
$user = $stmt->fetch();
if ($user === false) {
    respond(false, '账号不存在');
}
$isAdmin = (strcasecmp((string)$user['email'], ADMIN_EMAIL) === 0) ? 1 : 0;
```

⑤ 属地和设备。~~属地优先信前端探测值（为什么，第四篇章专门讲），只做长度校验，超长或缺失回退 `REMOTE_ADDR` 解析~~：

> 更新：属地不再有服务端回退，三个 API 全挂就存 **未知**；设备也改由前端 `navigator.userAgent` 判定后随 body 传入，后端只做白名单校验。下面的代码已从后端移除，保留作历史记录。

```php
$region = ($clientRegion !== '' && mb_strlen($clientRegion) <= 64)
    ? $clientRegion
    : resolveRegion($_SERVER['REMOTE_ADDR'] ?? '');
$device = detectDeviceFromUA($_SERVER['HTTP_USER_AGENT'] ?? '');
```

五道闸全过，入库，把新建的那条原样回传——身份用刚查出的最新值，时间用当前时刻，省得再查一次库：

```php
$stmt = $pdo->prepare(
    'INSERT INTO messages (parent_id, user_id, content, region, device)
     VALUES (:parent_id, :user_id, :content, :region, :device)'
);
$stmt->execute([
    ':parent_id' => $parentId,
    ':user_id'   => $userId,
    ':content'   => $content,
    ':region'    => $region !== '' ? $region : null,
    ':device'    => $device !== 'other' ? $device : null,
]);
$newId = (int)$pdo->lastInsertId();

respond(true, '留言成功', [
    'id'        => $newId,
    'parentId'  => $parentId,
    'author'    => $user['nickname'],
    'avatarUrl' => $user['avatar_url'] ?? '',
    'isAdmin'   => (bool)$isAdmin,
    'content'   => $content,
    'region'    => $region,
    'device'    => $device,
    'createdAt' => date('Y-m-d\TH:i:s+08:00'),
]);
```

原则只有一条：**客户端传的身份一律不信任**。

两个校验细节值得单说。

长度用 `mb_strlen` 不是 `strlen`：中文一个字三个字节，用 strlen 的话两个汉字都算超长。前端 textarea 的 `maxLength=500`、后端的 500、数据库的 `VARCHAR(500)`，三处数的都是字符，刚好对齐。

~~设备判定的顺序是个坑：Android 的 UA 里同时含 Linux，必须先判 Android 再判 Linux，不然安卓用户全被认成 Linux 用户。~~

> 更新：这个坑本身依然成立，只是判定地点挪到了前端（`navigator.userAgent`，同样的顺序），后端不再解析 UA。

```php
function detectDeviceFromUA(string $ua): string
{
    if ($ua === '') return 'other';
    if (stripos($ua, 'Windows') !== false) return 'windows';
    if (preg_match('/Macintosh|iPhone|iPad|iPod/i', $ua)) return 'apple';
    if (stripos($ua, 'Android') !== false) return 'android';   // 必须在 Linux 之前
    if (stripos($ua, 'Linux') !== false) return 'linux';
    return 'other';
}
```

## 时区这个坑

服务器实测时区是 UTC+7，不是 +8。PHP `date()` 出来的时间直接拼个 `+08:00` 后缀，是假的——字面北京时间，实际慢一小时。

三处显式固定：

```php
date_default_timezone_set('Asia/Shanghai');           // PHP 侧
$pdo->exec("SET time_zone = '+08:00'");               // MySQL 会话侧
DATE_FORMAT(m.created_at, "%Y-%m-%dT%H:%i:%s+08:00")  // SQL 侧直接格式化，绕开 PHP
```

用 `+08:00` 偏移量而不是时区名，是因为共享主机的 MySQL 常常没装时区表，`SET time_zone = 'Asia/Shanghai'` 会直接报错。偏移量谁都会算。

## 缓存这个坑

上线当天发现：发了新留言，刷新页面看不见，强刷才出来。

原因：GET 是个无参数 fetch，响应头里没有任何缓存指令，浏览器就启用 **启发式缓存**——上次刚取过，看起来没变，直接吃本地副本。浏览器的本意是好的：能省的流量就省，能不跑的网就不跑。对静态资源这是美德，对实时留言是灾难——它不知道留言板活在当下，人家刚在墙上写了字，它还热情地递给你上周的墙。

修两头。前端这个请求永远走网络：

```ts
const res = await fetch('https://api.fuhao574.cyou/messages.php', { cache: 'no-store' });
```

后端在统一的 JSON 出口里把缓存头焊死，中间代理也不许存：

```php
function respond(bool $success, string $message, array $data = [], int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, no-cache, must-revalidate');
    header('Pragma: no-cache');
    echo json_encode(compact('success', 'message', 'data'), JSON_UNESCAPED_UNICODE);
    exit;
}
```

# 三 · 前端篇：楼中楼是棵树

前后端的契约是一个 TS 接口，字段和数据库列一一对应（camelCase 对 snake_case）：

```ts
export type DeviceKind = 'windows' | 'apple' | 'linux' | 'android' | 'other';

export interface GuestMessage {
  id: number;
  parentId: number | null;   // 回复谁（null = 新留言）
  author: string;
  avatarUrl?: string;
  isAdmin?: boolean;
  content: string;
  region?: string;           // 属地（省/市，前端三个 API 探测后写入）
  device?: DeviceKind;       // 设备（前端从 UA 判定后传入）
  createdAt: string;         // ISO 时间
}
```

## 扁平列表长成树

后端给的是 id 升序的扁平数组，渲染楼中楼得先组树。思路像修家谱，分两遍扫：**第一遍立户**——每条留言都先造一个带空 children 数组的节点，按 id 存进 `map`，不分长幼；**第二遍认亲**——挨个看 parentId，爹在名册里就把节点挂进爹的 children，爹不在（或者本来就是顶层）就请上 roots。两遍各扫一次，O(n)。

为什么必须分两遍？挂靠这个动作，要求爹的 children 数组 **先存在**。一遍循环里边造节点边认亲，挂到还没出生的爹，当场就报错了。先立户、后认亲，顺序不能反：

```ts
interface MsgNode extends GuestMessage {
  children: MsgNode[];
}

function buildTree(msgs: GuestMessage[]): MsgNode[] {
  const map = new Map<number, MsgNode>();
  msgs.forEach((m) => map.set(m.id, { ...m, children: [] }));
  const roots: MsgNode[] = [];
  map.forEach((n) => {
    // parentId 在表里 → 挂到父节点；不在（父留言没了）→ 降级为顶层，防孤儿
    if (n.parentId != null && map.has(n.parentId)) {
      map.get(n.parentId)!.children.push(n);
    } else {
      roots.push(n);
    }
  });
  const sortRec = (arr: MsgNode[]) => {
    arr.sort((a, b) => a.id - b.id);
    arr.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}
```

挂完树再递归按 id 排一遍，同层留言的时间顺序就不依赖接口的排序承诺了。防孤儿那行不是洁癖：万一以后做删除功能，被回复的留言没了，回复不至于跟着人间蒸发。

## 递归渲染 + 缩进

组件递归渲染自己，子楼层包一层 ReplyBranch 缩进——一级回复缩 48px，二级及更深 96px（再深就不缩了，空间留给内容），连接线二级以下换虚线，视觉上分出 **直接回复** 和 **深楼**：

```tsx
function MsgView({ msg, depth, all, onReply }: MsgViewProps) {
  const parent = msg.parentId != null ? all.get(msg.parentId) : undefined;
  return (
    <div className="msg-wrap">
      <MsgRow>
        {/* 头像 / 昵称 / 站长徽标 / 属地 / 设备图标 / 时间 */}
        {parent && <ReplyTo>↩ 回复 <b>{parent.author}</b></ReplyTo>}
        <Txt>{msg.content}</Txt>
        <ReplyBtn onClick={() => onReply(msg)}>↩ 回应</ReplyBtn>
      </MsgRow>
      {msg.children.map((c) => (
        <ReplyBranch $depth={depth + 1} key={c.id}>
          <span className="conn" aria-hidden />
          <MsgView msg={c} depth={depth + 1} all={all} onReply={onReply} />
        </ReplyBranch>
      ))}
    </div>
  );
}
```

缩进和连接线的部分全在样式里，逻辑零行：

```ts
const ReplyBranch = styled.div<{ $depth: number }>`
  padding-left: ${({ $depth }) => ($depth >= 2 ? 96 : 48)}px;
  position: relative;

  .conn {
    position: absolute;
    left: -28px;
    top: 0;
    bottom: -15px;
    border-left: ${({ $depth }) =>
      $depth >= 2 ? '2px dashed #e0e5f5' : '2px solid #e0e5f5'};
  }
`;
```

**↩ 回复某某** 里的名字从 `all`（id → 留言的 Map）里现查，永远显示最新昵称——和后端不存身份快照是同一个哲学，这次发生在前端内存里。

**回应** 按钮平时隐身，hover 或键盘聚焦（focus-within）才出现；触屏设备（hover: none）常显。三种输入方式，都得能用。

## 换行这个坑

测试时发现：textarea 里敲的换行，发出去全变成空格。数据库里存的一直是 `\n`，问题出在渲染——HTML 默认把连续空白折叠成一个空格，换行符首当其冲。

一行 CSS 的事：

```css
white-space: pre-wrap;
```

值得记的是：旧留言一条都不用修，数据从头到尾都是对的，错的只是展示层。分清 **存错了** 和 **显示错了**，排查能省一半时间。

## 双态输入区

留言要署名，所以只有 Friend 能发。组件按登录态长两个样子：

- **未登录 / 访客**：虚线锁定框，文案 **登录，给这页盖个章**，按钮拉起全站复用的 LoginCard——登录组件不是留言板私有的，导航栏、个人中心用的是同一个；访客点楼层上的 **回应** 也一样，直接弹登录，不装死。
- **Friend**：完整输入区。回复状态下顶部多一条 **正在回复 某某**，可取消；500 字上限实时计数；发送中按钮禁用防连点。

发送的完整流程，POST 带上 JWT 和前端探测好的属地：

```ts
async function postMessage(
  content: string,
  parentId: number | null,
  token: string | undefined,
  realRegion: string | null
): Promise<GuestMessage> {
  const res = await fetch('https://api.fuhao574.cyou/messages.php', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ content, parentId, ...(realRegion ? { region: realRegion } : {}) }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) {
    throw new Error(json.message || '留言失败，请稍后再试');
  }
  return json.data as GuestMessage;
}
```

发送成功不整页刷新——POST 返回新建的那条，直接 append 进本地数组，树自动重组，新留言立刻上墙：

```ts
const handleSubmit = async () => {
  const content = draft.trim();
  if (!content || !isFriend || sending) return;
  setSending(true);
  try {
    const created = await postMessage(
      content, replyTo?.id ?? null, login?.token, realRegionRef.current
    );
    setMessages((prev) => [...prev, created]);
    setDraft('');
    setReplyTo(null);
    showToast('脚印已留下~', 'success');
  } catch (err) {
    showToast(err instanceof Error ? err.message : '留言失败，请稍后再试', 'error');
  } finally {
    setSending(false);
    textareaRef.current?.focus();
  }
};
```

后端挂了呢？GET 的 catch 里降级返回空数组，页面照常渲染，只是没有留言。**留言板坏，不能把关于页拖白屏**。POST 失败弹 toast，输入内容保留，用户不用重打。

## 顺手的小设计

- 头像缺失的，用名字首字母加一片渐变色——按名字哈希从六套里选，同一人永远同色；
- 设备图标是手贴的品牌 SVG（Windows / Apple / Linux / Android），配 aria-label 供读屏；
- 时间格式 `MM.DD · HH:mm`，等宽字体，像盖章；
- 首页的 **脚印数** 直接复用这个 GET 接口数 length，一个接口两处用。

# 四 · 属地：和 VPN 斗智斗勇

属地探测的第一反应是后端拿 `REMOTE_ADDR` 解析。但戴着代理一测就露馅：VPN 下 REMOTE_ADDR 是代理出口，人在国内，解析出来可能是机房所在的城市——人在南京喝鸭血粉丝汤，属地显示在硅谷，围观群众只会以为我在吹牛。

好在分流规则是 **国内域名直连**。那就让前端去问国内域名——并发打三个国内 IP API，谁先解析出中国属地用谁：

```ts
const IP_API_CHAIN: { url: string; pick: (json: unknown) => RawRegion | null }[] = [
  {
    url: 'https://api-v3.speedtest.cn/ip',
    pick: (j) => {
      const d = (j as { data?: { country?: string; province?: string; city?: string } })?.data;
      return d?.province || d?.country
        ? { country: d?.country ?? '', province: d?.province ?? '', city: d?.city ?? '' }
        : null;
    },
  },
  // myip.ipipv.com、myip.ipip.net 同款结构，pick 各自适配字段
];
```

并发全测，五秒不回就放弃。代码里有两个 API 值得先认识一下：

`Promise.allSettled` 和 `Promise.all` 一字之差，脾气天差地别——`all` 是 **一损俱损**，任何一个失败，整批作废；`allSettled` 是 **各跑各的**，谁成谁败都如实汇报，最后统一收编。探测 IP 这种事，某个 API 抽风太正常了，当然选后者。

`AbortController` 是给 fetch 上的闹钟：五秒一到 `abort()` 一按，还在路上的请求直接掐掉，不许一个卡死的 API 拖住全场：

```ts
async function raceIpApis(): Promise<RawRegion | null> {
  const settled = await Promise.allSettled(
    IP_API_CHAIN.map(async (api): Promise<RawRegion | null> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(`${api.url}?t=${Date.now()}`, {
          cache: 'no-store',
          signal: ctrl.signal,
        });
        return api.pick(await res.json());
      } finally {
        clearTimeout(timer);
      }
    })
  );
  const hits = settled
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter((r): r is RawRegion => r !== null);
  // 优先命中国内属地（真实出口），都在国外则按链内顺序取第一个
  return hits.find((r) => r.country === '中国') ?? hits[0] ?? null;
}
```

原始结果五花八门——**江苏省**、**南京市**、**XX 特别行政区**——得格式化成 **江苏 南京** 这种微博风缩写：

```ts
const PROVINCE_ALIAS: Record<string, string> = {
  内蒙古自治区: '内蒙古',
  广西壮族自治区: '广西',
  西藏自治区: '西藏',
  宁夏回族自治区: '宁夏',
  新疆维吾尔自治区: '新疆',
};

function formatRegion(r: RawRegion): string {
  if (r.country && r.country !== '中国') return r.country;   // 国外只到国家
  const prov = stripSuffix(r.province, ['特别行政区', '省', '市']);
  const city = stripSuffix(r.city, ['市']);
  if (!prov) return '中国';
  if (!city || city === prov) return prov;                   // 直辖市去重
  return `${prov} ${city}`;
}

function stripSuffix(name: string, suffixes: string[]): string {
  if (PROVINCE_ALIAS[name]) return PROVINCE_ALIAS[name];     // 自治区走映射表
  for (const s of suffixes) {
    if (s && name.endsWith(s)) return name.slice(0, -s.length);
  }
  return name;
}
```

探测在组件挂载时就发起，用户打字的时间正好够跑完，发送时直接从 ref 里取，不阻塞提交。结果随 POST body 带给后端，后端只做长度校验——属地这种锦上添花的字段，不值得为它多一轮往返。

~~前端全失败呢？后端兜底：`REMOTE_ADDR` 走 ip2region 离线库（xdb 文件模式，不依赖第三方服务），再不行就留空：~~

> 更新：离线库这套已经删了，11MB 的 xdb 文件和查询器一并移除。属地完全交给前端三个 API，三个全挂时直接显示 **未知**，不再有服务端回退。下面这段代码保留作历史记录。

```php
function resolveRegion(string $ip): string
{
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) === false) {
        return '';   // 只处理 IPv4，v6 访客留空
    }
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) {
        return '本地';  // 内网 / 保留地址
    }
    try {
        $searcher = Searcher::newWithFileOnly(IPv4::default(), __DIR__ . '/data/ip2region_v4.xdb');
        $raw = $searcher->search($ip);
        $searcher->close();
    } catch (Throwable $e) {
        return '';
    }
    // 原始格式：国家|省/州|城市|运营商|国家代码
    [$country, $province, $city, , $countryCode] = explode('|', $raw);
    if ($country !== '中国') {
        return COUNTRY_CN[$countryCode] ?? $country;   // 国外：代码映射中文
    }
    $province = shortenProvince($province);            // 国内：省 + 市缩写
    $city = ($city === '0') ? '' : $city;
    if ($city !== '' && mb_substr($city, -1) === '市') {
        $city = mb_substr($city, 0, -1);
    }
    if ($province === '') return '中国';
    if ($city === '' || $city === $province) return $province;
    return $province . ' ' . $city;
}
```

~~三级降级——前端探测、后端离线库、留空——哪级断了都不影响留言本身。~~ 现在是两级：前端探测、兜底 **未知**。少维护一个 11MB 的二进制库，属地这种锦上添花的字段，值得为它牺牲一点容错。

# 尾声 · 坑与取舍

复盘这三个坑：缓存、换行、时区。它们的共性是不报错——浏览器默默缓存，HTML 默默折叠，时区默默偏移一小时。会哭的 bug 有人疼，不哭的才吓人。崩溃的 bug 反而好办，报错信息指哪打哪；这种 **静默偏差** 只能靠真机多试，早点把自己当小白用户。

几个如实交代的取舍：

- **实时 JOIN 的代价**是每次 GET 都带一次 users 表连接，量大要重新算账，个人站够用很久；
- **全量拉取不分页**，同样是用量级换简单；
- **JWT 无法主动吊销**，上一篇讲过的老问题，留言场景风险更低，更没所谓。

开发顺序上，我是先 `USE_MOCK = true` 让前端自闭环（假数据存 localStorage，刷新不丢），后端就绪后置 false 切真接口，mock 缓存自然弃用。一边学一边搭，这个顺序让前后端可以分开调，出了问题永远知道该往哪边查。

表在上面，接口在上面，组树在上面。想看实际效果——关于页拉到最底下就是它，留个脚印再走。
