import yaml from 'js-yaml';
import indexHTML from './index.html';
import config_template from './rule.json';
import {convertList} from './mihomo2sing-box.js';
import {parseUrlsToClash} from './LinkToClash.js';
import {drizzle} from 'drizzle-orm/d1';
import {subscriptions, users, singboxConfigs} from './schema.ts';
import {eq} from 'drizzle-orm';

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const db = drizzle(env.DB);
        const config_hash = [];
        let isSplitParam = url.searchParams.get("is_split") === "true";

        // 1. Handle /convert OR params based requests
        if (url.pathname === "/convert" || url.searchParams.has("urls")) {
            let urlsProcessed = [];
            if (request.method === "POST") {
                const formData = await request.formData();
                const urlsRaw = formData.get("urls") || "";
                urlsProcessed = urlsRaw.split("\n").map(u => u.trim()).filter(u => u.startsWith("http"));
                if (formData.has("is_split")) 
                    isSplitParam = formData.get("is_split") === "true";
                


            } else {
                const urlsRaw = url.searchParams.get("urls") || "";
                urlsProcessed = urlsRaw.split(",").map(u => u.trim()).filter(u => u.startsWith("http"));
            }

            if (urlsProcessed.length === 0) {
                return new Response(JSON.stringify({error: "没有有效的订阅地址"}), {status: 400});
            }

            try {
                const {config: finalConfig} = await generateSingboxConfig(urlsProcessed, isSplitParam);
                return new Response(JSON.stringify(finalConfig, null, 2), {
                    headers: {
                        "Content-Type": "application/json; charset=utf-8",
                        "Access-Control-Allow-Origin": "*"
                    }
                });
            } catch (e) {
                return new Response(JSON.stringify({
                    error: "配置生成失败: " + e.message
                }), {status: 500});
            }
        }

        // 2. Handle /sub (Generate Subscription Link, convert once if needed)
        if (url.pathname === "/sub" && request.method === "POST") {
            try {
                const formData = await request.formData();
                const urlsRaw = formData.get("urls") || "";

                if (! urlsRaw) 
                    return new Response(JSON.stringify({error: "没有提供订阅链接"}), {status: 400});
                


                const urlsProcessed = urlsRaw.split("\n").map(u => u.trim()).filter(u => u.startsWith("http"));

                if (urlsProcessed.length === 0) 
                    return new Response(JSON.stringify({error: "没有有效的订阅地址"}), {status: 400});
                


                // Run conversion once to ensure validity (and potentially cache config in future)
                const {config: finalConfig, hashes: config_hash} = await generateSingboxConfig(urlsProcessed, isSplitParam);

                const userId = generateId(24);

                await db.insert(users).values({id: userId, createdAt: Date.now()}).run();

                // Insert each subscription - ID will auto-increment
                for (let i = 0; i < urlsProcessed.length; i++) {
                    await db.insert(subscriptions).values({
                        userId: userId,
                        name: `Subscription ${
                            i + 1
                        }`,
                        url: urlsProcessed[i],
                        lastHash: config_hash[i],
                        updatedAt: Date.now()
                    }).run();
                }

                // Insert config - ID will auto-increment
                await db.insert(singboxConfigs).values({userId: userId, jsonContent: JSON.stringify(finalConfig), createdAt: Date.now()}).run();

                const subscriptionUrl = `${
                    url.origin
                }/sub/${userId}`;
                return new Response(JSON.stringify({subscriptionUrl: subscriptionUrl, config: finalConfig}), {
                    headers: {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*"
                    }
                });
            } catch (e) {
                return new Response(JSON.stringify({
                    error: e.message || "Server Error"
                }), {status: 500});
            }
        }

        // 3. Handle Short Link Access (GET /sub/:id)
        const shortLinkMatch = url.pathname.match(/^\/sub\/([a-zA-Z0-9-]+)$/);
        if (shortLinkMatch) {
            const id = shortLinkMatch[1];
            try {
                const result = await db.select().from(subscriptions).where(eq(subscriptions.id, id)).get();
                if (result) {
                    const urlsProcessed = result.url.split(/[\n,]/).map(u => u.trim()).filter(u => u.startsWith("http"));
                    const {config: finalConfig} = await generateSingboxConfig(urlsProcessed, isSplitParam); // Generate fresh config on access
                    return new Response(JSON.stringify(finalConfig, null, 2), {
                        headers: {
                            "Content-Type": "application/json; charset=utf-8",
                            "Access-Control-Allow-Origin": "*"
                        }
                    });
                } else {
                    return new Response("Link not found", {status: 404});
                }
            } catch (e) {
                return new Response("Database error: " + e.message, {status: 500});
            }
        }

        return new Response(indexHTML, {
            headers: {
                "Content-Type": "text/html; charset=utf-8"
            }
        });
    }
};

function decodeBase64(str) {
    try {
        return decodeURIComponent(escape(atob(str.trim().replace(/\s/g, ''))));
    } catch (e) {
        return str;
    }
}

// Helper function to calculate SHA-256 hash using Web Crypto API
async function sha256Hash(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function extractProxies(rawData) {
    let contentHash = null;

    // 定义一个辅助函数来尝试解析内容
    const tryParseContent = async (data) => { // 首先尝试 YAML 解析
        try {
            const config = yaml.load(data);
            if (config && Array.isArray(config.proxies)) {
                console.log("成功解析为 YAML 格式");
                contentHash = await sha256Hash(data);
                return config.proxies;
            }
        } catch (yamlError) { // YAML 解析失败，继续尝试其他格式
        }

        // 检查是否包含代理协议链接
        const hasProxyUrls = /^(vless|vmess|ss|ssr|trojan|hysteria2|hy2|tuic|socks5):\/\//im.test(data);

        if (hasProxyUrls) {
            try { // 使用 parseUrlsToClash 解析 URL 列表
                const parsedNodes = parseUrlsToClash(data);
                if (parsedNodes && parsedNodes.length > 0) {
                    console.log(`成功解析 ${
                        parsedNodes.length
                    } 个 URL 节点`);
                    contentHash = await sha256Hash(data);
                    return parsedNodes;
                }
            } catch (urlError) {
                console.error("URL 解析失败:", urlError.message);
            }
        }

        return null;
    };

    // 1. 先尝试直接解析原始内容（可能是明文 YAML 或明文 URL 列表）
    console.log("尝试解析原始内容...");
    const directResult = await tryParseContent(rawData);
    if (directResult) {
        return {proxies: directResult, hash: contentHash};
    }

    // 2. 如果直接解析失败，尝试 Base64 解码后再解析
    console.log("原始内容解析失败，尝试 Base64 解码...");
    try {
        const decodedContent = decodeURIComponent(escape(atob(rawData.trim().replace(/\s/g, ''))));
        console.log("Base64 解码成功，尝试解析解码后的内容...");

        const decodedResult = await tryParseContent(decodedContent);
        if (decodedResult) {
            return {proxies: decodedResult, hash: contentHash};
        }

        console.log("解码后的内容也无法解析");
    } catch (e) {
        console.log("Base64 解码失败:", e.message);
    }

    throw new Error("解析失败，内容既不是有效的 YAML 也不是有效的 URL 列表");
}

function applyRegexFilter(dataList, regexStr) {
    if (! regexStr || !Array.isArray(dataList)) 
        return [];
    


    let pattern = regexStr;
    let flags = "gu";
    if (pattern.includes("(?i)")) {
        pattern = pattern.replace(/\(\?i\)/g, "");
        if (! flags.includes("i")) 
            flags += "i";
        


    }
    try {
        if (! pattern) 
            return dataList;
        


        const regex = new RegExp(pattern, flags.includes("i") ? "iu" : "u");
        return dataList.filter(item => typeof item === 'string' && regex.test(item));
    } catch (e) {
        console.error("非法正则语法:", e.message, "原字符串:", regexStr);
        return [];
    }
}

function validateRegex(regexStr) {
    if (typeof regexStr !== 'string') 
        return {valid: false, error: "输入不是字符串"};
    


    let pattern = regexStr;
    let flags = "u";
    if (pattern.includes("(?i)")) {
        pattern = pattern.replace(/\(\?i\)/g, "");
        flags += "i";
    }
    try {
        new RegExp(pattern, flags);
        return {valid: true, error: null};
    } catch (e) {
        return {valid: false, error: e.message};
    }
}


async function generateSingboxConfig(urlsProcessed, isSplitParam) {
    const config_hash = []; // Initialize config_hash inside function

    const {
        ruler_base_setting,
        base_proxy_group,
        rule_proxy_group,
        rules_set_pair,
        fillter: filterConfig,
        country_filter,
        dns,
        log,
        experimental,
        inbounds
    } = config_template;

    let finalOutbounds = [];
    let allProxyNodes = [];
    let countryGroups = {};

    base_proxy_group.forEach(group => {
        if (group.type !== "direct") {
            countryGroups[group.tag] = [];
        }
    });

    const autoSelectNodes = [];
    const otherNodes = [];

    for (let i = 0; i < urlsProcessed.length; i++) {
        const subUrl = urlsProcessed[i];
        const subSuffix = urlsProcessed.length > 1 ? ` - S${
            i + 1
        }` : '';
        try {
            const res = await fetch(subUrl);
            if (! res.ok) 
                throw new Error(`HTTP ${
                    res.status
                }`);
            


            const text = await res.text();
            const {proxies: rawProxies, hash} = await extractProxies(text);
            config_hash.push(hash);
            let proxies = convertList(rawProxies);

            if (filterConfig && filterConfig[0] && Array.isArray(filterConfig[0].exclude)) {
                for (const excludeRegex of filterConfig[0].exclude) {
                    proxies = proxies.filter(p => !new RegExp(excludeRegex, "i").test(p.tag));
                }
            }

            for (let p of proxies) {
                const originalTag = p.tag;
                const newTag = `${originalTag}${subSuffix}`;
                const node = {
                    ... p,
                    tag: newTag
                };
                allProxyNodes.push(node);
                autoSelectNodes.push(newTag);

                let matched = false;
                for (const filter of country_filter) {
                    if (validateRegex(filter.regex).valid) {
                        if (applyRegexFilter([originalTag], filter.regex).length > 0) {
                            if (countryGroups[filter.tag]) {
                                countryGroups[filter.tag].push(newTag);
                                matched = true;
                                break;
                            }
                        }
                    }
                }
                if (! matched) {
                    otherNodes.push(newTag);
                }
            }
        } catch (e) {
            console.error(`订阅获取失败 [${subUrl}]: ${
                e.message
            }`);
        }
    }

    finalOutbounds.push(... allProxyNodes);

    if (isSplitParam || urlsProcessed.length === 1) {
        base_proxy_group.forEach(template => {
            const group = {
                ...template
            };
            if (group.tag === "😀 自动择优") 
                group.outbounds = [... autoSelectNodes];
             else if (group.tag === "🌐 其他节点") 
                group.outbounds = otherNodes.length > 0 ? otherNodes : ["direct"];
             else if (countryGroups[group.tag]) 
                group.outbounds = countryGroups[group.tag].length > 0 ? countryGroups[group.tag] : ["direct"];
            


            finalOutbounds.push(group);
        });
    } else {
        for (let i = 0; i < urlsProcessed.length; i++) {
            const subSuffix = ` - S${
                i + 1
            }`;
            const subNodes = allProxyNodes.filter(n => n.tag.endsWith(subSuffix)).map(n => n.tag);
            const subOtherNodes = otherNodes.filter(tag => tag.endsWith(subSuffix));

            base_proxy_group.forEach(template => {
                if (template.type === "direct") {
                    if (i === 0) 
                        finalOutbounds.push(template);
                    


                    return;
                }
                const group = JSON.parse(JSON.stringify(template));
                group.tag = `${
                    group.tag
                }${subSuffix}`;
                if (template.tag === "😀 自动择优") 
                    group.outbounds = subNodes;
                 else if (template.tag === "🌐 其他节点") 
                    group.outbounds = subOtherNodes.length > 0 ? subOtherNodes : ["direct"];
                 else if (countryGroups[template.tag]) {
                    group.outbounds = countryGroups[template.tag].filter(tag => tag.endsWith(subSuffix));
                    if (group.outbounds.length === 0) 
                        group.outbounds = ["direct"];
                    


                }
                finalOutbounds.push(group);
            });
        }
    }

    rule_proxy_group.forEach(group => {
        const g = {
            ...group
        };
        if (g.tag === "全局代理") {
            g.outbounds = [... autoSelectNodes];
        } else if (g.outbounds && g.outbounds.length === 0) {
            if (! isSplitParam && urlsProcessed.length > 1) {
                g.outbounds = [];
                for (let i = 0; i < urlsProcessed.length; i++) {
                    const subSuffix = ` - S${
                        i + 1
                    }`;
                    base_proxy_group.forEach(b => {
                        if (b.type !== "direct") 
                            g.outbounds.push(`${
                                b.tag
                            }${subSuffix}`);
                         else if (i === 0) 
                            g.outbounds.push(b.tag);
                        


                    });
                }
            } else {
                g.outbounds = base_proxy_group.map(b => b.tag);
            }
        }
        finalOutbounds.push(g);
    });

    const finalConfig = {
        log,
        dns,
        experimental,
        inbounds,
        outbounds: finalOutbounds,
        route: {
            rules: [
                ...ruler_base_setting,
                ...rules_set_pair
            ]
        }
    };
    finalConfig.route.rules[0].inbound.push(... finalConfig.inbounds.map(i => i.tag));

    return {config: finalConfig, hashes: config_hash};
}

// Generate random Hex ID
function generateId(length = 24) {
    const byteLength = Math.ceil(length / 2);
    const array = new Uint8Array(byteLength);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('').slice(0, length);
}
