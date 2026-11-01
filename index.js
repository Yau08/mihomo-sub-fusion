export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. UI 界面路由 (仅允许通过 /set 访问)
    if (path === "/set") {
      return new Response(getHTMLTemplate(url.origin), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // 2. 保存订阅配置 API
    if (path === "/api/save" && request.method === "POST") {
      try {
        if (!env.SUB_KV) {
          return new Response(JSON.stringify({ success: false, error: "服务器未绑定 SUB_KV 存储空间，请先在 Cloudflare 后台配置 KV 绑定" }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        const body = await request.json();
        const links = body.links; // 换行分隔的多个订阅链接
        if (!links) {
          return new Response(JSON.stringify({ success: false, error: "订阅链接不能为空" }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        const token = generateToken();
        await env.SUB_KV.put(token, links, { expirationTtl: 31536000 }); // 保存一年

        return new Response(JSON.stringify({ success: true, token, url: `${url.origin}/sub?token=${token}` }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // 3. 生成最终 Mihomo 订阅路由
    if (path === "/sub") {
      const token = url.searchParams.get("token");
      let linksText = "";

      if (env.SUB_KV && token) {
        linksText = await env.SUB_KV.get(token);
      }

      if (!linksText) {
        linksText = url.searchParams.get("links") || "";
      }

      if (!linksText) {
        return new Response("Error: Configuration not found or links are empty. Please configure via /set", { status: 400 });
      }

      const subscriptionUrls = linksText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

      try {
        // 并发请求所有机场订阅
        const fetchPromises = subscriptionUrls.map(async (subUrl) => {
          try {
            const res = await fetch(subUrl, {
              headers: { 'User-Agent': 'ClashMeta/1.16.0' }
            });
            if (!res.ok) return null;
            let text = await res.text();

            // 自动检测并解码 Base64 订阅内容
            text = decodeSubscriptionContent(text);
            return text;
          } catch (err) {
            return null;
          }
        });

        const rawResults = await Promise.all(fetchPromises);

        let allProxiesText = "";
        let rawProxyNames = [];
        let airportIdx = 0;

        for (const raw of rawResults) {
          if (!raw) continue;

          try {
            const parsed = extractProxyNodes(raw);
            if (!parsed || parsed.nodes.length === 0) {
              console.error("Parse error: proxies module or nodes not found");
              continue;
            }

            const currentAirportIdx = airportIdx + 1;
            const airportNodes = [];
            const airportNames = [];
            const nameCounts = new Map();
            let airportValid = true;

            // 独立识别并处理每一个节点
            for (const node of parsed.nodes) {
              const result = renameProxyNode(node, currentAirportIdx);

              if (!result || !result.name) {
                airportValid = false;
                console.error("Parse error: proxy name not found");
                break;
              }

              // 防止同一机场内出现重复节点名称
              let uniqueName = result.name;
              const count = (nameCounts.get(uniqueName) || 0) + 1;
              nameCounts.set(uniqueName, count);

              if (count > 1) {
                uniqueName = `${uniqueName} (${count})`;
                result.text = replaceProxyName(result.text, uniqueName);
              }

              airportNames.push(uniqueName);
              airportNodes.push(normalizeProxyIndent(result.text, parsed.listIndent));
            }

            // 只有整个机场的节点均成功识别，才纳入最终配置
            if (!airportValid || airportNodes.length !== parsed.nodes.length) {
              console.error(`Airport ${currentAirportIdx} parse validation failed`);
              continue;
            }

            airportIdx++;
            allProxiesText += "\n" + airportNodes.join("\n");
            rawProxyNames.push(...airportNames);

          } catch (e) {
            console.error("Parse error", e);
          }
        }

        // 去重节点名称
        const uniqueNames = Array.from(new Set(rawProxyNames));

        // 🛡️ 核心防线：如果机场订阅整体崩掉导致拉不到任何节点，直接返回 500 错误
        if (uniqueNames.length === 0) {
          return new Response("Error: Failed to fetch or parse proxies from subscription links", { status: 500 });
        }

        const uniqueProxyNames = uniqueNames.map(n => `      - "${n.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join('\n');

        const getGroupProxies = (regex) => {
          const matched = uniqueNames.filter(n => regex.test(n));
          if (matched.length > 0) {
            return matched.map(n => `      - "${n.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join('\n');
          } else {
            return `      - "🏴‍☠️ ＤＩＲＥＣＴ"`;
          }
        };

        const rocProxies = getGroupProxies(/台湾|TW|tw|Taiwan|ROC|台灣|臺灣|湾|灣|中華|中華|民国|民國|中华民国|中華民國|🇹🇼/i);
        const hkgProxies = getGroupProxies(/香港|HK|hk|Hong Kong|Hong|HONG|港|🇭🇰/i);
        const jpnProxies = getGroupProxies(/日本|JP|Japan|日|🇯🇵/i);
        const korProxies = getGroupProxies(/韩国|KR|Korea|韩|韓|🇰🇷/i);
        const sgpProxies = getGroupProxies(/新加坡|SG|Singapore|新|坡|狮|獅|🇸🇬/i);
        const usaProxies = getGroupProxies(/美国|US|USA|United States|United|UNITED|States|America|美|米|🇺🇸/i);

        // 拼装完整的 Mihomo 配置模板
        const finalConfig = `Mixed-port: 7890
allow-lan: true
bind-address: "*"
mode: rule
ipv6: true
log-level: warning
external-controller: 127.0.0.1:9090

# 添加直连节点
proxies:
  - name: "🏴‍☠️ ＤＩＲＥＣＴ"
    type: direct
    udp: true
${allProxiesText}

# 策略组配置
proxy-groups:
  - name: "SELECT"
    type: select
    proxies:
      - "🇺🇳 ALL"
      - "🏴‍☠️ ＤＩＲＥＣＴ"
      - "🇹🇼 ROC"
      - "🇭🇰 HKG"
      - "🇯🇵 JPN"
      - "🇰🇷 KOR"
      - "🇸🇬 SGP"
      - "🇺🇸 USA"

  - name: "🇺🇳 ALL"
    type: select
    proxies:
${uniqueProxyNames}

  - name: "🇹🇼 ROC"
    type: url-test
    url: "http://www.gstatic.com/generate_204"
    interval: 900
    tolerance: 150
    proxies:
${rocProxies}

  - name: "🇭🇰 HKG"
    type: url-test
    url: "http://www.gstatic.com/generate_204"
    interval: 900
    tolerance: 150
    proxies:
${hkgProxies}

  - name: "🇯🇵 JPN"
    type: url-test
    url: "http://www.gstatic.com/generate_204"
    interval: 900
    tolerance: 150
    proxies:
${jpnProxies}

  - name: "🇰🇷 KOR"
    type: url-test
    url: "http://www.gstatic.com/generate_204"
    interval: 900
    tolerance: 150
    proxies:
${korProxies}

  - name: "🇸🇬 SGP"
    type: url-test
    url: "http://www.gstatic.com/generate_204"
    interval: 900
    tolerance: 150
    proxies:
${sgpProxies}

  - name: "🇺🇸 USA"
    type: url-test
    url: "http://www.gstatic.com/generate_204"
    interval: 900
    tolerance: 150
    proxies:
${usaProxies}

# DNS 配置
dns:
  enable: true
  listen: "0.0.0.0:10053"
  enhanced-mode: "fake-ip"
  fake-ip-range: "198.18.0.1/16"
  use-hosts: true
  respect-rules: true
  fake-ip-filter:
    - "*.lan"
    - "*.local"
    - "*.localhost"
    - "*.home.arpa"
    - "*.internal"
    - "tplogin.cn"
    - "melogin.cn"
    - "falogin.cn"
    - "miwifi.com"
    - "mi.wifi"
    - "router.asus.com"
    - "router.ctc"
    - "localhost.ptlogin2.qq.com"
    - "localhost.sec.qq.com"
    - "localhost.work.weixin.qq.com"
    - "*.dingtalk.com"
    - "*.work.weixin.qq.com"
    - "*.cmccsign.com"
    - "*.139.com"
    - "*.10086.cn"
    - "*.111.com"
    - "*.88.com"
    - "*.mail.cn"
    - "time.windows.com"
    - "time.apple.com"
    - "time.nist.gov"
    - "time.ncl.edu.tw"
    - "pool.ntp.org"
    - "*.ntp.org"
    - "time.*.com"
    - "time.*.gov"
    - "time.*.edu.cn"
    - "time.*.apple.com"
    - "*.msftconnecttest.com"
    - "*.msftncsi.com"
    - "dns.msftncsi.com"
    - "captive.apple.com"
    - "stun.l.google.com"
    - "*.xboxlive.com"
    - "*.battlenet.com.cn"
    - "*.blizzard.cn"
    - "*.pvp.net"
    - "*.moba.qq.com"
    - "*.stun.*.*"
    - "*.stun.*.*.*"
    - "*.stun.*.*.*.*"
    - "*.synology.com"
    - "*.myqnapcloud.com"
    - "_tcp.*"
    - "_udp.*"
    - "_services._dns-sd._udp.*"
  default-nameserver:
    - "119.29.29.29"
    - "223.5.5.5"
  proxy-server-nameserver:
    - "https://doh.pub/dns-query"
    - "https://doh.baidu.com/dns-query"
  nameserver:
    - "https://dns.google/dns-query"
    - "https://cloudflare-dns.com/dns-query"
  nameserver-policy:
    "geosite:cn":
      - "119.29.29.29"
      - "223.5.5.5"
    "*.cn":
      - "119.29.29.29"
      - "223.5.5.5"
  fallback:
    - "8.8.8.8"
    - "1.1.1.1"
  fallback-filter:
    geoip: true
    geoip-code: "CN"
    geosite:
      - "gfw"
      - "greatfire"
    ipcidr:
      - "0.0.0.0/8"
      - "10.0.0.0/8"
      - "100.64.0.0/10"
      - "127.0.0.0/8"
      - "169.254.0.0/16"
      - "172.16.0.0/12"
      - "192.168.0.0/16"
      - "198.18.0.0/15"
      - "224.0.0.0/4"
      - "240.0.0.0/4"
    domain:
      - "+.google.com"
      - "+.facebook.com"
      - "+.youtube.com"

# 规则配置
rules:
  - "IP-CIDR,0.0.0.0/8,DIRECT,no-resolve"
  - "IP-CIDR,10.0.0.0/8,DIRECT,no-resolve"
  - "IP-CIDR,100.64.0.0/10,DIRECT,no-resolve"
  - "IP-CIDR,127.0.0.0/8,DIRECT,no-resolve"
  - "IP-CIDR,169.254.0.0/16,DIRECT,no-resolve"
  - "IP-CIDR,172.16.0.0/12,DIRECT,no-resolve"
  - "IP-CIDR,192.168.0.0/16,DIRECT,no-resolve"
  - "IP-CIDR,198.18.0.0/15,DIRECT,no-resolve"
  - "IP-CIDR,224.0.0.0/4,DIRECT,no-resolve"
  - "IP-CIDR,240.0.0.0/4,DIRECT,no-resolve"
  - "DST-PORT,123,DIRECT"
  - "DOMAIN-SUFFIX,lan,DIRECT"
  - "DOMAIN-SUFFIX,local,DIRECT"
  - "DOMAIN-SUFFIX,localhost,DIRECT"
  - "DOMAIN-SUFFIX,home.arpa,DIRECT"
  - "DOMAIN-SUFFIX,internal,DIRECT"
  - "DOMAIN,tplogin.cn,DIRECT"
  - "DOMAIN,melogin.cn,DIRECT"
  - "DOMAIN,falogin.cn,DIRECT"
  - "DOMAIN,miwifi.com,DIRECT"
  - "DOMAIN,mi.wifi,DIRECT"
  - "DOMAIN,router.asus.com,DIRECT"
  - "DOMAIN,router.ctc,DIRECT"
  - "DOMAIN,localhost.ptlogin2.qq.com,DIRECT"
  - "DOMAIN,localhost.sec.qq.com,DIRECT"
  - "DOMAIN,localhost.work.weixin.qq.com,DIRECT"
  - "DOMAIN-SUFFIX,dingtalk.com,DIRECT"
  - "DOMAIN-SUFFIX,work.weixin.qq.com,DIRECT"
  - "DOMAIN-SUFFIX,cmccsign.com,DIRECT"
  - "DOMAIN-SUFFIX,139.com,DIRECT"
  - "DOMAIN-SUFFIX,10086.cn,DIRECT"
  - "DOMAIN-SUFFIX,111.com,DIRECT"
  - "DOMAIN-SUFFIX,88.com,DIRECT"
  - "DOMAIN-SUFFIX,mail.cn,DIRECT"
  - "DOMAIN,time.windows.com,DIRECT"
  - "DOMAIN,time.apple.com,DIRECT"
  - "DOMAIN,time.nist.gov,DIRECT"
  - "DOMAIN,time.ncl.edu.tw,DIRECT"
  - "DOMAIN,pool.ntp.org,DIRECT"
  - "DOMAIN-SUFFIX,ntp.org,DIRECT"
  - "DOMAIN-KEYWORD,time.,DIRECT"
  - "DOMAIN-SUFFIX,msftconnecttest.com,DIRECT"
  - "DOMAIN-SUFFIX,msftncsi.com,DIRECT"
  - "DOMAIN,dns.msftncsi.com,DIRECT"
  - "DOMAIN,captive.apple.com,DIRECT"
  - "DOMAIN,stun.l.google.com,DIRECT"
  - "DOMAIN-SUFFIX,xboxlive.com,DIRECT"
  - "DOMAIN-SUFFIX,battlenet.com.cn,DIRECT"
  - "DOMAIN-SUFFIX,blizzard.cn,DIRECT"
  - "DOMAIN-SUFFIX,pvp.net,DIRECT"
  - "DOMAIN-SUFFIX,moba.qq.com,DIRECT"
  - "DOMAIN-KEYWORD,stun,DIRECT"
  - "DOMAIN-SUFFIX,synology.com,DIRECT"
  - "DOMAIN-SUFFIX,myqnapcloud.com,DIRECT"
  - "DOMAIN-KEYWORD,_tcp,DIRECT"
  - "DOMAIN-KEYWORD,_udp,DIRECT"
  - "DOMAIN-KEYWORD,_services._dns-sd._udp,DIRECT"
  - "DOMAIN-SUFFIX,admob.com,REJECT"
  - "GEOSITE,category-ads-all,REJECT"
  - "DOMAIN-SUFFIX,doubleclick.net,REJECT"
  - "DOMAIN-SUFFIX,googlesyndication.com,REJECT"
  - "DOMAIN-SUFFIX,e.qq.com,REJECT"
  - "DOMAIN-SUFFIX,gdt.qq.com,REJECT"
  - "DOMAIN-SUFFIX,pangolin-sdk-toutiao.com,REJECT"
  - "DOMAIN-SUFFIX,alimama.com,REJECT"
  - "DOMAIN-SUFFIX,umeng.com,REJECT"
  - "DOMAIN-SUFFIX,cnzz.com,REJECT"
  - "DOMAIN-SUFFIX,union.baidu.com,REJECT"
  - "DOMAIN-SUFFIX,e.kuaishou.com,REJECT"
  - "DOMAIN-SUFFIX,apple.com.cn,DIRECT"
  - "DOMAIN-KEYWORD,cn.apple.com,DIRECT"
  - "DOMAIN-SUFFIX,g.cn,SELECT"
  - "DOMAIN-SUFFIX,google.cn,SELECT"
  - "DOMAIN-KEYWORD,google,SELECT"
  - "DOMAIN-SUFFIX,google.com,SELECT"
  - "DOMAIN-SUFFIX,youtu.be,SELECT"
  - "DOMAIN-KEYWORD,googleplay,SELECT"
  - "DOMAIN-KEYWORD,googleapis,SELECT"
  - "DOMAIN-KEYWORD,gmail,SELECT"
  - "DOMAIN-KEYWORD,youtube,SELECT"
  - "DOMAIN-KEYWORD,googlevideo,SELECT"
  - "DOMAIN-SUFFIX,apple.com,SELECT"
  - "DOMAIN-KEYWORD,apple,SELECT"
  - "DOMAIN-KEYWORD,icloud,SELECT"
  - "DOMAIN-KEYWORD,itunes,SELECT"
  - "DOMAIN-SUFFIX,microsoft.com,SELECT"
  - "DOMAIN-SUFFIX,live.com,SELECT"
  - "DOMAIN-SUFFIX,x.com,SELECT"
  - "DOMAIN-SUFFIX,steampowered.com,SELECT"
  - "DOMAIN-SUFFIX,s.team,SELECT"
  - "DOMAIN-KEYWORD,steam,SELECT"
  - "DOMAIN-SUFFIX,github.com,SELECT"
  - "DOMAIN-SUFFIX,githubusercontent.com,SELECT"
  - "DOMAIN-SUFFIX,t.me,SELECT"
  - "DOMAIN-KEYWORD,telegram,SELECT"
  - "DOMAIN-KEYWORD,openai,SELECT"
  - "DOMAIN-SUFFIX,qzz.io,SELECT"
  - "DOMAIN-KEYWORD,gaijin,DIRECT"
  - "DOMAIN-SUFFIX,gaijin.net,DIRECT"
  - "GEOIP,CN,DIRECT"
  - "GEOSITE,CN,DIRECT"
  - "DOMAIN-SUFFIX,cn,SELECT"
  - "DOMAIN-KEYWORD,com.cn,DIRECT"
  - "DOMAIN-SUFFIX,qq.com,DIRECT"
  - "DOMAIN-KEYWORD,tencent,DIRECT"
  - "DOMAIN-KEYWORD,ali,DIRECT"
  - "DOMAIN-SUFFIX,7723.com,DIRECT"
  - "DOMAIN-SUFFIX,4399.com,DIRECT"
  - "MATCH,SELECT"`;

        const cleanConfig = finalConfig;
        return new Response(cleanConfig, {
          headers: { "Content-Type": "text/yaml; charset=utf-8" },
        });

      } catch (err) {
        return new Response("Error generating config: " + err.message, { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};

function generateToken() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

function decodeSubscriptionContent(text) {
  text = text.trim();
  if (!text.includes("proxies:")) {
    try {
      const decoded = atob(text);
      if (decoded.includes("proxies:")) {
        return decoded;
      }
    } catch (e) {
      // 并非 Base64，忽略
    }
  }
  return text;
}

// 提取 proxies 模块中的独立节点，兼容不同缩进和节点表达格式
function extractProxyNodes(raw) {
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  let proxiesIndex = -1;
  let proxiesIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const match = /^([ \t]*)proxies\s*:\s*(?:#.*)?$/i.exec(lines[i]);
    if (match) {
      proxiesIndex = i;
      proxiesIndent = match[1].replace(/\t/g, "    ").length;
      break;
    }
  }

  if (proxiesIndex === -1) return null;

  const nodes = [];
  let listIndent = -1;
  let currentNode = [];

  const getIndent = (line) => {
    const match = /^[ \t]*/.exec(line);
    return match ? match[0].replace(/\t/g, "    ").length : 0;
  };

  const isSequenceItem = (line) => {
    return /^[ \t]*-\s*(?:$|\S)/.test(line);
  };

  const flushNode = () => {
    const content = currentNode.join('\n').trim();
    if (content) nodes.push(content);
    currentNode = [];
  };

  for (let i = proxiesIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      if (currentNode.length > 0) currentNode.push(line);
      continue;
    }

    const indent = getIndent(line);

    // 遇到下一个同级或更高级的配置项，结束 proxies 模块
    if (indent <= proxiesIndent && /^[^#\s][^:]*\s*:/.test(line)) {
      break;
    }

    if (isSequenceItem(line)) {
      if (listIndent === -1) {
        listIndent = indent;
      } else if (indent === listIndent) {
        flushNode();
      } else if (indent < listIndent) {
        break;
      }
    }

    if (listIndent !== -1) {
      currentNode.push(line);
    }
  }

  flushNode();

  if (nodes.length === 0 || listIndent === -1) return null;

  return { nodes, listIndent };
}

// 识别并修改单个节点的 name 字段
function renameProxyNode(nodeText, airportIdx) {
  const nameRegex = /^[ \t]*(?:-[ \t]*)?(?:"name"|'name'|name)\s*:\s*|[,{][ \t]*(?:"name"|'name'|name)\s*:\s*/gm;
  const match = nameRegex.exec(nodeText);

  if (!match) return null;

  const valueStart = match.index + match[0].length;
  const quote = nodeText[valueStart];

  let valueEnd = valueStart;
  let rawName = "";

  // 双引号名称
  if (quote === '"') {
    valueEnd = valueStart + 1;
    let escaped = false;

    while (valueEnd < nodeText.length) {
      const char = nodeText[valueEnd];

      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        break;
      }

      valueEnd++;
    }

    if (valueEnd >= nodeText.length) return null;

    const rawValue = nodeText.slice(valueStart, valueEnd + 1);

    try {
      rawName = JSON.parse(rawValue);
    } catch (e) {
      rawName = nodeText.slice(valueStart + 1, valueEnd);
    }

    valueEnd++;
  }
  // 单引号名称
  else if (quote === "'") {
    valueEnd = valueStart + 1;

    while (valueEnd < nodeText.length) {
      if (nodeText[valueEnd] === "'") {
        if (nodeText[valueEnd + 1] === "'") {
          valueEnd += 2;
          continue;
        }
        break;
      }
      valueEnd++;
    }

    if (valueEnd >= nodeText.length) return null;

    rawName = nodeText.slice(valueStart + 1, valueEnd).replace(/''/g, "'");
    valueEnd++;
  }
  // 无引号名称
  else {
    valueEnd = valueStart;

    while (
      valueEnd < nodeText.length &&
      nodeText[valueEnd] !== '\n' &&
      nodeText[valueEnd] !== '\r' &&
      nodeText[valueEnd] !== ',' &&
      nodeText[valueEnd] !== '}'
    ) {
      valueEnd++;
    }

    rawName = nodeText.slice(valueStart, valueEnd).trim();
  }

  rawName = String(rawName).trim();
  if (!rawName) return null;

  const uniqueName = `[${airportIdx}] ${rawName}`;
  const escapedName = uniqueName
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');

  const modifiedText =
    nodeText.slice(0, valueStart) +
    `"${escapedName}"` +
    nodeText.slice(valueEnd);

  return {
    name: uniqueName,
    text: modifiedText
  };
}

// 替换已识别节点的名称
function replaceProxyName(nodeText, newName) {
  const nameRegex = /^[ \t]*(?:-[ \t]*)?(?:"name"|'name'|name)\s*:\s*|[,{][ \t]*(?:"name"|'name'|name)\s*:\s*/gm;
  const match = nameRegex.exec(nodeText);

  if (!match) return nodeText;

  const valueStart = match.index + match[0].length;
  const quote = nodeText[valueStart];

  let valueEnd = valueStart;

  if (quote === '"') {
    valueEnd = valueStart + 1;
    let escaped = false;

    while (valueEnd < nodeText.length) {
      const char = nodeText[valueEnd];

      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        break;
      }

      valueEnd++;
    }

    if (valueEnd >= nodeText.length) return nodeText;
    valueEnd++;
  } else if (quote === "'") {
    valueEnd = valueStart + 1;

    while (valueEnd < nodeText.length) {
      if (nodeText[valueEnd] === "'") {
        if (nodeText[valueEnd + 1] === "'") {
          valueEnd += 2;
          continue;
        }
        break;
      }
      valueEnd++;
    }

    if (valueEnd >= nodeText.length) return nodeText;
    valueEnd++;
  } else {
    while (
      valueEnd < nodeText.length &&
      nodeText[valueEnd] !== '\n' &&
      nodeText[valueEnd] !== '\r' &&
      nodeText[valueEnd] !== ',' &&
      nodeText[valueEnd] !== '}'
    ) {
      valueEnd++;
    }
  }

  const escapedName = newName
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');

  return nodeText.slice(0, valueStart) +
    `"${escapedName}"` +
    nodeText.slice(valueEnd);
}

// 统一节点缩进，同时保留节点内部嵌套结构
function normalizeProxyIndent(nodeText, listIndent) {
  const lines = nodeText.split('\n');

  return lines.map(line => {
    if (line.trim() === '') return '';

    const match = /^[ \t]*/.exec(line);
    const originalIndent = match ? match[0].length : 0;

    const visualIndent = match
      ? match[0].replace(/\t/g, "    ").length
      : 0;

    const remainingIndent = Math.max(0, visualIndent - listIndent);

    return "  " + " ".repeat(remainingIndent) + line.slice(originalIndent);
  }).join('\n');
}

function getHTMLTemplate(origin) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Mihomo订阅聚合分发控制台</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center p-4">
    <div class="max-w-xl w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
        <h1 class="text-2xl font-bold mb-2 text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-indigo-500">Mihomo 订阅聚合管理器</h1>
        <p class="text-slate-400 text-sm mb-6">输入多个机场订阅链接（每行一个），系统将自动去重、拉取节点并套用定制分流模板。</p>

        <div class="mb-4">
            <label class="block text-sm font-medium text-slate-300 mb-2">机场订阅链接（多行）</label>
            <textarea id="linksInput" rows="6" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm focus:outline-none focus:border-blue-500 text-slate-200 placeholder-slate-600" placeholder="https://example.com/api/v1/client/subscribe?token=xxx&#10;https://another-airport.com/link?token=yyy"></textarea>
        </div>

        <button onclick="saveConfig()" id="submitBtn" class="w-full bg-blue-600 hover:bg-blue-500 transition font-medium py-3 rounded-xl shadow-lg shadow-blue-600/20 text-white">
            确认并生成专属订阅
        </button>

        <div id="resultBox" class="mt-6 hidden">
            <label class="block text-sm font-medium text-slate-300 mb-2">您的代理软件专属订阅链接</label>
            <div class="flex gap-2">
                <input type="text" id="subUrlOutput" readonly class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 text-xs text-blue-400 select-all">
                <button onclick="copyUrl()" class="bg-slate-800 hover:bg-slate-700 px-4 py-2 rounded-xl text-xs font-medium shrink-0">复制</button>
            </div>
            <p class="text-xs text-slate-500 mt-2">提示：可直接将上方生成的链接填入 Mihomo / Clash 客户端的订阅地址中。</p>
        </div>
    </div>

    <script>
        async function saveConfig() {
            const links = document.getElementById('linksInput').value.trim();
            const btn = document.getElementById('submitBtn');
            if (!links) {
                alert('请至少输入一个订阅链接');
                return;
            }

            btn.disabled = true;
            btn.textContent = '生成中...';

            try {
                const res = await fetch('/api/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ links })
                });
                const data = await res.json();
                if (data.success) {
                    document.getElementById('subUrlOutput').value = data.url;
                    document.getElementById('resultBox').classList.remove('hidden');
                } else {
                    alert('保存失败: ' + data.error);
                }
            } catch (e) {
                alert('请求异常: ' + e.message);
            } finally {
                btn.disabled = false;
                btn.textContent = '确认并生成专属订阅';
            }
        }

        function copyUrl() {
            const input = document.getElementById('subUrlOutput');
            input.select();
            document.execCommand('copy');
            alert('已成功复制订阅链接到剪贴板！');
        }
    </script>
</body>
</html>`;
}

function dedent(text) {
  const lines = text.split('\n');
  let minIndent = Infinity;

  for (const line of lines) {
    if (line.trim() === '') continue;
    const match = line.match(/^(\s*)/);
    if (match) {
      const indentLen = match[1].length;
      if (indentLen > 0 && indentLen < minIndent) {
        minIndent = indentLen;
      }
    }
  }

  if (minIndent === Infinity || minIndent === 0) return text;

  return lines.map(line => {
    const match = line.match(/^(\s*)/);
    if (match && match[1].length >= minIndent) {
      return line.slice(minIndent);
    }
    return line;
  }).join('\n');
}
