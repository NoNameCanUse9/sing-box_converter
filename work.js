import yaml from "js-yaml";
import indexHTML from "./index.html";
import customerHTML from "./customer.html";
// import config_template from './rule.json';
import { convertList } from "./mihomo2sing-box.js";
import { parseUrlsToClash } from "./LinkToClash.js";
import templateJson from "./template.json";

import { drizzle } from "drizzle-orm/d1";
import {
  subscriptions,
  users,
  singboxConfigs,
  draftConfigs,
  customerConfigs,
} from "./schema.ts";
import { eq, lt } from "drizzle-orm";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const db = drizzle(env.DB);
    const config_hash = [];
    const sessionId = getSessionId(request);
    let template = null;
    let is_customerParam = url.searchParams.get("is_customer") === "true";
    let isSplitParam = url.searchParams.get("is_split") === "true";
    // 1. Handle /convert OR params based requests
    if (url.pathname === "/convert" && request.method === "POST" && !url.pathname.startsWith("/cus/")) {
      try {
        const body = await request.json();
        const rawUrls = body.urls || "";
        isSplitParam = body.is_split === true || String(body.is_split) === "true";
        is_customerParam = body.is_customer === true || String(body.is_customer) === "true";

        if (!rawUrls) {
          return new Response(JSON.stringify({ error: "未找到可用的订阅链接" }), {
            status: 400,
            headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
          });
        }

        // 强力解码：针对可能存在的 URL 编码进行还原
        let decodedUrls = rawUrls;
        let decodeCount = 0;
        while (decodedUrls.includes("%") && decodeCount < 3) {
          try {
            decodedUrls = decodeURIComponent(decodedUrls);
            decodeCount++;
          } catch (e) { break; }
        }

        const subUrls = decodedUrls
          .split(/[\n\s]+/)
          .map((u) => u.trim())
          .filter((u) => u.startsWith("http"));

        if (subUrls.length === 0) {
          return new Response(JSON.stringify({ error: "未找到有效的订阅地址" }), {
            status: 400,
            headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
          });
        }

        // 加载模板 (优先由 sessionId 获取草稿)
        template = templateJson;
        if (is_customerParam && sessionId) {
          console.log("[Customer Check] Loading draft for sessionId:", sessionId);
          const draft = await db
            .select()
            .from(draftConfigs)
            .where(eq(draftConfigs.sessionId, sessionId))
            .get();
          if (draft) {
            template = JSON.parse(draft.jsonContent);
            console.log("[Draft Config] Loaded successfully");
          }
        }

        // 处理节点并生成配置
        const proxyData = await fetchAndParseProxies(subUrls, template[1]);
        const finalConfig = await generateSingboxConfig(
          proxyData,
          isSplitParam,
          template,
        );

        return new Response(JSON.stringify(finalConfig, null, 2), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "请求格式错误或解析失败: " + e.message }), {
          status: 400,
          headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // 1.5 Handle /sub POST (Generate and Save Subscription Link)
    if (url.pathname === "/sub" && request.method === "POST") {
      try {
        // 清理超过一天的过期草稿
        const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
        await db.delete(draftConfigs)
          .where(lt(draftConfigs.createdAt, oneDayAgo))
          .run();

        let rawUrls = "";
        let isSplit = false;
        let isCustomer = false;

        const contentType = request.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const body = await request.json();
          rawUrls = body.urls || "";
          isSplit = body.is_split === true || String(body.is_split) === "true";
          isCustomer =
            body.is_customer === true || String(body.is_customer) === "true";
        } else {
          const formData = await request.formData();
          rawUrls = formData.get("urls") || "";
          isSplit = formData.get("is_split") === "true";
          isCustomer = formData.get("is_customer") === "true";
        }

        if (!rawUrls) {
          return new Response(JSON.stringify({ error: "没有提供订阅链接" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        // URL 解码与过滤
        let decodedUrls = rawUrls;
        let decodeCount = 0;
        while (decodedUrls.includes("%") && decodeCount < 3) {
          try {
            decodedUrls = decodeURIComponent(decodedUrls);
            decodeCount++;
          } catch (e) {
            break;
          }
        }
        const subUrls = decodedUrls
          .split(/[\n\s]+/)
          .map((u) => u.trim())
          .filter((u) => u.startsWith("http"));

        if (subUrls.length === 0) {
          return new Response(JSON.stringify({ error: "没有有效的订阅地址" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        let template = Array.isArray(templateJson) ? [...templateJson] : [{}, {}];
        let userHash = null;

        if (isCustomer && sessionId) {
          console.log(`[/sub POST] Processing custom config for session: ${sessionId}`);
          // 1. 尝试从草稿表读取
          const draft = await db
            .select()
            .from(draftConfigs)
            .where(eq(draftConfigs.sessionId, sessionId))
            .get();

          if (draft) {
            const configJson = draft.jsonContent;
            try {
              const parsed = JSON.parse(configJson);
              if (Array.isArray(parsed) && parsed.length >= 2) {
                template = parsed;
                // 2. 计算当前配置的哈希并持久化
                userHash = await sha256Hash(configJson);
                console.log(`[/sub POST] Draft found, config hash: ${userHash}`);

                // 检查并保存到 customerConfigs (去重存储)
                const existingPersisted = await db
                  .select()
                  .from(customerConfigs)
                  .where(eq(customerConfigs.configHash, userHash))
                  .get();

                if (!existingPersisted) {
                  await db.insert(customerConfigs)
                    .values({
                      configHash: userHash,
                      jsonContent: configJson
                    })
                    .run();
                  console.log("[Persistence] Saved new custom config to customerConfigs table.");
                }
              } else {
                console.warn("[/sub POST] Draft exists but has invalid format (not 2-element array)");
              }
            } catch (e) {
              console.error("[/sub POST] Failed to parse draft config:", e);
            }
          } else {
            console.log(`[/sub POST] No draft found for session ${sessionId}. Checking existing user records...`);
            // 如果没有草稿，尝试从当前 Session ID 关联的旧用户记录获取哈希
            const sessionUser = await db
              .select()
              .from(users)
              .where(eq(users.id, sessionId))
              .get();
            if (sessionUser && sessionUser.customerConfigHash && sessionUser.customerConfigHash !== "null") {
              userHash = sessionUser.customerConfigHash;
              console.log(`[/sub POST] Found existing hash from session user: ${userHash}`);
            } else {
              console.log("[/sub POST] No existing user record or hash found for this session.");
            }
          }
        } else {
          if (isCustomer) console.warn("[/sub POST] isCustomer true but sessionId is null or expired.");
        }

        // 生成配置
        const proxyData = await fetchAndParseProxies(subUrls, template[1]);
        const finalConfig = await generateSingboxConfig(
          proxyData,
          isSplit,
          template,
        );

        // 持久化到数据库
        const newUserId = generateId(24);
        await db
          .insert(users)
          .values({
            id: newUserId,
            customerConfigHash: userHash,
            createdAt: Date.now(),
          })
          .run();

        // 存储子链接
        for (let i = 0; i < subUrls.length; i++) {
          await db
            .insert(subscriptions)
            .values({
              userId: newUserId,
              name: `Subscription ${i + 1}`,
              url: subUrls[i],
              lastHash: proxyData.hashes[i] || "",
              updatedAt: Date.now(),
            })
            .run();
        }

        // 存储配置缓存
        await db
          .insert(singboxConfigs)
          .values({
            userId: newUserId,
            jsonContent: JSON.stringify(finalConfig),
            createdAt: Date.now(),
          })
          .run();

        const subscriptionUrl = `${url.origin}/sub?id=${newUserId}${isSplit ? "&is_split=true" : ""}`;
        return new Response(
          JSON.stringify({ subscriptionUrl, config: finalConfig }),
          {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      } catch (e) {
        console.error("[/sub POST Error]", e);
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    // 2. Handle /sub (Generate Subscription Link, convert once if needed)
    if (
      url.pathname === "/sub" &&
      request.method === "GET" &&
      (url.searchParams.has("id") || url.search.length > 1)
    ) {
      const id =
        url.searchParams.get("id") ||
        url.searchParams.get("") ||
        url.search.substring(1).split("&")[0];
      try {
        // 1. 获取用户信息
        const user = await db
          .select()
          .from(users)
          .where(eq(users.id, id))
          .get();
        if (!user) {
          return new Response("订阅 ID 不存在", { status: 404 });
        }

        // 2. 获取订阅链接
        const subRecords = await db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.userId, id))
          .all();
        let urlsProcessed = subRecords.map((s) => s.url);

        if (urlsProcessed.length === 0) {
          return new Response("未找到可用的订阅链接", { status: 400 });
        }

        // 3. 获取自定义配置（可选）
        let template = Array.isArray(templateJson) ? [...templateJson] : [{}, {}];
        if (user.customerConfigHash && user.customerConfigHash !== "null") {
          const configRecord = await db
            .select()
            .from(customerConfigs)
            .where(eq(customerConfigs.configHash, user.customerConfigHash))
            .get();
          if (configRecord && configRecord.jsonContent) {
            try {
              const parsed = JSON.parse(configRecord.jsonContent);
              if (Array.isArray(parsed) && parsed.length >= 2) {
                template = parsed;
              }
            } catch (e) {
              console.error("Failed to parse custom config:", e);
            }
          }
        }

        // 4. 生成配置
        const subscriptionInputs = urlsProcessed.map((url) => ({ url }));
        const proxyData = await fetchAndParseProxies(
          subscriptionInputs,
          template[1] || {},
        );
        const finalConfig = await generateSingboxConfig(
          proxyData,
          isSplitParam,
          template,
        );

        return new Response(JSON.stringify(finalConfig, null, 2), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (e) {
        return new Response("生成失败: " + e.message, { status: 500 });
      }
    }
    if (url.pathname === "/customer.html") {
      return new Response(customerHTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
        },
      });
    }
    if (url.pathname === "/configReset") {
      return new Response(JSON.stringify(templateJson, null, 2), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
      });
    }
    if (url.pathname === "/fetchConfig") {
      try {
        let configToReturn = null;
        const session = getSessionId(request);

        // 1. Try to get from draft for current session
        if (session) {
          const draft = await db
            .select()
            .from(draftConfigs)
            .where(eq(draftConfigs.sessionId, session))
            .get();
          if (draft) {
            configToReturn = JSON.parse(draft.jsonContent);
          }
        }
        // 3. Fallback to static template
        if (!configToReturn) {
          configToReturn = templateJson;
        }

        return new Response(JSON.stringify(configToReturn, null, 2), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
          },
        });
      } catch (e) {
        // Fallback to local templateJson on error
        return new Response(JSON.stringify(templateJson, null, 2), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
          },
        });
      }
    }

    if (url.pathname.startsWith("/cus/")) {
      if (url.pathname === "/cus/save") {
        try {
          const body = await request.json();
          const jsonContent = JSON.stringify(body);
          /* console.log("Saving config to server with content:", jsonContent); */
          let session = getSessionId(request);
          let isNewSession = false;

          if (!session) {
            // Generate Session ID with Timestamp: timestamp_uuid
            session = `${Date.now()}_${crypto.randomUUID()}`;
            isNewSession = true;
          }
          console.log("Saving config to server with session:", session);
          // 2. 保存到草稿表 (Drafts)
          const existingDraft = await db
            .select()
            .from(draftConfigs)
            .where(eq(draftConfigs.sessionId, session))
            .get();

          if (existingDraft) {
            const result = await db
              .update(draftConfigs)
              .set({ jsonContent })
              .where(eq(draftConfigs.sessionId, session))
              .run();
          } else {
            const result = await db
              .insert(draftConfigs)
              .values({
                sessionId: session,
                jsonContent,
                createdAt: Math.floor(Date.now() / 1000)
              })
              .run();
          }

          const response = new Response(
            JSON.stringify({ success: true, message: "草稿已保存" }),
            {
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Access-Control-Allow-Origin": "*",
              },
            },
          );

          if (isNewSession) {
            response.headers.append(
              "Set-Cookie",
              `sub_session_id=${session}; Path=/; HttpOnly; SameSite=Lax`,
            );
          }

          return response;
        } catch (e) {
          return new Response(
            JSON.stringify({ success: false, error: e.message }),
            {
              status: 500,
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        }
      }

      if (url.pathname === "/cus/check_draft") {
        const session = getSessionId(request);
        let hasDraft = false;
        if (session) {
          const draft = await db
            .select()
            .from(draftConfigs)
            .where(eq(draftConfigs.sessionId, session))
            .get();
          hasDraft = !!draft;
        }
        return new Response(JSON.stringify({ hasDraft }), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      if (url.pathname === "/cus/cleanup") {
        const session = getSessionId(request);
        if (session) {
          ctx.waitUntil(
            db
              .delete(draftConfigs)
              .where(eq(draftConfigs.sessionId, session))
              .run(),
          );
        }
        return new Response(null, {
          status: 204,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      if (url.pathname === "/cus/fetch_proxies") {
        const urlsRaw = url.searchParams.get("urls") || "";
        const urlsProcessed = urlsRaw
          .split(/[\n,]/)
          .map((u) => u.trim())
          .filter((u) => u.startsWith("http"));
        if (urlsProcessed.length === 0) {
          return new Response(
            JSON.stringify({ success: false, error: "No URLs provided" }),
            { status: 400 },
          );
        }
        try {
          const subscriptionInputs = urlsProcessed.map((url) => ({ url }));
          const { allProxyNodes } =
            await fetchAndParseProxies(subscriptionInputs);
          // Filter out selector/urltest if they happen to be in there (unlikely from fetchAndParseProxies)
          const proxies = allProxyNodes.flat(); // fetchAndParseProxies returns just proxies

          return new Response(JSON.stringify({ success: true, proxies }), {
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Access-Control-Allow-Origin": "*",
            },
          });
        } catch (e) {
          return new Response(
            JSON.stringify({ success: false, error: e.message }),
            {
              status: 500,
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        }
      }
    }

    return new Response(indexHTML, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  },
};

function decodeBase64(str) {
  try {
    return decodeURIComponent(escape(atob(str.trim().replace(/\s/g, ""))));
  } catch (e) {
    return str;
  }
}

// Helper function to calculate SHA-256 hash using Web Crypto API
async function sha256Hash(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function extractProxies(rawData) {
  let contentHash = null;

  // 定义一个辅助函数来尝试解析内容
  const tryParseContent = async (data) => {
    // 首先尝试 YAML 解析
    try {
      const config = yaml.load(data);
      if (config && Array.isArray(config.proxies)) {
        console.log("成功解析为 YAML 格式");
        contentHash = await sha256Hash(data);
        return config.proxies;
      }
    } catch (yamlError) {
      // YAML 解析失败，继续尝试其他格式
    }

    // 检查是否包含代理协议链接
    const hasProxyUrls =
      /^(vless|vmess|ss|ssr|trojan|hysteria2|hy2|tuic|socks5):\/\//im.test(
        data,
      );

    if (hasProxyUrls) {
      try {
        // 使用 parseUrlsToClash 解析 URL 列表
        const parsedNodes = parseUrlsToClash(data);
        if (parsedNodes && parsedNodes.length > 0) {
          console.log(`成功解析 ${parsedNodes.length} 个 URL 节点`);
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
    return { proxies: directResult, hash: contentHash };
  }

  // 2. 如果直接解析失败，尝试 Base64 解码后再解析
  console.log("原始内容解析失败，尝试 Base64 解码...");
  try {
    const decodedContent = decodeURIComponent(
      escape(atob(rawData.trim().replace(/\s/g, ""))),
    );
    console.log("Base64 解码成功，尝试解析解码后的内容...");

    const decodedResult = await tryParseContent(decodedContent);
    if (decodedResult) {
      return { proxies: decodedResult, hash: contentHash };
    }

    console.log("解码后的内容也无法解析");
  } catch (e) {
    console.log("Base64 解码失败:", e.message);
  }

  throw new Error("解析失败，内容既不是有效的 YAML 也不是有效的 URL 列表");
}

function applyRegexFilter(dataList, regexStr) {
  if (!regexStr || !Array.isArray(dataList)) return [];

  let pattern = regexStr;
  let flags = "gu";
  if (pattern.includes("(?i)")) {
    pattern = pattern.replace(/\(\?i\)/g, "");
    if (!flags.includes("i")) flags += "i";
  }
  try {
    if (!pattern) return dataList;

    const regex = new RegExp(pattern, flags.includes("i") ? "iu" : "u");
    return dataList.filter((item) => {
      if (typeof item !== "string") return false;
      // 移除所有 Emoji 字符，确保匹配逻辑只针对中英文文本
      const cleanItem = item.replace(/\p{Extended_Pictographic}/gu, "").trim();
      return regex.test(cleanItem);
    });
  } catch (e) {
    console.error("非法正则语法:", e.message, "原字符串:", regexStr);
    return [];
  }
}

function validateRegex(regexStr) {
  if (typeof regexStr !== "string")
    return { valid: false, error: "输入不是字符串" };

  let pattern = regexStr;
  let flags = "u";
  if (pattern.includes("(?i)")) {
    pattern = pattern.replace(/\(\?i\)/g, "");
    flags += "i";
  }
  try {
    new RegExp(pattern, flags);
    return { valid: true, error: null };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

// Generate random Hex ID
function generateId(length = 24) {
  const byteLength = Math.ceil(length / 2);
  const array = new Uint8Array(byteLength);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

async function fetchAndParseProxies(subscriptionInputs, metadataParam = null) {
  const config_hash = [];
  const metadata = metadataParam || templateJson[1] || {};
  let allProxyNodes = [];

  // 支持单个 URL 字符串或数组
  let inputs = subscriptionInputs;
  if (typeof subscriptionInputs === "string") {
    inputs = [{ url: subscriptionInputs }];
  } else if (
    Array.isArray(subscriptionInputs) &&
    subscriptionInputs.length > 0
  ) {
    // 如果数组元素是字符串，转换为对象格式
    if (typeof subscriptionInputs[0] === "string") {
      inputs = subscriptionInputs.map((url) => ({ url }));
    }
  }

  for (let i = 0; i < inputs.length; i++) {
    const subInput = inputs[i];
    const subUrl = subInput.url;
    // const subSuffix = inputs.length > 1 ? ` - S${i + 1}` : ""; // Suffix logic moved to generation
    try {
      let text;
      if (subInput.content) {
        text = subInput.content;
      } else {
        // 处理 URL：编码非 ASCII 字符，避免 fetch 报 400
        let finalUrl = subUrl;
        try {
          const urlObj = new URL(subUrl);
          // 如果 URL 中包含非 ASCII 字符（如中文），URL 构造函数会自动编码 pathname，但 searchParams 可能需要处理
          finalUrl = urlObj.toString();
        } catch (e) {
          console.warn(`Invalid URL: ${subUrl}`);
        }

        const res = await fetch(finalUrl, {
          headers: {
            "User-Agent": "ClashMeta/1.18.0 ",
          },
        });

        console.log(`[Fetch Debug] Sub ${i + 1}: URL=${finalUrl.substring(0, 60)}..., Status=${res.status}, Type=${res.headers.get("content-type")}`);

        if (!res.ok) {
          const errorText = await res.text().catch(() => "N/A");
          throw new Error(`HTTP ${res.status}: ${errorText.substring(0, 50)}`);
        }

        text = await res.text();
        console.log(`[Fetched Content] Sub ${i + 1}: Length=${text.length}, Preview=${text.substring(0, 80).replace(/\n/g, "\\n")}...`);

        // 尝试对 Fetch 到的内容解码，防止某些订阅源返回的是 URL 编码的内容
        try {
          if (text.includes("%")) {
            const decodedText = decodeURIComponent(text);
            // 简单的启发式检查：如果解码后看起来更像 YAML/Base64/URI list，就使用解码后的
            if (decodedText.length < text.length) {
              // 只有当长度变短（说明确实有编码字符被还原）时才替换，避免误伤
              text = decodedText;
            }
          }
        } catch (e) {
          // 解码失败忽略，使用原始内容
        }
      }

      // 使用文件内部定义的 extractProxies
      const { proxies: rawProxies, hash } = await extractProxies(text);
      config_hash.push(hash);

      // 使用导入的 convertList
      let proxies = convertList(rawProxies);

      // --- Apply Exclude Filter (排除过滤器) ---
      if (metadata.filter?.excluded_outbounds?.length > 0) {
        const excludes = metadata.filter.excluded_outbounds;
        proxies = proxies.filter(
          (p) =>
            !excludes.some((reg) => applyRegexFilter([p.tag], reg).length > 0),
        );
      }

      // Store grouped proxies
      allProxyNodes.push(proxies);
    } catch (e) {
      console.error(`订阅获取失败 [${subUrl}]: ${e.message}`);
      allProxyNodes.push([]); // Keep index alignment even on failure
    }
  }
  return { allProxyNodes, hashes: config_hash };
}

async function generateSingboxConfig(proxyData, isSplitParam, templateConfig) {
  const configBase = templateConfig[0];
  const metadata = templateConfig[1];
  let finalConfig = JSON.parse(JSON.stringify(configBase));
  if (!finalConfig.endpoints) finalConfig.endpoints = [];
  const { allProxyNodes } = proxyData; // Now correctly destructuring from { allProxyNodes, hashes }

  // ==========================================
  // 1. Ruleset Outbound 对齐 (Route Rules Sync)
  // ==========================================

  // 防御性编程：确保 route.rules 结构存在
  if (!finalConfig.route) finalConfig.route = {};
  if (!finalConfig.route.rules) finalConfig.route.rules = [];

  const rulesetMap = metadata.ruleset_outbound_map || {};

  // 找到插入位置：在 clash_mode 规则之后
  let insertIndex = finalConfig.route.rules.findIndex(
    (rule) => rule.clash_mode === "global",
  );
  if (insertIndex === -1) {
    insertIndex = finalConfig.route.rules.findIndex((rule) => rule.rule_set);
  }
  if (insertIndex === -1) {
    insertIndex = Math.min(6, finalConfig.route.rules.length);
  } else {
    insertIndex += 1;
  }

  // 遍历 ruleset_outbound_map 中的每一项配置
  for (const [rulesetId, rawOutbound] of Object.entries(rulesetMap)) {
    const targetOutbound = Array.isArray(rawOutbound) ? rawOutbound[0] : rawOutbound;
    if (!targetOutbound) continue;

    const existingRule = finalConfig.route.rules.find(
      (rule) =>
        rule.rule_set &&
        (rule.rule_set === rulesetId ||
          (Array.isArray(rule.rule_set) && rule.rule_set.includes(rulesetId))),
    );

    if (existingRule) {
      existingRule.outbound = targetOutbound;
    } else {
      finalConfig.route.rules.splice(insertIndex, 0, {
        rule_set: rulesetId,
        outbound: targetOutbound,
      });
      insertIndex++;
    }
  }

  // ==========================================
  // 2. 遍历 Metadata 并分类 (Classify Groups)
  // ==========================================
  const regionList = []; // 地区分类
  const basicList = []; // 基本分组
  const ruleList = []; // 应用规则
  const customList = []; // 自定义分组
  Object.entries(metadata.outboundGroupMap).forEach(([groupName, category]) => {
    switch (category) {
      case "地区分类":
        regionList.push(groupName);
        break;
      case "应用规则":
        ruleList.push(groupName);
        break;
      case "基本分组":
        // 已通过 levelMap 逻辑处理，此处仅需标记为已知
        break;
      default:
        break;
    }
  });

  // 如果你想把它们打成一个对象返回：
  const classifiedGroups = {
    regionList,
    ruleList,
  };
  const outboundLevelMap = {
    level1: [],
    level2: [],
    level3: [],
    level4: [],
  };

  // 1. 备份并清理模板中的原始出站组（我们将重新构建这个数组）
  const templateOutbounds = [...finalConfig.outbounds];
  finalConfig.outbounds = [];

  // 这里的逻辑：如果 template 里的 tag 在 metadata.outboundGroupMap 里找不到，就存入 customList
  templateOutbounds.forEach(o => {
    if (!metadata.outboundGroupMap || !metadata.outboundGroupMap[o.tag]) {
      // 排除掉一些固有的特殊标签（可选，但为了不出错，我们只存 map 里没有的）
      const systemTags = ["direct", "block", "dns-out", "bypass"];
      if (!systemTags.includes(o.tag)) {
        customList.push(o);
      }
    }
  });

  // 获取原始的基础标签列表
  const baseBasicTags = ["♻️ 自动选择", "🐸 手动选择"];

  if (isSplitParam && allProxyNodes.length > 1) {
    allProxyNodes.forEach((_, subIndex) => {
      const n = subIndex + 1;
      const groupSuffix = `-${n}`;

      // Level 1: 创建带后缀的地区组
      classifiedGroups.regionList.forEach((region) => {
        const tag = `${region}${groupSuffix}`;
        outboundLevelMap.level1.push(tag);

        // 从模板复制配置
        const template = templateOutbounds.find(o => o.tag === region);
        finalConfig.outbounds.push({
          ...(template ? JSON.parse(JSON.stringify(template)) : { type: "urltest" }),
          tag: tag,
          outbounds: []
        });
      });

      // Level 2: 创建带后缀的 自动/手动选择
      baseBasicTags.forEach((basic) => {
        const tag = `${basic}${groupSuffix}`;
        outboundLevelMap.level2.push(tag);

        const template = templateOutbounds.find(o => o.tag === basic);
        finalConfig.outbounds.push({
          ...(template ? JSON.parse(JSON.stringify(template)) : { type: "selector" }),
          tag: tag,
          outbounds: []
        });
      });
    });

    // Level 2 补充：全局直连（不带后缀）
    outboundLevelMap.level2.push("🎯 全球直连");
    const directTemplate = templateOutbounds.find(o => o.tag === "🎯 全球直连");
    if (directTemplate) finalConfig.outbounds.push(directTemplate);

  } else {
    // 默认逻辑：不分订阅，直接使用模板中的组
    outboundLevelMap.level1 = classifiedGroups.regionList;
    outboundLevelMap.level2 = [...baseBasicTags, "🎯 全球直连"];

    // 将 level1 和 level2 的组从模板重新填回
    [...outboundLevelMap.level1, ...outboundLevelMap.level2].forEach(tag => {
      const template = templateOutbounds.find(o => o.tag === tag);
      if (template) finalConfig.outbounds.push(JSON.parse(JSON.stringify(template)));
    });
  }

  // 处理 Level 3 和 Level 4（这些通常是全局的，不带后缀）
  outboundLevelMap.level3.push("🚀 默认代理");
  outboundLevelMap.level4 = [...classifiedGroups.ruleList, "🍃 延迟辅助", "🐠 漏网之鱼", "🌍 全局代理"];

  [...outboundLevelMap.level3, ...outboundLevelMap.level4].forEach(tag => {
    const template = templateOutbounds.find(o => o.tag === tag);
    if (template) {
      finalConfig.outbounds.push(JSON.parse(JSON.stringify(template)));
    } else {
      // 如果模板里没有，创建一个基础的选择器
      finalConfig.outbounds.push({ tag, type: "selector", outbounds: [] });
    }
  });

  // 把自定义节点加回去
  const groupingTypes = ["selector", "urltest", "fallback", "balancer"];
  const customNodeTags = [];

  customList.forEach(o => {
    let newNode = JSON.parse(JSON.stringify(o));
    // --- 重点改动：把 wireguard 协议分到 endpoint ---
    if (newNode.type === 'wireguard' && newNode.server) {
      const epTag = `ep-${newNode.tag}`;
      finalConfig.endpoints.push({
        tag: epTag,
        type: 'wireguard',
        address: newNode.server,
        port: newNode.server_port
      });
      newNode.endpoint = epTag;
      delete newNode.server;
      delete newNode.server_port;
    }
    finalConfig.outbounds.push(newNode);

    // 如果不是分组类型，记录下它的 tag，稍后加入手动/全局组
    if (!groupingTypes.includes(newNode.type)) {
      customNodeTags.push(newNode.tag);
    }
  });

  // ==========================================
  // 3. 节点预处理与归类 (Node Processing)
  // ==========================================

  const isMultiSub = allProxyNodes.length > 1;
  const countryFilters = metadata.filter?.country_filter || [];

  allProxyNodes.forEach((sub, subIndex) => {
    const n = subIndex + 1;
    // 节点名称后缀：多订阅时加上，防止重名
    const nodeSuffix = isMultiSub ? `-${n}` : "";
    // 分组名称后缀：多订阅且开启 split 时加上
    const groupSuffix = (isSplitParam && isMultiSub) ? `-${n}` : "";

    // 定位“手动选择”分组
    const manualRef = Object.keys(metadata.outboundGroupMap).find(k => k.includes("手动选择")) || "🐸 手动选择";
    const manualTag = isSplitParam ? `${manualRef}${groupSuffix}` : manualRef;
    let manualGroup = finalConfig.outbounds.find(o => o.tag === manualTag);

    // 定位“全局代理”分组（全局通常不带后缀）
    const globalRef = Object.keys(metadata.outboundGroupMap).find(k => k.includes("全局代理")) || "🌍 全局代理";
    let globalGroup = finalConfig.outbounds.find(o => o.tag === globalRef);

    // 先把自定义节点加进去
    if (manualGroup) {
      if (!manualGroup.outbounds) manualGroup.outbounds = [];
      customNodeTags.forEach(tag => {
        if (!manualGroup.outbounds.includes(tag)) manualGroup.outbounds.push(tag);
      });
    }
    if (globalGroup) {
      if (!globalGroup.outbounds) globalGroup.outbounds = [];
      customNodeTags.forEach(tag => {
        if (!globalGroup.outbounds.includes(tag)) globalGroup.outbounds.push(tag);
      });
    }

    // --- 重点改动：在 node 合并到 outbound 前把 node 循环加入 ---
    // A. 节点预处理：统一重命名并处理协议转换（如 WireGuard -> Endpoints）
    for (let node of sub) {
      let originalTag = node.tag.trim();
      // 确保国旗 Emoji 与文字之间有空格
      originalTag = originalTag.replace(/^(\p{Regional_Indicator}{2})([^\s])/u, '$1 $2');
      const finalTag = `${originalTag}${nodeSuffix}`;
      let newNode = { ...node, tag: finalTag };

      // --- 重点改动：把 wireguard 协议分到 endpoint ---
      if (newNode.type === 'wireguard' && newNode.server) {
        const epTag = `ep-${finalTag}`;
        finalConfig.endpoints.push({
          tag: epTag,
          type: 'wireguard',
          address: newNode.server,
          port: newNode.server_port
        });
        newNode.endpoint = epTag;
        delete newNode.server;
        delete newNode.server_port;
      }
      finalConfig.outbounds.push(newNode);
    }

    // B. 节点填充逻辑：将已加入的节点标签归类到各 Outbound 组
    for (let node of sub) {
      let originalTag = node.tag.trim();
      originalTag = originalTag.replace(/^(\p{Regional_Indicator}{2})([^\s])/u, '$1 $2');
      const finalTag = `${originalTag}${nodeSuffix}`;

      // 填充手动选择和全局代理
      if (manualGroup) {
        if (!manualGroup.outbounds) manualGroup.outbounds = [];
        manualGroup.outbounds.push(finalTag);
      }
      if (globalGroup) {
        if (!globalGroup.outbounds) globalGroup.outbounds = [];
        globalGroup.outbounds.push(finalTag);
      }

      // 地区分类匹配
      for (const filter of countryFilters) {
        const targetGroupTag = `${filter.outbound}${groupSuffix}`;
        let group = finalConfig.outbounds.find(o => o.tag === targetGroupTag);

        if (group && applyRegexFilter([finalTag], filter.regex).length > 0) {
          if (!group.outbounds) group.outbounds = [];
          group.outbounds.push(finalTag);
        }
      }
    }
  });

  // ==========================================
  // C-Cleanup. 移除空的地区分组 (Remove empty region groups)
  // ==========================================
  // 找出所有非空的地区分组标签
  const nonEmptyRegionTags = new Set(
    finalConfig.outbounds
      .filter(o => (o.type === "selector" || o.type === "urltest") && o.outbounds && o.outbounds.length > 0)
      .map(o => o.tag)
  );

  // 过滤掉空的地区组：仅针对 level1 (地区组) 进行清理
  finalConfig.outbounds = finalConfig.outbounds.filter(o => {
    // 如果是 Level 1 地区组且为空，则移除
    if (outboundLevelMap.level1.includes(o.tag) && (!o.outbounds || o.outbounds.length === 0)) {
      return false;
    }
    return true;
  });

  // 同步更新 levelMap，确保后续 Section D/E 不会引用已删除的分组
  outboundLevelMap.level1 = outboundLevelMap.level1.filter(tag => nonEmptyRegionTags.has(tag));

  // ==========================================
  // D. 自动选择逻辑：将地区组加入自动选择
  // ==========================================
  if (isSplitParam && isMultiSub) {
    allProxyNodes.forEach((_, subIndex) => {
      const n = subIndex + 1;
      const groupSuffix = `-${n}`;
      const autoGroupTag = `♻️ 自动选择${groupSuffix}`;
      const autoGroup = finalConfig.outbounds.find(o => o.tag === autoGroupTag);

      if (autoGroup) {
        if (!autoGroup.outbounds) autoGroup.outbounds = [];
        classifiedGroups.regionList.forEach((regionName) => {
          const regionTag = `${regionName}${groupSuffix}`;
          if (nonEmptyRegionTags.has(regionTag)) {
            autoGroup.outbounds.push(regionTag);
          }
        });
      }
    });
  } else {
    const autoGroup = finalConfig.outbounds.find(o => o.tag === "♻️ 自动选择");
    if (autoGroup) {
      if (!autoGroup.outbounds) autoGroup.outbounds = [];
      classifiedGroups.regionList.forEach((regionName) => {
        if (nonEmptyRegionTags.has(regionName)) {
          autoGroup.outbounds.push(regionName);
        }
      });
    }
  }
  // ==========================================
  // E. 层级聚合逻辑：Level 3 包含 L1+L2, Level 4 包含 L1+L2+L3
  // ==========================================

  // 聚合 L3 (包含 L1 和 L2)
  outboundLevelMap.level3.forEach(l3Tag => {
    const group = finalConfig.outbounds.find(o => o.tag === l3Tag);
    if (group) {
      if (!group.outbounds) group.outbounds = [];
      const targets = [...outboundLevelMap.level1, ...outboundLevelMap.level2];
      targets.forEach(t => {
        if (!group.outbounds.includes(t)) group.outbounds.push(t);
      });
    }
  });

  // 聚合 L4 (包含 L1, L2 和 L3)
  outboundLevelMap.level4.forEach(l4Tag => {
    const group = finalConfig.outbounds.find(o => o.tag === l4Tag);
    if (group) {
      if (!group.outbounds) group.outbounds = [];
      const targets = [...outboundLevelMap.level1, ...outboundLevelMap.level2, ...outboundLevelMap.level3];
      targets.forEach(t => {
        if (!group.outbounds.includes(t)) group.outbounds.push(t);
      });
    }
  });

  // 置顶 🚀 默认代理
  const defaultProxyTag = "🚀 默认代理";
  const defaultProxyIndex = finalConfig.outbounds.findIndex(o => o.tag === defaultProxyTag);
  if (defaultProxyIndex > -1) {
    const [defaultProxy] = finalConfig.outbounds.splice(defaultProxyIndex, 1);
    finalConfig.outbounds.unshift(defaultProxy);
  }

  return finalConfig;
}
// 模拟测试逻辑
// 修正：node.json 已经是 Array<Array<Node>> 结构，直接使用即可

function getSessionId(request) {
  const cookieString = request.headers.get("Cookie") || "";
  const match = cookieString.match(/sub_session_id=([^;]+)/);
  if (!match) return null;

  const rawId = match[1];
  // Check if it's a timestamped ID (format: timestamp_uuid)
  if (rawId.includes("_")) {
    const [timestamp, uuid] = rawId.split("_");
    const ts = parseInt(timestamp);
    if (!isNaN(ts)) {
      // 3 Hours Expiry check
      if (Date.now() - ts > 24 * 60 * 60 * 1000) {
        console.log("Session expired (24h):", rawId);
        return null; // Expired
      }
    }
  }
  return rawId;
}
