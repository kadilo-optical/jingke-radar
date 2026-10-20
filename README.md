# 镜客雷达 · 眼镜贸易商精准拓客工作台

按区域检索「云端眼镜贸易商」线索，云端共享线索库，AI 自动打分并生成开发话术。

## 在线使用（免安装）

**https://glasses-radar.app.workbuddy.host/?sharecode=ABA2SVUO5X**

手机浏览器打开 → 菜单「添加到主屏幕」即可像 App 一样全屏使用。

## 功能

- 线索库增删改查（手机号可手动补录，填了就能一键拨号）
- AI 合格度打分：按「经营模式 / 品类边界 / 体量门槛」三项硬标准判定，输出 A/B/C 分级与切入角度
- AI 开发话术：电话开场、陌拜破冰、微信首句、异议应对
- 跟进记录与下次提醒
- 看板：状态分布、区域分布
- 数据存云端，团队共享同一份线索库

## 打安卓 APK

本仓库已配好 GitHub Actions 云端编译，**不需要本地安装 Android SDK**。

1. Fork 或新建仓库并把本目录推上去
2. 进入仓库 **Actions** → 左侧 **Build Android APK** → **Run workflow**
3. 约 5–8 分钟后，在该次运行页面底部 **Artifacts** 下载 `jingke-radar-apk`
4. 解压得到 `app-debug.apk`，传到手机点击安装（可能需在系统设置里允许「安装未知来源应用」）

> 当前构建的是 **debug 签名** APK，适合自己团队内部分发。如需上架应用商店，需要再做正式签名（keystore）与 release 构建。

## 目录说明

| 文件 | 作用 |
|---|---|
| `index.html` | 整个 App（单文件，无构建步骤） |
| `public-config.js` | 云端公开配置（不含长期密钥，可置于前端） |
| `capacitor.config.json` | 安卓壳配置（appId / 应用名 / webDir） |
| `scripts/copy-www.js` | 把运行所需文件同步到 `www/` |
| `.github/workflows/build-apk.yml` | 云端 APK 编译流水线 |
| `已收录名单.md` | 线索去重台账（本地留存，不进仓库） |

## 合规说明

仅使用公域公开信息检索；联系电话查不到就留空，不做编造；线索仅用于合法商务拓客。
