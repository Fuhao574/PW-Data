---
title: 五家免费静态托管实测
description: 服务器要留着安心跑后端，前端静态资源打算找个免费的新家。五家免费托管逐个实测，额度、国内速度、备案门槛一篇说清楚。
published: 2026-08-23T12:00:00
category: 记录
tags:
  - 建站
  - 静态托管
  - Cloudflare
  - Vercel
  - EdgeOne
  - Netlify
  - GitHub Pages
image: https://img.fuhao574.cyou/images/how-to-choose-SHP/how-to-choose-SHP-cover.webp
---

## 起因

最近想到一个问题：随着网站以后越来越丰富（是的，已经开始臆想了），前端资源吃掉的带宽会越来越大。而服务器就那么一台，与其让它一边跑后端、一边辛辛苦苦吐静态文件，不如把前端 **搬出去**——反正市面上免费的静态托管一大把，不用白不用嘛。白嫖不可耻，用不完的额度才是浪费。

这样一来，服务器上就能安心跑后端服务，顺便把 **前后端分离** 这件事真正做起来。

于是花了一晚上，把常见的五家免费静态托管挨个试了一遍。关注的点就三个：**免费额度给多少**、**国内访问快不快**、**有没有额外门槛**。相当于替各位把五套房都看了个遍，回来写看房报告。

## 1. Cloudflare Pages：互联网大善人

Cloudflare 的免费套餐提供域名托管、CDN 服务，以及最关键的——**不限带宽**。不限带宽是什么概念？流量随便跑，月底账单永远是 0。头一回见到把 **不限量** 写在免费套餐里的，跟掉进蜜罐里似的。

缺点是国内访问速度一般，不过可以用 **优选域名** 极大改善。如果有需要，之后可以单独写一篇优选教程。

先看未优选时的 ITDog 测速结果：

*未优选，常规路线*

![Cloudflare 未优选测速](https://img.fuhao574.cyou/images/how-to-choose-SHP/Cloudflare-Non-preferred.png)

优选之后：

*优选后，改善肉眼可见*

![Cloudflare 优选测速](https://img.fuhao574.cyou/images/how-to-choose-SHP/Cloudflare-preferred.png)

只能说，CF 被称为互联网大善人确实名副其实——免费给到这个份上，用户想夸两句都不知道从哪下嘴。

## 2. Vercel：额度清楚，域名有坑

先说限制：免费套餐每月 **100 GB 带宽** 和 **100 万次请求**（不过貌似稍微超出一点也不会把服务停掉，属于嘴上说着不行、身体很诚实），具体限制见下图。

![Vercel 免费套餐限制](https://img.fuhao574.cyou/images/how-to-choose-SHP/Vercel-Limit.png)

真正的问题出在域名：默认分配的 `vercel.app` 域名，国内大部分地区访问不了。相当于房子免费住，但门牌号国内导航搜不到——房是好房，就是没人找得着门。

*默认域名，国内大面积超时*

![Vercel 默认域名测速](https://img.fuhao574.cyou/images/how-to-choose-SHP/Vercel-Defult-Domain.png)

但是绑定自己的域名之后，访问速度就还行：

*绑定自定义域名后，恢复正常*

![Vercel 绑定自定义域名后测速](https://img.fuhao574.cyou/images/how-to-choose-SHP/Vercel-Custom-Domain.png)

所以 Vercel 的正确姿势是：免费额度照拿，域名自己带。

## 3. EdgeOne 国际版：备案玩家的加分项

EdgeOne 是腾讯家的。和 Cloudflare 一样 **不限带宽和请求数**，也提供域名托管和 CDN 服务，新用户注册还可以领取四个免费套餐：

![EdgeOne 免费套餐](https://img.fuhao574.cyou/images/how-to-choose-SHP/EdgeOne-Free-Plan.png)

由于使用国内 CDN 需要域名备案和实名认证，如果这些都已经准备好了，可以选择 EdgeOne 的国内节点，体验不错；没有备案的话，国际节点体验就一般了——房子不小，可惜钥匙（备案）不是人人都有。

*全球节点（不含中国大陆）*

![EdgeOne 全球节点不含中国大陆测速](https://img.fuhao574.cyou/images/how-to-choose-SHP/EdgeOne-Non-China.png)

*全球节点*

![EdgeOne 全球节点测速](https://img.fuhao574.cyou/images/how-to-choose-SHP/EdgeOne-Globle.png)

## 4. Netlify：国内最快，可惜改了规矩

先说优点：Netlify 在国内的延迟非常低！

再说坏消息：2025 年 9 月之后注册的账号，免费套餐改成了积分制，每月 300 credits。是的，云服务也开始搞游戏点卡了。

![Netlify 免费套餐用量](https://img.fuhao574.cyou/images/how-to-choose-SHP/Netlify-Usage.png)

来算一笔账：

| 消耗项 | 花费 |
|---|---|
| 一次生产部署 | 15 credits |
| 1 GB 带宽 | 20 credits |
| 1 万次请求 | 2 credits |

把 300 credits 全花在带宽上 ≈ **15 GB/月**；全花在生产部署上 ≈ **20 次/月**。而实际使用是混合消耗的，所以真实可用带宽会比 15 GB 还要少——点卡这种东西，从来就没让你刚好花完过。

但是！如果你是 2025 年 9 月之前注册的老账户，就能享受每月 **100 GB 带宽、300 构建分钟、125K 函数调用、1M Edge 函数调用** 的免费额度。加上 Netlify 在国内的延迟本来就很低，建站初期完全够用。所以说，注册得早也算一种理财。

附上 ITDog 的测速结果（Netlify 禁 ping，因此展示 Tcping 测速结果——不让 ping，不代表不让量，换个姿势测）：

![Netlify Tcping 测速](https://img.fuhao574.cyou/images/how-to-choose-SHP/Netlify-Tcping.png)

## 5. GitHub Pages：随缘

由于众所周知的原因，国内访问纯看运气，不推荐使用。今天能开是缘分，明天超时也是缘分。

![GitHub Pages 测速](https://img.fuhao574.cyou/images/how-to-choose-SHP/Github-Page.png)

## 汇总

| 服务商 | 免费带宽 | 免费请求 | 国内访问 | 备注 |
|---|---|---|---|---|
| Cloudflare Pages | 不限 | 不限 | 一般，优选后良好 | 域名托管 + CDN 全都有 |
| Vercel | 100 GB/月 | 100 万次/月 | 默认域名不可用，绑自定义域名后尚可 | 超一点貌似不停服 |
| EdgeOne 国际版 | 不限 | 不限 | 国际节点一般，国内节点体验不错 | 国内节点需备案 + 实名，新用户可领四个免费套餐 |
| Netlify | 老账户 100 GB/月，新账户积分制约 15 GB/月 | 计入积分 | 延迟很低 | 2025 年 9 月后注册按积分算 |
| GitHub Pages | 100 GB/月（软限制） | — | 纯看运气 | 不推荐 |

## 怎么选

- **想省心、不限量**：Cloudflare Pages + 优选，大善人的免费额度是最安心的
- **域名已备案**：EdgeOne 国内节点，速度体验直接拉满
- **有 Netlify 老账户**：趁额度还在赶紧用，国内延迟是真的低
- **流量不大、图省事**：Vercel 绑自定义域名，每月 100 GB 也够用
- **GitHub Pages**：留给运气好的朋友

至于我自己最后会选哪家，写到这里还在纠结。等定了、部署完了，再来写一篇施工实录——优选教程也一并安排上。
