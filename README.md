# 🚀 Mihomo Sub Fusion Worker

一个基于 **Cloudflare Workers** 的轻量级多机场订阅聚合与分发工具。自带现代化 Web UI 界面，支持输入**无限数量**的机场订阅链接，自动去重、拉取节点，并完美套用你定制的 Mihomo (Clash) 策略组、DNS (Fake-IP) 及分流规则。

---

## ⚠️ 警告及免责声明

> 本存储库仅提供 Mihomo 配置文件/模板，**不提供、不出售亦不代售任何形式的代理节点、VPN 或网络接入服务**。
> 
> 本存储库中README等文件中出现的以及引用的第三方订阅源或外部服务产生的任何广告内容、商业推广或跳转链接，均与本仓库及作者无关。本人不对任何第三方内容、广告的真实性或合法性做出任何形式的保证、推荐或承诺。

**本存储库所有内容禁止以任何形式转载分享至中国大陆任何平台，否则您将承担所有法律责任。**

**本资源仅供中华人民共和国全境以外且不持有中华人民共和国任何地区国籍者使用，若您符合上述任一条件，请立即退出，严禁任何形式的浏览、保存、使用或分享，否则一切法律责任及不利后果自负。**

**所有内容仅适用于合法国家或地区，本人不承担任何法律责任。**

---

## ✉️ 广告投放

请联系 http://t.me/A89899999

---

## ✨ 功能特性

* **🎨 现代化 Web UI**：通过 `/sub` 页面可视化管理和输入多个机场订阅链接，一键生成专属分发链接。
* **♾️ 无限制聚合**：支持同时聚合多家机场/订阅源，并发请求，高效稳定。
* **⚙️ 深度定制模板**：内置强大的 Mihomo 原生动态筛选（`filter`）策略组、广告拦截、Apple/Google/Telegram 等精细化分流规则。
* **☁️ 零成本部署**：基于 Cloudflare Workers 运行，全球 CDN 加速，无需自己购买和维护服务器。
* **💾 KV 持久化支持**：支持绑定 Cloudflare KV 存储，确保订阅配置长期有效。

---

## 🚀 快速部署指南

### 第一步：创建 Cloudflare Worker
1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2. 左侧导航栏进入 **Workers & Pages** -> 点击 **Create application** -> **Create Worker**。
3. 给 Worker 起个名字（例如 `mihomo-sub`），点击 **Deploy**。
4. 部署成功后，点击 **Edit code**，将仓库中的 `index.js` 代码完整复制进去，点击右上角 **Save and deploy**。

### 第二步：绑定 KV 存储（推荐，用于持久化保存订阅配置）
1. 在 Cloudflare 后台左侧点击 **Workers** -> **KV** -> **Create a namespace**（命名空间名称可随意，例如 `sub_kv`）。
2. 返回你的 Worker 设置页面：`Settings` -> `Variables` -> 找到 **KV Namespace Bindings** -> 点击 **Add binding**。
   * **Variable name** 填入：`SUB_KV`
   * **KV namespace** 选择你刚刚创建的命名空间。
3. 点击 **Save** 保存。

---

## 📖 使用说明

1. **访问 UI 配置面板**：
   打开你的 Worker 访问域名，并在路径后加上 `/subset`（例如：`https://你的域名.workers.dev/set`）。
2. **输入订阅链接**：
   在文本框中多行粘贴你的多个机场/节点订阅链接，点击 **“确认并生成专属订阅”**。
3. **导入代理软件**：
   复制生成的专属订阅链接（形如 `https://你的域名.workers.dev/sub?token=xxxx`），直接填入 Mihomo / Clash 客户端的订阅地址中即可。

---

## 🛠️ 本地开发与贡献

欢迎提交 Pull Request 或 Issues 来完善这个项目！

---

## 📄 许可证
​本项目采用 AGPL-3.0 License 开源协议。
