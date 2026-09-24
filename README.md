# [Fuhao574 的小伙伴们](https://www.fuhao574.cyou/friends/)

> 世界那么大，能遇到交换友链的各位，是一件很棒的事情。

本仓库是 [fuhao574.cyou](https://www.fuhao574.cyou/) 友链页的数据源，`data/friends/` 下每个 JSON 文件对应一位小伙伴。

## 友链说明

如果您想和小付交换友链，请阅读以下内容。谢谢配合～

如网站链接、描述、头像等信息更换，请在此创建新的 `Pull Request`。

### 原则

- 申请的友链将经过筛选（请按格式填好哦～）。
- 原则上最好为使用 HTTPS 协议的站点，且拥有自己的独立域名。
- 已添加友链不会轻易删除。如您已移除本站链接，本站也将移除友链。
- 站点长时间无法访问，或一年以上没有任何更新，我将视情况撤下友链。

#### 内容原则

- 不存在政治敏感问题及违法内容。
- 没有过多的广告以致有碍观瞻、无恶意脚本。
- 最好是有实质性原创内容的网站。（包括但不局限于）
  - 能够帮助到别人的文章
  - 可以让别人更加了解你的生活类文章
  - 自己的业余创作分享
  - 有自己见解的喜好分享
- 至少有 5 篇原创文章（因为这样才能确定你是否有意坚持下去，并从中了解你）。
- 转载文章须注明出处。

### 格式

在 [`data/friends/`](./data/friends/) 目录下新建一个 JSON 文件（文件名建议用站点名），格式如下：

```json
{
  "name": "Fuhao574",
  "avatar": "https://avatars.githubusercontent.com/u/220566987?v=4",
  "description": "这个世界不缺大人",
  "url": "https://www.fuhao574.cyou/",
  "backlink": "https://www.fuhao574.cyou/friends/",
  "rss": "https://www.fuhao574.cyou/rss.xml"
}
```

- `name`: 怎么称呼？
- `avatar`: 头像图片链接，须使用 HTTPS（须为正方形或圆形），在保证清晰度的前提下，越小越利于迅速加载展示哦～
- `description`: 一句话描述，描述一下 `自己` 或者 `站点` 或者 `喜欢的话`？（最好不要太长，否则会被截断。）
- `url`: 站点链接，**须以 `/` 结尾**。
- `backlink`: 回链地址。
- `rss`: RSS 订阅地址（选填，填了卡片右上角会显示小图标）。
- `accent` / `order` / `snippet`: 由构建自动计算，**请不要手动填写**。

如果文本中存在特殊字符，请使用双引号包裹。

### 如何交换友链

- 在 GitHub 上 `Fork` 此仓库
- 按照以上格式在 [`data/friends/`](./data/friends/) 目录下新增一个 JSON 文件
- 完成后，新建 `Pull Request`。PR 标题须遵循 `<type>(<scope>): <subject>` 格式，emoji 可放在 subject 中自由发挥。例如新增友链使用 `feat(links): ✨ add fuhao574.cyou`，更新现有友链使用 `fix(links): 🔧 update fuhao574.cyou`。
- 或直接在[友链页](https://www.fuhao574.cyou/friends/)填写申请表单，站长看到后会尽快审核。
- `Pull Request` 被合并后，CF Pages 会自动重新构建；站点下次构建时即可拉取到最新的友链列表。
