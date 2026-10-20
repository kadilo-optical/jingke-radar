# 出 APK 的操作步骤（共 4 步）

工程已经准备好，也已经在本地提交成 Git 仓库（分支 `main`）。
你只需要把它推到 GitHub，云端会自动编译出 APK。

---

## 第 1 步：在 GitHub 建一个空仓库

1. 打开 https://github.com/new
2. **Repository name** 填：`jingke-radar`
3. **Private / Public** 都可以选（建议 **Private**，别人看不到代码）
4. **不要**勾选 "Add a README file"、"Add .gitignore"、"Choose a license"
   —— 勾了会产生冲突，推送会失败
5. 点 **Create repository**

---

## 第 2 步：上传代码（二选一）

### 方式 A：网页上传（最简单，不用装任何东西）

1. 在新仓库页面点 **uploading an existing file**
2. 把下面这些**文件和文件夹**一起拖进去：

```
index.html
public-config.js
capacitor.config.json
package.json
README.md
.gitignore
.github        （整个文件夹，里面是 workflows/build-apk.yml）
scripts        （整个文件夹，里面是 copy-www.js）
```

> ⚠️ 注意：`.github` 是隐藏文件夹，Windows 资源管理器默认不显示。
> 如果拖不进去，点「查看 → 显示 → 隐藏的项目」后再拖。
> **这一步很关键 —— 没有 `.github/workflows/build-apk.yml` 就不会自动编译。**

3. 下方 **Commit changes** 点一下

### 方式 B：命令行推送（一次搞定，含隐藏文件夹）

在本目录空白处右键 → **Open Git Bash here**，然后执行（把用户名换成你的）：

```bash
git remote add origin https://github.com/kadilo-optical/jingke-radar.git
git push -u origin main
```

如果提示要登录，用 **Personal Access Token** 当密码（GitHub 已不支持账号密码）：
右上角头像 → Settings → Developer settings → Personal access tokens → Tokens (classic)
→ Generate new token → 勾选 `repo` → 生成后复制，粘贴到密码位置。

---

## 第 3 步：等云端编译

1. 打开仓库的 **Actions** 标签页
2. 左侧点 **Build Android APK**
3. 右侧点 **Run workflow** → 再点绿色 **Run workflow** 确认
4. 等 5～8 分钟（第一次要下载 Android SDK，会久一点）

---

## 第 4 步：下载安装

1. 点进那次运行记录（有绿勾 ✅ 就成功了）
2. 页面拉到最底部 **Artifacts** 区域
3. 点 **jingke-radar-apk** 下载（是个 zip）
4. 解压得到 `app-debug.apk`
5. 传到手机 → 点击安装
   - 手机会提示"未知来源"，去 **设置 → 安全 → 允许安装未知应用** 里放出权限即可

---

## 常见问题

**Q：安装时提示"应用未安装"或"签名冲突"？**
A：手机上如果之前装过同 appId 的其他版本，先卸载旧的再装。

**Q：打开 App 白屏？**
A：先确认手机能正常上网。App 只是壳，数据全在云端，必须联网。

**Q：这个 APK 能上应用商店吗？**
A：不能。现在用的是 debug 签名，仅供团队内部安装。上架需要正式签名证书（keystore）和 release 构建，要做可以再说。

**Q：以后改了网页内容，App 会自动更新吗？**
A：不会。APK 里的网页是打包进去的。改完要重新跑一次 Actions，重新下载安装。
（如果希望"App 里永远是最新网页"，可以改成让 App 直接加载线上网址，代价是离线打不开。）

---

## 安全提醒

- 仓库里**没有**放 `已收录名单.md`，那份文件含客户名称和电话，已在 `.gitignore` 中排除。
- `public-config.js` 里的 `publishableKey` 是**公开可暴露**的前端 key，放进仓库是安全的；真正的云端权限由 RLS 和登录态控制。
