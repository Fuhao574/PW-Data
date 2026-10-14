---
title: 留言板从一张表长成楼中楼
description: 本来想做个能留句话的地方，后来回复、属地和设备图标都加上了。记一下当时的表结构、PHP 接口和 React 楼中楼，顺便聊聊那些不报错却总不对劲的地方。
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

登录做完，总得让账号有点事情干，于是接着做了留言板。当时放在关于页最下面，叫到此一游，访客能看，Friend 登录后能留言和回复，还能显示属地、设备图标。我的名字旁边加个站长标记，免得回了半天，别人还不知道这是主人在说话。

本来觉得就是存一段文字，再读出来，应该不难。结果加上回复、资料同步和属地，事情又多了起来。下面按建表、PHP 接口、React 展示来写，最后再聊属地。代码是当时的节选和历史版本，不是当前生产接口的完整实现，后来的限流、人机验证、输入校验和缓存要另外接，别整篇复制完就直接上线。

# 一 · 设计篇：动手前想清楚的三件事

## 身份不存快照

发留言的时候把昵称、头像一起存下来，读的时候确实省事，但用户以后改资料怎么办？换了新头像，旧留言还在用旧的，想全改就得再更新一遍留言。我不太想维护这么多份个人资料，所以表里只留 `user_id`，读取时再 JOIN 用户表。

这样重新取数据就能拿到最新昵称、头像和站长标记。用户删了也不让留言跟着消失，LEFT JOIN 没匹配到时显示已注销，头像走兜底。每次 GET 多一次 JOIN，本站这点留言量先这么用，不为了省这一点查询，把资料同步搞复杂。

## 原始 IP 不入库

属地想显示，但没必要把原始 IP 也存进留言表，所以业务表只留江苏 南京这样的结果。服务器访问日志和第三方探测服务仍可能处理 IP，不能因此说整个系统完全不留 IP，不过至少留言数据里不用多存一份，导出留言时也少一份敏感信息。

## 楼中楼用自引用

回复关系用一列 `parent_id`，没值就是新留言，有值就指向回复目标。后端先按 id 升序全量返回，前端再组树，暂时不做分页，量少的时候这样最好理解。当然不是永远不用分页，只是先别替还没几条留言的网站操心十万楼怎么展开，真多了再改。

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

当时用一个 `messages.php` 处理读取和发送，GET 不需要登录，POST 要验 JWT。接口虽然放同一个文件里，权限不能一起放松，谁都能看，不等于谁都能写。

| 方法 | 鉴权 | 入参 | 返回 |
|------|------|------|------|
| GET | 无 | — | 全部留言（含回复） |
| POST | Bearer JWT | content、parentId、region（可选） | 新建的那条 |

## CORS 先收口

前端 `www.`、后端 `api.`，是跨源请求。这里发送 JSON 又带 Authorization，浏览器会先发 OPTIONS 预检，确认服务端允许的方法和请求头，再决定要不要发实际请求。不是所有跨源 POST 都必定预检，要看请求是否满足简单请求的条件，本站这类会触发。

下面按来源白名单设置响应头，OPTIONS 返回 204 结束，本地开发额外放 localhost。要记住 CORS 不是鉴权，不在白名单的客户端也可能直接请求服务器，POST 仍得检查 JWT，不能因为浏览器挡了跨源读取，就觉得接口谁都碰不到。

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

读取时一次查出留言和用户资料，时间在 SQL 里格式化成带 `+08:00` 的字符串。这样前端知道按哪个时区解析，不用拿着一串没标时区的日期自己猜；为什么专门处理它，后面还真有个坑。

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

站长标记直接比较配置邮箱，`SELECT` 里可以写表达式，`u.email = :admin_email` 返回比较结果，再转成布尔值。本站只有一个管理员，当时先这样做，不过邮箱修改和验证一定得可信，不能让人随便改成站长邮箱就拿到标记，更不能把这个展示标记直接当作所有管理操作的授权。

下面把数据库行整理成 JSON，顺便兜住用户不存在的情况。`??` 只处理缺失或 null，`?:` 会把空字符串等假值也兜住，两种别看着像就随便换，昵称没匹配到要显示已注销，头像为空则交给前端占位。

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

## POST：能发之前先查这些

发送先验身份，再检查内容、长度和回复目标，没通过就结束。下面保留当时的代码，JSON 类型检查、请求体大小和限流还不齐，所以开头提醒过，这不是当前完整接口，学习流程可以，别照抄到公网后就去睡觉了。

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

`parentId` 是正整数还不够，还得查目标是否存在。不然前端或脚本传个不存在的 id，数据库真存了，展示时又找不到回复谁，最后还得给自己补数据清理的活，不如入口先挡住。

```php
if ($parentId !== null) {
    $stmt = $pdo->prepare('SELECT id FROM messages WHERE id = :id LIMIT 1');
    $stmt->execute([':id' => $parentId]);
    if ($stmt->fetch() === false) {
        respond(false, '要回复的留言不存在');
    }
}
```

身份通过 JWT 拿 `user_id`，昵称、头像和邮箱则重新查用户表。token 里的资料是签发时的，过几天用户可能都换了名字，不能还拿旧值发新留言。顺便确认账号仍存在，验签过了不代表数据库里的人一定还在。

```php
$stmt = $pdo->prepare('SELECT email, nickname, avatar_url FROM users WHERE id = :id LIMIT 1');
$stmt->execute([':id' => $userId]);
$user = $stmt->fetch();
if ($user === false) {
    respond(false, '账号不存在');
}
$isAdmin = (strcasecmp((string)$user['email'], ADMIN_EMAIL) === 0) ? 1 : 0;
```

属地和设备最初有下面这个后端回退版本，后来已经移除了。现在属地由前端探测，三个 API 都失败就用未知；设备也在前端根据 `navigator.userAgent` 判断，后端做字段和白名单检查。两者都是展示信息，客户端能伪造，不能拿来做身份或安全判断，下面的旧代码只保留作对照。

```php
$region = ($clientRegion !== '' && mb_strlen($clientRegion) <= 64)
    ? $clientRegion
    : resolveRegion($_SERVER['REMOTE_ADDR'] ?? '');
$device = detectDeviceFromUA($_SERVER['HTTP_USER_AGENT'] ?? '');
```

检查通过再插入，把新留言的数据一起返回，前端就能直接加进列表。以下节选沿用当时的变量组织，独立使用时还要补完整的属地和设备赋值、异常处理等上下文，不是把几个代码块粘一起就自动成为一个接口。

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

客户端传来的昵称、邮箱和站长标记不能直接信，身份从通过验证的 token 拿，再查用户表。长度也不能只靠前端，后端用 `mb_strlen` 而不是按字节计的 `strlen`。不过 textarea 的 `maxLength` 按 UTF-16 单元算，和后端 Unicode 字符计数遇到部分 emoji 时并不完全一致，不能只因为都写着 500 就说三边严格对齐。

设备判断还得注意 Android 的 UA 也可能含 Linux，顺序要把 Android 放在前面。下面是旧 PHP 版本，后来移到了前端，同样要保持这个顺序，不然安卓用户打开网站，莫名其妙就变成了 Linux 用户。

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

当时服务器测出来是 UTC+7，代码却给 `date()` 结果直接加 `+08:00`，页面时间就差了一小时。后缀不会帮我把时钟拨快，写个北京时间不等于真的是北京时间，这个想通了倒挺简单，没查之前还在怀疑前端解析。

后来把 PHP 时区、MySQL 会话时区和输出格式都明确下来，下面分别是对应设置。它们各管各的，不能只改最后字符串的后缀，前面的实际时间还是错的。

```php
date_default_timezone_set('Asia/Shanghai');           // PHP 侧
$pdo->exec("SET time_zone = '+08:00'");               // MySQL 会话侧
DATE_FORMAT(m.created_at, "%Y-%m-%dT%H:%i:%s+08:00")  // SQL 侧直接格式化，绕开 PHP
```

MySQL 这里用偏移量，是因为有些环境没安装时区表，直接写 `Asia/Shanghai` 可能报错。本站按北京时间展示，先统一成 `+08:00`；如果以后改成 UTC 存储再转换，也得整条链一起检查，别一边转换一边又加个后缀。

## 缓存这个坑

上线还发现发完留言，刷新看不见，强刷才出来，刚开始还以为没写进数据库。后来查到请求拿的是缓存副本，接口又没明确设置缓存策略。好不容易留句话，还得教人强刷，这体验肯定不行。

当时先从两头处理，前端 fetch 用 `no-store`，明确不从 HTTP 缓存取这条数据。后来做的页面内存缓存是应用自己管理的，跟这里不是一回事，不能看见后面又加缓存就以为这段白改了。

```ts
const res = await fetch('https://api.fuhao574.cyou/messages.php', { cache: 'no-store' });
```

后端统一 JSON 响应也写上不缓存的指令，浏览器和遵守规则的中间层就知道这不是可以随便复用的静态文件。接口返回策略要说明白，别让实时数据和图片、脚本一起吃默认规则。

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

前端先定义返回数据类型，接口把数据库列名转成页面用的 camelCase。这样组树、展示和发送成功后的追加用同一套结构，不然这里叫 parentId，那边又找 parent_id，最后查半天发现只是名字没对上。

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

接口给的是一排留言，页面想显示楼中楼，就先把每条变成带 `children` 的节点，再根据 `parentId` 挂到对应留言下面。分两遍做，第一遍都放进 Map，第二遍再连接，不用赌父留言一定比回复先被遍历到，连接部分是 O(n)。

顶层留言直接放 roots，目标找不到也先放 roots，至少内容还看得到。不是说只有两遍这一种写法，只是它比较好理解，数据顺序变化时也不容易出错，下面就按这个来。

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

挂完后又递归排序，展示顺序不用完全依赖后端。这里完整实现的复杂度还要算上排序，不是从头到尾都 O(n)。正常创建流程应该限制回复只能指向已有留言，导入或手改数据时还得防环，不能出现互相回复把递归拖住的情况。

## 递归渲染 + 缩进

展示用递归组件，当前留言画完，再画自己的 children，回复分支加缩进和连接线，深一点的楼层换成虚线。下面保留的是早期样式节选，每层包裹都会累加 padding，不是写了 96px 就能保证总缩进封顶；真在窄屏用还得限制累计缩进，不然聊几层，文字就快没地方站了。

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

缩进和连接线主要交给 `ReplyBranch` 的样式处理，组件不用重复写一堆分支。这份示例说明的是按深度切样式，实际手机布局还是要单独看，桌面有空间不代表手机也有。

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

回复目标的名字从当前列表的 Map 里取，数据刷新后就跟着更新，不另存一份昵称。当然这是当前快照，不是别人改名后页面不用请求就能自动知道。回应按钮也不能只做 hover，键盘聚焦要出现，触屏设备直接常显，手机上可没有鼠标让我挪过去试。

## 换行这个坑

输入框里排好的换行，发出去全挤一起，又差点以为存储出了问题。数据库里的 `\n` 还在，是 HTML 默认折叠空白，展示时没保留。最后补一行 CSS，字还是那些字，段落总算回来了。

```css
white-space: pre-wrap;
```

这回旧数据不用改，错的是展示层，存储一直正常。以后遇到内容不对，先看接口和数据库里到底是什么，别看页面挤成一团，就急着把数据库里的留言重写一遍。

## 双态输入区

输入区按登录态显示，没登录能看，但不能直接发送，Friend 才有完整输入框。点击回复也走同一套判断，不能表面上没有输入框，楼层里的按钮却还允许绕过去提交。

- **未登录 / 访客**：虚线锁定框，文案 **登录，给这页盖个章**，按钮拉起全站复用的 LoginCard——登录组件不是留言板私有的，导航栏、个人中心用的是同一个；访客点楼层上的 **回应** 也一样，直接弹登录，不装死。
- **Friend**：完整输入区。回复状态下顶部多一条 **正在回复 某某**，可取消；500 字上限实时计数；发送中按钮禁用防连点。

下面是当时的发送函数节选，带 JWT、正文、回复目标和探测属地。它没展示后来的人机验证等参数，也没带后面更新的设备字段，所以拿来理解请求结构就好，实际要跟当前后端契约一起改。

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

成功后把接口返回的新留言追加到本地数组，再清草稿和回复目标，不整页刷新。不然留句话还得重新加载整页，刚才滚到哪又找不到了，下面就直接用返回值更新列表。

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

早期 GET 出错时先返回空数组，保证留言板失败不拖整个关于页白屏，但这种降级会把加载失败看着像没人留言，后面更合理的做法是留旧快照、显示失败和重试入口。POST 失败则保留输入内容、弹出提示，别让用户好不容易打的字跟着一次网络错误消失。

## 顺手的小设计

- 头像缺失的，用名字首字母加一片渐变色——按名字哈希从六套里选，同一人永远同色；
- 设备图标是手贴的品牌 SVG（Windows / Apple / Linux / Android），配 aria-label 供读屏；
- 时间格式 `MM.DD · HH:mm`，等宽字体，像盖章；
- 首页的 **脚印数** 直接复用这个 GET 接口数 length，一个接口两处用。

# 四 · 属地：和 VPN 斗智斗勇

属地最初想直接在后端解析 `REMOTE_ADDR`，开着代理试了一下，显示的却是代理出口。人还在国内，网站先替我出国了，这个当然不能当成真实地理位置。

当时的分流规则是国内域名直连，就改成前端请求三个国内 IP API，尽量取直连出口的属地。但不是识破了 VPN，也不能保证一定是真实位置，全局代理、服务误判或客户端修改都会影响结果，显示着玩可以，别拿来当定位证明。

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

三个请求并发，单个最多等五秒，用 `Promise.allSettled` 收集结果，一个挂了不把其他成功结果一起丢掉。注意它会等所有请求结束或超时，不是谁先回就立刻采用，下面代码是在结果里优先选中国属地，再按配置顺序取其他结果。

超时用 `AbortController` 中止请求，别让一个 API 一直挂着。`Promise.all` 遇到拒绝会提前拒绝汇总结果，但不会自动取消其他请求，跟 `allSettled` 的差别主要在结果处理，不是一个能并发、一个不能并发。

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

不同接口给的名字不一样，有的带省、市，有的返回自治区全名，所以又做了一层格式化。国外显示国家，国内尽量显示省市，直辖市去重，别最后出现上海 上海，看着像我怕别人没看清又说了一遍。

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

探测从组件挂载时开始，发送时取已经拿到的结果，不为属地额外拦住提交。请求第三方 API 也意味着对方能看到访问者的网络信息，展示属地的同时，这个隐私成本也存在，不是只在本地算了一个省市名。

早期还接过 ip2region 离线库，前端失败就让后端解析，后来连 11MB 的 xdb 和查询器一起移除了。现在三个 API 全失败就显示未知，少显示一项也比拖住留言好，下面保留旧回退代码，只是历史记录，不是仍在使用的方案。

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

最后保留的是前端探测和未知兜底，不再维护后端离线库。属地不是留言的必要条件，取不到就取不到，不能为了这几个字，把本来能发出去的留言也一起卡住。

# 尾声 · 坑与取舍

这一轮最烦的是缓存、换行和时区，没一个肯直接报错，页面能开，接口也能回，就是结果不对。以后做完不能只看控制台没红字，还得真发一条、回一条、换个设备看看，再对照实际时间。自动化测试也能覆盖其中一些，手机实测则补它看不到的那部分。

当时还有下面几处先做得比较简单，留在这里免得自己忘了。现在够用是一回事，以后量大或安全要求变了，该补还是得补，不能拿个人站当永久免修牌。

- **实时 JOIN 的代价**是每次 GET 都带一次 users 表连接，量大要重新算账，个人站够用很久；
- **全量拉取不分页**，同样是用量级换简单；
- **JWT 没有主动吊销机制**，token 泄露可能被冒用发言，不能因为是留言就当作没有风险。

开发时先开 `USE_MOCK = true`，用本地假数据调前端，等后端好了再切真实接口。至少不用一边看样式，一边猜是不是数据库没连上，问题能分开查，最后再一起验证。

到这里，当时那版留言板就能用了。本文记的是它还在关于页底下的时候，后来如果入口挪了，别在旧位置找半天，现在可以从后院进去。路过有空留句话，别让我只跟自己的测试数据聊天哈哈哈。
