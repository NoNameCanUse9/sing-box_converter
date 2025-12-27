/**
 * mihomo2sing-box.js
 * 功能：将 Mihomo (Clash) 格式的 JS 对象列表转换为 Sing-box 的 outbounds 列表。
 * * 输入示例：
 * [{name: '节点A', type: 'vless', server: '...', port: 443, ...}, ...]
 * * 输出：
 * Sing-box outbound objects array
 */

// ============================================================================
// 1. 字段映射工具 (Mappers)
// ============================================================================

const Mappers = { // 安全转数字
    toInt: (val) => {
        const num = parseInt(val);
        return isNaN(num) ? undefined : num;
    },

    // 构建 TLS 配置
    // Clash 字段: tls, servername, sni, skip-cert-verify, client-fingerprint, reality-opts
    buildTls: (item) => { // 基础判断：如果 tls 字段为 true，或者有 reality 配置，或者特定协议（H2/TUIC）默认开启
        const isTlsEnabled = item.tls || item['reality-opts'] || ['hysteria2', 'tuic', 'trojan'].includes(item.type);

        if (! isTlsEnabled) 
            return undefined;
        


        const tlsObj = {
            enabled: true,
            server_name: item.servername || item.sni || item.server, // 优先用 servername
            insecure: item['skip-cert-verify'] === true || item.insecure === true,
            alpn: item.alpn
        };

        // Fingerprint (uTLS)
        if (item['client-fingerprint'] || item.fingerprint) {
            tlsObj.utls = {
                enabled: true,
                fingerprint: item['client-fingerprint'] || item.fingerprint
            };
        }

        // Reality
        if (item['reality-opts']) {
            tlsObj.reality = {
                enabled: true,
                public_key: item['reality-opts']['public-key'],
                short_id: item['reality-opts']['short-id']
            };
            // Reality 场景下，server_name 通常由 reality-opts 提供
            if (item['reality-opts'].servername) {
                tlsObj.server_name = item['reality-opts'].servername;
            }
        }

        return tlsObj;
    },

    // 构建 Transport 配置
    // Clash 字段: network, ws-opts, grpc-opts, h2-opts, http-opts
    buildTransport: (item) => {
        const net = item.network || item.type; // vmess/vless 有 network 字段

        if (net === 'ws') {
            const opts = item['ws-opts'] || {};
            return {
                type: 'ws',
                path: opts.path || '/',
                headers: opts.headers,
                max_early_data: opts['max-early-data'],
                early_data_header_name: opts['early-data-header-name'] || 'Sec-WebSocket-Protocol'
            };
        } else if (net === 'grpc') {
            const opts = item['grpc-opts'] || {};
            return {type: 'grpc', service_name: opts['grpc-service-name'], idle_timeout: opts['idle-timeout']};
        } else if (net === 'h2' || net === 'http') {
            const opts = item['h2-opts'] || item['http-opts'] || {};
            return {
                type: 'http',
                path: opts.path || '/',
                host: opts.host, // Sing-box http transport host 可是数组或字符串，通常字符串即可
                method: opts.method
            };
        }

        return undefined; // TCP 不需要 transport 块
    },

    // 构建 Multiplex 配置
    buildMultiplex: (item) => {
        if (item.smux && item.smux.enabled) {
            return {
                enabled: true,
                protocol: item.smux.protocol || 'h2mux',
                max_connections: item.smux['max-connections'],
                min_streams: item.smux['min-streams'],
                max_streams: item.smux['max-streams'],
                padding: item.smux.padding
            };
        }
        return undefined;
    }
};

// ============================================================================
// 2. 协议转换器 (Converters)
// ============================================================================

const Converters = {
    // === VLESS ===
    vless: (item) => (
        {
            type: 'vless',
            tag: item.name,
            server: item.server,
            server_port: Mappers.toInt(item.port),
            uuid: item.uuid,
            flow: item.flow || undefined, // 如 xtls-rprx-vision
            packet_encoding: item['packet-encoding'] || 'xudp',
            tls: Mappers.buildTls(item),
            transport: Mappers.buildTransport(item),
            multiplex: Mappers.buildMultiplex(item)
        }
    ),

    // === VMess ===
    vmess: (item) => (
        {
            type: 'vmess',
            tag: item.name,
            server: item.server,
            server_port: Mappers.toInt(item.port),
            uuid: item.uuid,
            security: item.cipher || 'auto',
            alter_id: Mappers.toInt(item.alterId || 0),
            global_padding: item['global-padding'],
            authenticated_length: item['authenticated-length'],
            tls: Mappers.buildTls(item),
            transport: Mappers.buildTransport(item),
            multiplex: Mappers.buildMultiplex(item)
        }
    ),

    // === Shadowsocks (SS) ===
    ss: (item) => (
        {
            type: 'shadowsocks',
            tag: item.name,
            server: item.server,
            server_port: Mappers.toInt(item.port),
            method: item.cipher,
            password: item.password,
            plugin: item.plugin,
            plugin_opts: item['plugin-opts']
        }
    ),

    // === ShadowsocksR (SSR) ===
    ssr: (item) => (
        {
            type: 'shadowsocksr',
            tag: item.name,
            server: item.server,
            server_port: Mappers.toInt(item.port),
            method: item.cipher,
            password: item.password,
            obfs: item.obfs,
            obfs_param: item['obfs-param'],
            protocol: item.protocol,
            protocol_param: item['protocol-param']
        }
    ),

    // === Trojan ===
    trojan: (item) => (
        {
            type: 'trojan',
            tag: item.name,
            server: item.server,
            server_port: Mappers.toInt(item.port),
            password: item.password,
            tls: Mappers.buildTls(item),
            transport: Mappers.buildTransport(item),
            multiplex: Mappers.buildMultiplex(item)
        }
    ),

    // === Hysteria 2 ===
    hysteria2: (item) => { // 处理带宽格式 (Clash 可能是 "100 Mbps" 字符串)
        const parseBandwidth = (val) => {
            if (!val) 
                return undefined;
            

            if (typeof val === 'number') 
                return val;
            

            return parseInt(val.split(' ')[0]);
        };

        const node = {
            type: 'hysteria2',
            tag: item.name,
            server: item.server,
            server_port: Mappers.toInt(item.port),
            password: item.password || item.auth,
            up_mbps: parseBandwidth(item.up),
            down_mbps: parseBandwidth(item.down),
            tls: Mappers.buildTls(item) || {
                enabled: true
            }, // H2 必须有 TLS
            obfs: undefined
        };

        // Obfs 转换
        if (item.obfs) {
            node.obfs = {
                type: item.obfs, // 通常是 'salamander'
                password: item['obfs-password']
            };
        }
        return node;
    },

    // === TUIC ===
    tuic: (item) => (
        {
            type: 'tuic',
            tag: item.name,
            server: item.server,
            server_port: Mappers.toInt(item.port),
            uuid: item.uuid,
            password: item.password,
            congestion_control: item['congestion-controller'] || 'bbr',
            udp_relay_mode: item['udp-relay-mode'] || 'native',
            zero_rtt_handshake: item['reduce-rtt'] === true,
            tls: {
                enabled: true,
                server_name: item.sni || item.servername,
                alpn: item.alpn || ['h3'],
                insecure: item['skip-cert-verify'] === true
            }
        }
    ),

    // === WireGuard ===
    wireguard: (item) => {
        const node = {
            type: 'wireguard',
            tag: item.name,
            server: item.server,
            server_port: Mappers.toInt(item.port),
            private_key: item['private-key'],
            peer_public_key: item['public-key'],
            pre_shared_key: item['pre-shared-key'],
            mtu: Mappers.toInt(item.mtu),
            local_address: []
        };

        // Clash 的 ip 和 ipv6 字段 -> Sing-box local_address 数组
        if (item.ip) {
            node.local_address.push(item.ip.includes('/') ? item.ip : `${
                item.ip
            }/32`);
        }
        if (item.ipv6) {
            node.local_address.push(item.ipv6.includes('/') ? item.ipv6 : `${
                item.ipv6
            }/128`);
        }

        if (item.reserved) {
            node.reserved = item.reserved;
        }

        return node;
    },

    // === HTTP/SOCKS ===
    http: (item) => (
        {
            type: 'http',
            tag: item.name,
            server: item.server,
            server_port: Mappers.toInt(item.port),
            username: item.username,
            password: item.password,
            tls: item.tls ? {
                enabled: true,
                insecure: item['skip-cert-verify'] === true
            } : undefined
        }
    ),
    socks5: (item) => (
        {
            type: 'socks',
            tag: item.name,
            server: item.server,
            server_port: Mappers.toInt(item.port),
            version: '5',
            username: item.username,
            password: item.password
        }
    )
};

// ============================================================================
// 3. 主转换函数
// ============================================================================

/**
 * convertList
 * @param {Array} inputList - Mihomo/Clash 格式的对象数组
 * @returns {Array} Sing-box Outbound 配置数组
 */
function convertList(inputList) {
    if (!Array.isArray(inputList)) {
        console.error("Mihomo2SingBox: 输入不是数组");
        return [];
    }

    // 映射处理
    const result = inputList.map((item) => {
        if (!item || !item.type) 
            return null;
        


        let type = item.type.toLowerCase();

        // 兼容性处理：Clash 的 socks5 在 Sing-box 叫 socks
        // Clash 的 ss 在 Sing-box 叫 shadowsocks
        // 这里 Converters key 已经做了部分适配

        const converter = Converters[type];
        if (converter) {
            try {
                return converter(item);
            } catch (e) {
                console.warn(`[Mihomo2SingBox] 转换失败: ${
                    item.name
                }`, e);
                return null;
            }
        } else { // 不支持的类型 (如 url-test, selector 等组策略，不应出现在纯节点转换里)
            return null;
        }
    });

    // 过滤掉 null
    return result.filter(Boolean);
}

// 导出
if (typeof module !== 'undefined') {
    module.exports = {
        convertList
    };
}
