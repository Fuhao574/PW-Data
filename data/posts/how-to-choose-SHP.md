---
title: 五家免费静态托管实测
description: 想把前端从服务器搬出去，就试了五家免费静态托管。记录当时的额度、测速和域名门槛，顺便看看哪家适合我这个小站。
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

最近在想，要不要把前端从服务器搬出去。现在网站没什么流量，但以后图片、页面多起来，静态资源也要占带宽，服务器还得跑 PHP，不如给它少安排点活。正好免费静态托管不少，先看看有没有适合的，能省一点是一点嘛。

于是花了一晚上试了五家，主要看免费额度、国内访问和额外门槛。下面保留的是写这篇时的套餐信息和 ITDog 截图，不是实时排行榜。套餐会改，网络也会变，我这里能打开，不代表你的运营商也一样，真选的时候还是拿自己的域名测一下。

## 1. Cloudflare Pages：互联网大善人

Cloudflare Pages 最吸引我的还是静态资源的免费带宽，搭小站不用一直惦记还剩多少额度。这里说的是静态托管，不是所有 Cloudflare 产品都无限免费，Functions 之类的限制要另外看，使用规则也得遵守，不能理解成什么流量都能往里塞。

国内默认线路的表现就比较一般了。我当时又试了优选配置，结果放在下面：第一张没优选，第二张是优选之后，改善挺明显。不过这只是当时那轮测试，优选也不是做一次就能保证以后都快。

![Cloudflare 未优选测速](https://img.fuhao574.cyou/images/how-to-choose-SHP/Cloudflare-Non-preferred.webp)


![Cloudflare 优选测速](https://img.fuhao574.cyou/images/how-to-choose-SHP/Cloudflare-preferred.webp)

免费给到这个程度，确实挺香，难怪大家叫它互联网大善人。优选怎么做以后有机会再单独写，这篇先不展开，不然选托管写着写着又变成网络配置教程了。

## 2. Vercel：额度清楚，域名有坑

我当时看到的免费额度是每月 **100 GB 带宽** 和 **100 万次请求**，具体见截图。超额怎么处理还是以当前后台和套餐规则为准，不建议拿别人没停服的经历当保证，我也不想为了验证这件事故意把额度跑满。

![Vercel 免费套餐限制](https://img.fuhao574.cyou/images/how-to-choose-SHP/Vercel-Limit.webp)

比较麻烦的是默认的 `vercel.app` 域名，下面那轮测试里很多国内节点都超时。部署成功了，别人却打不开，那不是白忙了。先看默认域名的结果，再看绑定自己域名之后的对比。

![Vercel 默认域名测速](https://img.fuhao574.cyou/images/how-to-choose-SHP/Vercel-Defult-Domain.webp)


![Vercel 绑定自定义域名后测速](https://img.fuhao574.cyou/images/how-to-choose-SHP/Vercel-Custom-Domain.webp)

绑定自己的域名之后，这轮结果就好不少。所以我会把自定义域名当作使用 Vercel 时要一起准备的东西，而不是只看见部署成功就收工。至于换个地区是不是也这么顺，还得自己试。

## 3. EdgeOne 国际版：备案玩家的加分项

EdgeOne 是腾讯家的，我当时看到的国际版免费套餐也标着不限带宽和请求数，新用户还能领取四个免费套餐，截图留在这里。免费资格、套餐数量和具体适用范围可能变，注册时看当前页面，别拿这张旧图去跟后台较劲。

![EdgeOne 免费套餐](https://img.fuhao574.cyou/images/how-to-choose-SHP/EdgeOne-Free-Plan.webp)

这一家要特别注意节点范围。国内节点涉及备案、实名认证和具体产品资格，不是领了国际版套餐，就自动能用国内 CDN。下面分别是全球节点不含中国大陆，以及全球节点的测试图；我当时测下来，含国内节点的表现更好，不过前提条件也得先满足。

![EdgeOne 全球节点不含中国大陆测速](https://img.fuhao574.cyou/images/how-to-choose-SHP/EdgeOne-Non-China.webp)


![EdgeOne 全球节点测速](https://img.fuhao574.cyou/images/how-to-choose-SHP/EdgeOne-Globle.webp)

## 4. Netlify：这轮挺快，额度得算一算

Netlify 在这轮测试里延迟挺低，本来都想直接选了，再一看套餐，又得算账。当时查到的是 2025 年 9 月之后注册的免费账号按积分计费，每月 300 credits，部署、带宽和请求一起花这份额度，不是每项都单独送 300。

![Netlify 免费套餐用量](https://img.fuhao574.cyou/images/how-to-choose-SHP/Netlify-Usage.webp)

按当时页面列的消耗算一下，下面三项都从同一份积分里扣。对经常改网站的人来说，生产部署这项也不能忽略，我这种改点颜色都想部署一次的，很容易把它忘掉。

| 消耗项 | 花费 |
|---|---|
| 一次生产部署 | 15 credits |
| 1 GB 带宽 | 20 credits |
| 1 万次请求 | 2 credits |

300 credits 全拿来买带宽，大约是 **15 GB/月**；全拿来生产部署，大约 **20 次/月**，这两项不能同时拿满，实际还得留请求额度。老账号当时可能保留旧套餐，能看到每月 **100 GB 带宽、300 构建分钟、125K 函数调用、1M Edge 函数调用**，但得看自己的账户到底是什么方案，不能只凭注册日期就确定。

测速结果也放在下面，这里用的是 Tcping。这轮 Ping 没拿到可用结果，就换了测法，不能因此断定整个平台都禁止 Ping，反正我要看的是能不能连上、延迟大概怎样，不是一定得用同一种按钮测。

![Netlify Tcping 测速](https://img.fuhao574.cyou/images/how-to-choose-SHP/Netlify-Tcping.webp)

## 5. GitHub Pages：随缘

GitHub Pages 这轮的国内访问不太稳定，有些节点能开，有些超时。对主要面向国内访问的小站，我暂时不打算选它。不是说不能用，只是代码已经要折腾了，打开网站还得碰运气，我想给自己少留一点事。

![GitHub Pages 测速](https://img.fuhao574.cyou/images/how-to-choose-SHP/Github-Page.webp)

## 汇总

| 服务商 | 免费带宽 | 免费请求 | 国内访问 | 备注 |
|---|---|---|---|---|
| Cloudflare Pages | 不限 | 不限 | 一般，优选后良好 | 域名托管 + CDN 全都有 |
| Vercel | 100 GB/月 | 100 万次/月 | 本轮默认域名多处超时，自定义域名较好 | 超额处理看当前规则 |
| EdgeOne 国际版 | 不限 | 不限 | 国际节点一般，国内节点体验不错 | 国内节点需备案 + 实名，新用户可领四个免费套餐 |
| Netlify | 旧套餐 100 GB/月，积分制纯带宽约 15 GB/月 | 计入积分 | 本轮延迟较低 | 以账户实际套餐为准 |
| GitHub Pages | 100 GB/月（软限制） | — | 纯看运气 | 不推荐 |

## 我会怎么选

额度优先的话，我会先看 Cloudflare Pages，再测试自己的域名和网络。如果备案、实名和产品资格都准备好了，也可以试 EdgeOne 国内节点；有 Netlify 旧套餐的，先看看后台剩多少额度，别急着搬家。流量不大又想图省事，Vercel 配自己的域名也值得试，GitHub Pages 就暂时不在我的首选里了。

至于我最后选哪家，写到这里还没完全定。先把这轮结果记下来，等部署完再写过程。反正免费归免费，能不能让访客顺利打开更重要，不想省下服务器带宽，又多出一堆打不开的反馈。
