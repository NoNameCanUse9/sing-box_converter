/**
 * 工具函数：处理 Base64 (兼容 URL-safe)
 */
function safeBase64Decode(str) {
    if (! str) 
        return '';
    


    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) {
        str += '=';
    }
    try { // 浏览器/Node通用环境判断
        if (typeof Buffer !== 'undefined') {
            return Buffer.from(str, 'base64').toString('utf-8');
        } else {
            return atob(str);
        }
    } catch (e) {
        return str;
    }
}

function parseProxyUrl(urlStr) {
    if (! urlStr) 
        return null;
    


    try {
        // 预处理：部分协议可能不符合标准 URL 格式，需特殊处理
        // 例如 SSR 经常是 ssr://base64
        if (urlStr.startsWith('ssr://')) { // SSR 逻辑比较古老且复杂，通常建议直接转换，这里暂略，预留接口
            return parseSSR(urlStr);
        }
        if (urlStr.startsWith('vmess://')) {
            return parseVMess(urlStr);
        }

        const url = new URL(urlStr);
        const protocol = url.protocol.replace(':', '');
        const params = Object.fromEntries(url.searchParams);
        const name = decodeURIComponent(url.hash.slice(1)) || 'Unnamed';

        const baseConfig = {
            name: name,
            server: url.hostname,
            port: parseInt(url.port),
            type: protocol
        };

        switch (protocol) {
            case 'ss':
                return parseShadowsocks(url, baseConfig);
            case 'trojan':
                return parseTrojan(url, baseConfig, params);
            case 'vless':
                return parseVless(url, baseConfig, params);
            case 'hysteria2':
            case 'hy2': baseConfig.type = 'hysteria2';
                return parseHysteria2(url, baseConfig, params);
            case 'tuic':
                return parseTuic(url, baseConfig, params);
            case 'socks5':
            case 'socks': baseConfig.type = 'socks5';
                // Socks 比较简单，通常只有 user/pass
                if (url.username) 
                    baseConfig.username = url.username;
                


                if (url.password) 
                    baseConfig.password = url.password;
                


                return baseConfig;
            default:
                console.warn(`不支持或未实现的协议: ${protocol}`);
                return null;
        }

    } catch (e) {
        console.error(`解析出错 [${urlStr}]:`, e);
        return null;
    }
}


function parseVless(url, config, params) {
    config.uuid = url.username;
    config.type = 'vless';
    // Clash Meta 字段

    // 传输层配置
    if (params.type) 
        config.network = params.type;
    


    // 流控 (Flow)
    if (params.flow) 
        config.flow = params.flow;
    


    // TLS / Reality 配置
    if (params.security === 'tls' || params.security === 'reality') {
        config.tls = true;
        config.servername = params.sni || '';
        config['client-fingerprint'] = params.fp || 'chrome';

        if (params.alpn) 
            config.alpn = params.alpn.split(',');
        


        if (params.security === 'reality') {
            config['reality-opts'] = {
                'public-key': params.pbk,
                'short-id': params.sid
            };
            if (params.sni) 
                config['reality-opts'].servername = params.sni;
            


        }
    }

    // gRPC 配置
    if (params.type === 'grpc') {
        config['grpc-opts'] = {
            'grpc-service-name': params.serviceName
        };
    }

    // WebSocket 配置
    if (params.type === 'ws') {
        config['ws-opts'] = {
            path: params.path || '/',
            headers: {
                Host: params.host || params.sni || config.server
            }
        };
    }

    return config;
}

function parseVMess(urlStr) { // VMess 通常是 vmess://Base64(JSON)
    const b64 = urlStr.replace('vmess://', '');
    try {
        const jsonStr = safeBase64Decode(b64);
        const item = JSON.parse(jsonStr);

        const config = {
            name: item.ps || 'VMess Node',
            type: 'vmess',
            server: item.add,
            port: parseInt(item.port),
            uuid: item.id,
            alterId: parseInt(item.aid) || 0,
            cipher: item.scy || 'auto',
            network: item.net || 'tcp',
            tls: item.tls === 'tls' || item.tls === '1',
            servername: item.host || item.sni || ''
        };

        if (item.net === 'ws') {
            config['ws-opts'] = {
                path: item.path || '/',
                headers: {
                    Host: item.host || ''
                }
            };
        }

        // 简单的 grpc 处理，vmess 链接标准较混乱，这里做基础兼容
        if (item.net === 'grpc') {
            config['grpc-opts'] = {
                'grpc-service-name': item.path
            };
        }

        return config;
    } catch (e) {
        console.error("VMess 解析失败", e);
        return null;
    }
}

function parseShadowsocks(url, config) {
    // ss://Base64(method:pass)@host:port#name
    // 或者 ss://Base64(method:pass@host:port)#name
    let userInfo = url.username;

    // 如果没有 password，说明可能是旧版全 Base64 格式
    if (! url.password && userInfo) {
        const decoded = safeBase64Decode(userInfo);
        if (decoded.includes('@')) { // 格式: method:pass@host:port
            const parts = decoded.split('@');
            const creds = parts[0].split(':');
            const addr = parts[1].split(':');

            config.cipher = creds[0];
            config.password = creds.slice(1).join(':'); // 防止密码里有冒号
            config.server = addr[0];
            config.port = parseInt(addr[1]);
        } else { // 格式: method:pass
            const creds = decoded.split(':');
            config.cipher = creds[0];
            config.password = creds.slice(1).join(':');
        }
    } else {
        config.cipher = url.username;
        config.password = url.password;
    }

    // 处理 SIP002 插件 (如 obfs, v2ray-plugin)
    // 这里略过复杂插件逻辑，仅做基础 SS
    return config;
}

function parseTrojan(url, config, params) {
    config.password = url.username;
    config.sni = params.sni || params.peer || '';
    if (params.allowInsecure === '1') 
        config['skip-cert-verify'] = true;
    


    // Trojan 通常基于 TLS，但也可能套 WS/gRPC
    if (params.type === 'ws') {
        config.network = 'ws';
        config['ws-opts'] = {
            path: params.path || '/',
            headers: {
                Host: params.host || params.sni
            }
        };
    }
    return config;
}

function parseHysteria2(url, config, params) { // hysteria2://user:pass@host:port?insecure=1&sni=xxx
    config.type = 'hysteria2';
    config.password = url.username || ''; // Hy2 使用 user 部分作为 auth

    if (params.sni) 
        config.sni = params.sni;
    


    if (params.insecure === '1') 
        config['skip-cert-verify'] = true;
    


    if (params.obfs) {
        config.obfs = params.obfs;
        config['obfs-password'] = params['obfs-password'];
    }
    return config;
}

function parseTuic(url, config, params) {
    config.type = 'tuic';
    config.uuid = url.username;
    config.password = url.password;
    config['congestion-controller'] = params.congestion_control || 'bbr';
    config['udp-relay-mode'] = params.udp_relay_mode || 'native';
    if (params.sni) 
        config.servername = params.sni;
    


    if (params.allow_insecure === '1') 
        config['skip-cert-verify'] = true;
    


    return config;
}

// 占位函数：SSR 解析非常繁琐，通常建议后端转换
function parseSSR(urlStr) {
    if (! urlStr.startsWith('ssr://')) 
        return null;
    


    try {
        // 1. 去除前缀并解码主 Base64 串
        // safeBase64Decode 依赖于上一段代码中的工具函数
        const base64Str = urlStr.replace('ssr://', '');
        const decodedUrl = safeBase64Decode(base64Str);

        // 2. 分割 "基本信息" 和 "参数信息"
        // 格式通常是: info_part/?param_part
        const splitIndex = decodedUrl.indexOf('/?');
        let infoPart = decodedUrl;
        let paramPart = '';

        if (splitIndex !== -1) {
            infoPart = decodedUrl.substring(0, splitIndex);
            paramPart = decodedUrl.substring(splitIndex + 2); // 跳过 '/?'
        }

        // 3. 解析基本信息 (server:port:protocol:method:obfs:password)
        const parts = infoPart.split(':');
        if (parts.length !== 6) {
            console.warn('SSR 格式解析错误: 部分数量不对', decodedUrl);
            return null;
        }

        const [server, portStr, protocol, method, obfs, passwordBase64] = parts;

        // 4. 构建 Clash 基础配置
        const config = {
            type: 'ssr',
            server: server,
            port: parseInt(portStr),
            protocol: protocol,
            cipher: method, // Clash 中 SSR 的加密方法字段叫 cipher
            obfs: obfs,
            password: safeBase64Decode(passwordBase64),
            name: 'SSR Node' // 默认名，后面尝试从 params 获取
        };

        // 5. 解析参数部分 (obfsparam, protoparam, remarks, group)
        if (paramPart) { // 使用 URLSearchParams 解析 k1=v1&k2=v2 结构
            const params = new URLSearchParams(paramPart);

            // 辅助函数：SSR 参数的值通常也是 Base64 编码的，需要解包
            const getDecodedParam = (key) => {
                const val = params.get(key);
                return val ? safeBase64Decode(val) : '';
            };

            // 获取节点名称
            const remarks = getDecodedParam('remarks');
            if (remarks) 
                config.name = remarks;
            


            // 获取混淆参数
            const obfsParam = getDecodedParam('obfsparam');
            if (obfsParam) 
                config['obfs-param'] = obfsParam;
            


            // 获取协议参数
            const protoParam = getDecodedParam('protoparam');
            if (protoParam) 
                config['protocol-param'] = protoParam;
            


            // Clash SSR 同样支持 udp
            config.udp = true;
        }

        return config;

    } catch (e) {
        console.error("SSR 解析失败:", e);
        return {name: "SSR_Parse_Error", type: "ssr", server: "error"};
    }
}

// ================= 导出函数 =================

/**
 * 解析多行 URL 格式的订阅内容（例如 Base64 解码后的内容）
 * @param {string} content - 包含多个代理 URL 的字符串，每行一个 URL
 * @returns {Array} Clash 格式的代理节点数组
 */
export function parseUrlsToClash(content) {
    if (! content || typeof content !== 'string') {
        return [];
    }

    // 按行分割，过滤空行
    const lines = content.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);

    const results = [];
    for (const line of lines) {
        try {
            const parsed = parseProxyUrl(line);
            if (parsed) {
                results.push(parsed);
            }
        } catch (e) {
            console.warn(`解析 URL 失败 [${
                line.substring(0, 50)
            }...]:`, e.message);
        }
    }

    return results;
}

// 导出单个 URL 解析函数
export {
    parseProxyUrl
};

// ================= 使用示例 =================

// const testLinks = ["ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTozNTEwZWFmOS1kOTc1LTRmMDYtYjQ5NS0yZDkzYjdhOGJiMWE@3365f630fbdc.kozow.com:56901#%E5%89%A9%E4%BD%99%E6%B5%81%E9%87%8F%EF%BC%9A149.02%20GB", "ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTozNTEwZWFmOS1kOTc1LTRmMDYtYjQ5NS0yZDkzYjdhOGJiMWE@3365f630fbdc.kozow.com:56901#%E8%B7%9D%E7%A6%BB%E4%B8%8B%E6%AC%A1%E9%87%8D%E7%BD%AE%E5%89%A9%E4%BD%99%EF%BC%9A4%20%E5%A4%A9", "ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTozNTEwZWFmOS1kOTc1LTRmMDYtYjQ5NS0yZDkzYjdhOGJiMWE@3365f630fbdc.kozow.com:56901#%E5%A5%97%E9%A4%90%E5%88%B0%E6%9C%9F%EF%BC%9A2027-08-14"];

// // 简单测试运行器
// testLinks.forEach(link => {
//     const result = parseProxyUrl(link); // 假设你之前定义的 parseProxyUrl 在作用域内
//     console.log(`\n--- Testing: ${
//         result ?. type || 'Unknown'
//     } ---`);
//     console.log(result);
// });
