import yaml from 'js-yaml';
import { CLASH_CONFIG, generateRules, generateClashRuleSets, getOutbounds, PREDEFINED_RULE_SETS, DIRECT_DEFAULT_RULES } from '../config/index.js';
import { BaseConfigBuilder } from './BaseConfigBuilder.js';
import { deepCopy, groupProxiesByCountry, buildCountryNameFilter } from '../utils.js';
import { addProxyWithDedup } from './helpers/proxyHelpers.js';
import { buildSelectorMembers, buildNodeSelectMembers, buildCustomRuleMembers, uniqueNames } from './helpers/groupBuilder.js';
import { emitClashRules, sanitizeClashProxyGroups } from './helpers/clashConfigUtils.js';
import { normalizeGroupName, findGroupIndexByName } from './helpers/groupNameUtils.js';
import { InvalidConfigError } from '../services/errors.js';

/**
 * Check if the client supports MRS (Meta Rule Set) format
 * MRS is a binary format supported by Clash Meta/mihomo
 * Legacy Clash clients need YAML format instead
 * @param {string} userAgent - Client User-Agent string
 * @returns {boolean} - True if client supports MRS format
 */
function supportsMrsFormat(userAgent) {
    if (!userAgent) return true; // Default to mrs for unknown clients
    const ua = userAgent.toLowerCase();
    
    // Clients confirmed to support MRS format (Clash Meta/mihomo based)
    if (ua.includes('mihomo') || 
        ua.includes('meta') ||           // clash.meta, clashx meta, meta-for-android, etc.
        ua.includes('clash-verge') ||
        ua.includes('stash') ||
        ua.includes('verge')) {
        return true;
    }
    
    // Legacy clients that don't support MRS format
    if (ua.includes('merlin') ||
        ua.includes('clashforwindows') ||
        ua.includes('clashforandroid') ||
        ua.includes('clash/')) {         // 老版本Clash核心 (Clash/v1.x.x)
        return false;
    }
    
    // Default: use mrs for unknown clients (most modern clients support it)
    return true;
}

function getClashUdpValue(proxy, defaultEnabled = true) {
    if (typeof proxy?.udp !== 'undefined') {
        return proxy.udp;
    }
    return defaultEnabled;
}

export class ClashConfigBuilder extends BaseConfigBuilder {
    constructor(inputString, selectedRules, customRules, baseConfig, lang, userAgent, groupByCountry = false, enableClashUI = false, externalController, externalUiDownloadUrl, includeAutoSelect = true) {
        if (!baseConfig) {
            baseConfig = CLASH_CONFIG;
        }
        super(inputString, baseConfig, lang, userAgent, groupByCountry, includeAutoSelect);
        this.selectedRules = selectedRules;
        this.customRules = customRules;
        this.countryGroupNames = [];
        this.manualGroupName = null;
        this.enableClashUI = enableClashUI;
        this.externalController = externalController;
        this.externalUiDownloadUrl = externalUiDownloadUrl;
    }

    /**
     * Check if subscription format is compatible for use as Clash proxy-provider
     * @param {'clash'|'singbox'|'unknown'} format - Detected subscription format
     * @returns {boolean} - True if format is Clash YAML
     */
    isCompatibleProviderFormat(format) {
        return format === 'clash';
    }

    /**
     * Generate proxy-providers configuration from collected URLs
     * @returns {object} - proxy-providers object
     */
    generateProxyProviders() {
        const providers = {};
        const existingProviders = this.getExistingProviderNames();
        this.getAutoProviderDescriptors(existingProviders).forEach(({ name, url }) => {
            providers[name] = {
                type: 'http',
                url: url,
                path: `./proxy_providers/${name}.yaml`,
                interval: 3600,
                'health-check': {
                    enable: true,
                    url: 'https://www.gstatic.com/generate_204',
                    interval: 300,
                    timeout: 5000,
                    lazy: true
                }
            };
        });
        return providers;
    }

    /**
     * Get list of provider names
     * @returns {string[]} - Array of provider names
     */
    getProviderNames() {
        return this.getAutoProviderDescriptors(this.getExistingProviderNames()).map(provider => provider.name);
    }

    getExistingProviderNames() {
        return this.config?.['proxy-providers'] && typeof this.config['proxy-providers'] === 'object'
            ? Object.keys(this.config['proxy-providers'])
            : [];
    }

    /**
     * Get all provider names (user-defined + auto-generated)
     * @returns {string[]} - Array of provider names
     */
    getAllProviderNames() {
        const existingProviders = this.getExistingProviderNames();
        const autoProviders = this.getProviderNames();
        return [...new Set([...existingProviders, ...autoProviders])];
    }

    getProxies() {
        return this.config.proxies || [];
    }

    getProxyName(proxy) {
        return proxy.name;
    }

    convertProxy(proxy) {
        switch (proxy.type) {
            case 'shadowsocks':
                return {
                    name: proxy.tag,
                    type: 'ss',
                    server: proxy.server,
                    port: proxy.server_port,
                    cipher: proxy.method,
                    password: proxy.password,
                    udp: getClashUdpValue(proxy),
                    ...(proxy.plugin ? { plugin: proxy.plugin } : {}),
                    ...(proxy.plugin_opts ? { 'plugin-opts': proxy.plugin_opts } : {})
                };
            case 'vmess':
                return {
                    name: proxy.tag,
                    type: proxy.type,
                    server: proxy.server,
                    port: proxy.server_port,
                    uuid: proxy.uuid,
                    alterId: proxy.alter_id ?? 0,
                    cipher: proxy.security,
                    tls: proxy.tls?.enabled || false,
                    servername: proxy.tls?.server_name || '',
                    'skip-cert-verify': !!proxy.tls?.insecure,
                    network: proxy.transport?.type || proxy.network || 'tcp',
                    'ws-opts': proxy.transport?.type === 'ws'
                        ? {
                            path: proxy.transport.path,
                            headers: proxy.transport.headers
                        }
                        : undefined,
                    'http-opts': proxy.transport?.type === 'http'
                        ? (() => {
                            const opts = {
                                method: proxy.transport.method || 'GET',
                                path: Array.isArray(proxy.transport.path) ? proxy.transport.path : [proxy.transport.path || '/'],
                            };
                            if (proxy.transport.headers && Object.keys(proxy.transport.headers).length > 0) {
                                opts.headers = proxy.transport.headers;
                            }
                            return opts;
                        })()
                        : undefined,
                    'grpc-opts': proxy.transport?.type === 'grpc'
                        ? {
                            'grpc-service-name': proxy.transport.service_name
                        }
                        : undefined,
                    'h2-opts': proxy.transport?.type === 'h2'
                        ? {
                            path: proxy.transport.path,
                            host: proxy.transport.host
                        }
                        : undefined,
                    udp: getClashUdpValue(proxy)
                };
            case 'vless':
                return {
                    name: proxy.tag,
                    type: proxy.type,
                    server: proxy.server,
                    port: proxy.server_port,
                    uuid: proxy.uuid,
                    cipher: proxy.security,
                    tls: proxy.tls?.enabled || false,
                    'client-fingerprint': proxy.tls?.utls?.fingerprint,
                    servername: proxy.tls?.server_name || '',
                    network: proxy.transport?.type || 'tcp',
                    'ws-opts': proxy.transport?.type === 'ws' ? {
                        path: proxy.transport.path,
                        headers: proxy.transport.headers
                    } : undefined,
                    'reality-opts': proxy.tls?.reality?.enabled ? {
                        'public-key': proxy.tls.reality.public_key,
                        'short-id': proxy.tls.reality.short_id,
                    } : undefined,
                    'grpc-opts': proxy.transport?.type === 'grpc' ? {
                        'grpc-service-name': proxy.transport.service_name,
                    } : undefined,
                    tfo: proxy.tcp_fast_open,
                    'skip-cert-verify': !!proxy.tls?.insecure,
                    udp: getClashUdpValue(proxy),
                    ...(proxy.alpn ? { alpn: proxy.alpn } : {}),
                    ...(proxy.packet_encoding ? { 'packet-encoding': proxy.packet_encoding } : {}),
                    'flow': proxy.flow ?? undefined,
                };
            case 'hysteria2':
                return {
                    name: proxy.tag,
                    type: proxy.type,
                    server: proxy.server,
                    port: proxy.server_port,
                    ...(proxy.ports ? { ports: proxy.ports } : {}),
                    obfs: proxy.obfs?.type,
                    'obfs-password': proxy.obfs?.password,
                    password: proxy.password,
                    auth: proxy.auth,
                    up: proxy.up,
                    down: proxy.down,
                    'recv-window-conn': proxy.recv_window_conn,
                    sni: proxy.tls?.server_name || '',
                    'skip-cert-verify': !!proxy.tls?.insecure,
                    ...(proxy.hop_interval !== undefined ? { 'hop-interval': proxy.hop_interval } : {}),
                    ...(proxy.alpn ? { alpn: proxy.alpn } : {}),
                    ...(proxy.fast_open !== undefined ? { 'fast-open': proxy.fast_open } : {}),
                };
            case 'trojan':
                return {
                    name: proxy.tag,
                    type: proxy.type,
                    server: proxy.server,
                    port: proxy.server_port,
                    password: proxy.password,
                    cipher: proxy.security,
                    tls: proxy.tls?.enabled || false,
                    'client-fingerprint': proxy.tls?.utls?.fingerprint,
                    sni: proxy.tls?.server_name || '',
                    network: proxy.transport?.type || 'tcp',
                    'ws-opts': proxy.transport?.type === 'ws' ? {
                        path: proxy.transport.path,
                        headers: proxy.transport.headers
                    } : undefined,
                    'reality-opts': proxy.tls?.reality?.enabled ? {
                        'public-key': proxy.tls.reality.public_key,
                        'short-id': proxy.tls.reality.short_id,
                    } : undefined,
                    'grpc-opts': proxy.transport?.type === 'grpc' ? {
                        'grpc-service-name': proxy.transport.service_name,
                    } : undefined,
                    tfo: proxy.tcp_fast_open,
                    'skip-cert-verify': !!proxy.tls?.insecure,
                    ...(proxy.alpn ? { alpn: proxy.alpn } : {}),
                    'flow': proxy.flow ?? undefined,
                    udp: getClashUdpValue(proxy),
                };
            case 'tuic':
                return {
                    name: proxy.tag,
                    type: proxy.type,
                    server: proxy.server,
                    port: proxy.server_port,
                    uuid: proxy.uuid,
                    password: proxy.password,
                    'congestion-controller': proxy.congestion_control,
                    'skip-cert-verify': !!proxy.tls?.insecure,
                    ...(proxy.disable_sni !== undefined ? { 'disable-sni': proxy.disable_sni } : {}),
                    ...(proxy.tls?.alpn ? { alpn: proxy.tls.alpn } : {}),
                    'sni': proxy.tls?.server_name,
                    'udp-relay-mode': proxy.udp_relay_mode || 'native',
                    ...(proxy.zero_rtt !== undefined ? { 'zero-rtt': proxy.zero_rtt } : {}),
                    ...(proxy.reduce_rtt !== undefined ? { 'reduce-rtt': proxy.reduce_rtt } : {}),
                    ...(proxy.fast_open !== undefined ? { 'fast-open': proxy.fast_open } : {}),
                };
            case 'anytls': {
                const idleSessionCheckInterval = proxy['idle-session-check-interval'] ?? proxy.idle_session_check_interval;
                const idleSessionTimeout = proxy['idle-session-timeout'] ?? proxy.idle_session_timeout;
                const minIdleSession = proxy['min-idle-session'] ?? proxy.min_idle_session;
                return {
                    name: proxy.tag,
                    type: 'anytls',
                    server: proxy.server,
                    port: proxy.server_port,
                    password: proxy.password,
                    udp: getClashUdpValue(proxy),
                    ...(proxy.tls?.utls?.fingerprint ? { 'client-fingerprint': proxy.tls.utls.fingerprint } : {}),
                    ...(proxy.tls?.server_name ? { sni: proxy.tls.server_name } : {}),
                    ...(proxy.tls?.insecure !== undefined ? { 'skip-cert-verify': !!proxy.tls.insecure } : {}),
                    ...(proxy.tls?.alpn ? { alpn: proxy.tls.alpn } : {}),
                    ...(idleSessionCheckInterval !== undefined ? { 'idle-session-check-interval': idleSessionCheckInterval } : {}),
                    ...(idleSessionTimeout !== undefined ? { 'idle-session-timeout': idleSessionTimeout } : {}),
                    ...(minIdleSession !== undefined ? { 'min-idle-session': minIdleSession } : {}),
                };
            }
            default:
                return proxy; // Return as-is if no specific conversion is defined
        }
    }

    addProxyToConfig(proxy) {
        this.config.proxies = this.config.proxies || [];
        addProxyWithDedup(this.config.proxies, proxy, {
            getName: (item) => item?.name,
            setName: (item, name) => {
                if (item) item.name = name;
            },
            isSame: (a = {}, b = {}) => {
                const { name: _name, ...restOfProxy } = b;
                const { name: __name, ...restOfExisting } = a;
                return JSON.stringify(restOfProxy) === JSON.stringify(restOfExisting);
            }
        });
    }

    hasProxyGroup(name) {
        const target = normalizeGroupName(name);
        return (this.config['proxy-groups'] || []).some(group => group && normalizeGroupName(group.name) === target);
    }

    hasSelectableSources(proxyList = []) {
        return uniqueNames(proxyList).length > 0 || this.getAllProviderNames().length > 0;
    }

    shouldIncludeAutoSelectGroup(proxyList = []) {
        return this.includeAutoSelect && this.hasSelectableSources(proxyList);
    }

    addAutoSelectGroup(proxyList) {
    }

    addNodeSelectGroup(proxyList) {
    }

    buildSelectGroupMembers(proxyList = []) {
        return buildSelectorMembers({
            proxyList,
            translator: this.t,
            groupByCountry: this.groupByCountry,
            manualGroupName: this.manualGroupName,
            countryGroupNames: this.countryGroupNames,
            includeAutoSelect: this.shouldIncludeAutoSelectGroup(proxyList)
        });
    }

    addOutboundGroups(outbounds, proxyList) {
    }

    addCustomRuleGroups(proxyList) {
    }

    addFallBackGroup(proxyList) {
    }

    addCountryGroups() {
        const proxies = this.getProxies();
        const countryGroups = groupProxiesByCountry(proxies, {
            getName: proxy => this.getProxyName(proxy)
        });

        // Provider mode leaves no inline proxies, but mihomo can filter provider
        // members per group (`use` + `filter`), so enumerate countries from the
        // names collected at fetch time and reference the providers instead.
        const providerNames = this.getAllProviderNames();
        if (providerNames.length > 0 && this.providerNodeNames.length > 0) {
            const providerCountryGroups = groupProxiesByCountry(this.providerNodeNames, {
                getName: name => name
            });
            Object.keys(providerCountryGroups).forEach(country => {
                if (!countryGroups[country]) {
                    countryGroups[country] = { ...providerCountryGroups[country], proxies: [] };
                }
            });
        }

        const existingNames = new Set((this.config['proxy-groups'] || []).map(g => normalizeGroupName(g?.name)).filter(Boolean));

        const manualProxyNames = proxies.map(p => p?.name).filter(Boolean);
        const manualGroupName = manualProxyNames.length > 0 ? this.t('outboundNames.Manual Switch') : null;
        if (manualGroupName) {
            const manualNorm = normalizeGroupName(manualGroupName);
            if (!existingNames.has(manualNorm)) {
                const group = {
                    name: manualGroupName,
                    type: 'select',
                    proxies: manualProxyNames
                };
                // Add 'use' field if we have proxy-providers
                const providerNames = this.getAllProviderNames();
                if (providerNames.length > 0) {
                    group.use = providerNames;
                }
                this.config['proxy-groups'].push(group);
                existingNames.add(manualNorm);
            }
        }

        const countries = Object.keys(countryGroups).sort((a, b) => a.localeCompare(b));
        const countryGroupNames = [];

        countries.forEach(country => {
            const { emoji, name, aliases, proxies } = countryGroups[country];
            const groupName = `${emoji} ${name}`;
            const norm = normalizeGroupName(groupName);
            if (!existingNames.has(norm)) {
                const group = {
                    name: groupName,
                    type: 'url-test',
                    proxies: proxies,
                    url: 'https://www.gstatic.com/generate_204',
                    interval: 300,
                    lazy: false
                };
                // Add 'use' field if we have proxy-providers, narrowed to this
                // country so provider members don't leak into every group
                if (providerNames.length > 0) {
                    group.use = providerNames;
                    const filter = buildCountryNameFilter({ emoji, aliases });
                    if (filter) {
                        group.filter = filter;
                    }
                }
                this.config['proxy-groups'].push(group);
                existingNames.add(norm);
            }
            countryGroupNames.push(groupName);
        });

        const nodeSelectGroup = this.config['proxy-groups'].find(g => g && g.name === this.t('outboundNames.Node Select'));
        if (nodeSelectGroup && Array.isArray(nodeSelectGroup.proxies)) {
            const rebuilt = buildNodeSelectMembers({
                proxyList: [],
                translator: this.t,
                groupByCountry: true,
                manualGroupName,
                countryGroupNames,
                includeAutoSelect: this.shouldIncludeAutoSelectGroup(this.getProxyList())
            });
            nodeSelectGroup.proxies = rebuilt;
        }
        this.countryGroupNames = countryGroupNames;
        this.manualGroupName = manualGroupName;
    }

    /**
     * Merge user-defined proxy groups with system-generated ones
     * Handles same-name groups by merging proxies/use fields and preserving user settings
     * @param {Array} userGroups - User-defined proxy groups from input config
     */
    mergeUserProxyGroups(userGroups) {
        if (!Array.isArray(userGroups)) return;

        const proxyList = this.getProxyList();
        const allProviderNames = new Set(this.getAllProviderNames());

        // Build valid reference set (proxies, groups, special names)
        const groupNames = new Set(
            (this.config['proxy-groups'] || [])
                .map(g => normalizeGroupName(g?.name))
                .filter(Boolean)
        );
        const validRefs = new Set(['DIRECT', 'REJECT']);
        proxyList.forEach(n => validRefs.add(n));
        groupNames.forEach(n => validRefs.add(n));

        userGroups.forEach(userGroup => {
            if (!userGroup?.name) return;

            const existingIndex = findGroupIndexByName(
                this.config['proxy-groups'],
                userGroup.name
            );

            if (existingIndex >= 0) {
                // Merge with existing system group
                const existing = this.config['proxy-groups'][existingIndex];

                // Merge 'use' field (provider references)
                if (Array.isArray(userGroup.use) && userGroup.use.length > 0) {
                    const validUserProviders = userGroup.use.filter(p => allProviderNames.has(p));
                    existing.use = [...new Set([
                        ...(existing.use || []),
                        ...validUserProviders
                    ])];
                }

                // Merge 'proxies' field - validate references first
                if (Array.isArray(userGroup.proxies)) {
                    const validUserProxies = userGroup.proxies.filter(p => validRefs.has(p));
                    existing.proxies = [...new Set([
                        ...(existing.proxies || []),
                        ...validUserProxies
                    ])];
                }

                // Preserve user's custom settings (url, interval)
                if (userGroup.url) existing.url = userGroup.url;
                if (typeof userGroup.interval === 'number') existing.interval = userGroup.interval;
                if (typeof userGroup.lazy === 'boolean') existing.lazy = userGroup.lazy;
            } else {
                // New user-defined group - validate and add
                const newGroup = { ...userGroup };

                // Validate proxies references
                if (Array.isArray(newGroup.proxies)) {
                    newGroup.proxies = newGroup.proxies.filter(p => validRefs.has(p));
                }

                // Validate use (provider) references
                if (Array.isArray(newGroup.use)) {
                    newGroup.use = newGroup.use.filter(p => allProviderNames.has(p));
                }

                if ((newGroup.proxies?.length > 0) || (newGroup.use?.length > 0) || newGroup.type) {
                    this.config['proxy-groups'].push(newGroup);
                }
            }
        });
    }

    /**
     * Reject invalid proxy groups before final output.
     * Why: empty groups make Clash reject the whole config, so we should fail fast
     * instead of masking the upstream merge/parsing problem.
     */
    validateProxyGroups() {
        // 1. 提取全局静态真实节点名字和提前拉取好的订阅源节点名字
        const staticNodeNames = (this.config.proxies || []).map(p => p?.name).filter(Boolean);
        const providerNodeNames = Array.isArray(this.providerNodeNames) ? this.providerNodeNames : [];
        
        // 合并成一个完整的目标节点池，供 include-all 模拟过滤
        const totalAllNodeNames = [...staticNodeNames, ...providerNodeNames];
    
        const totalProviders = this.config['proxy-providers'] && typeof this.config['proxy-providers'] === 'object'
            ? Object.keys(this.config['proxy-providers'])
            : [];
    
        // 2. 遍历检查每一个策略组
        this.config['proxy-groups'] = (this.config['proxy-groups'] || []).filter(group => {
            // url-test 和 fallback 类型必须有节点，select 等类型如果不强制要求也可以通过此规则防空
            const requiresMembers = group?.type === 'url-test' || group?.type === 'fallback'; //
            if (!requiresMembers) {
                //return; //手动注释，不需要类型判断组
            }
    
            // 2. 检查组内显式填写的引用
            const hasProxyRefs = Array.isArray(group.proxies) && group.proxies.length > 0; //
            const hasProviderRefs = Array.isArray(group.use) && group.use.length > 0; //
            if (hasProxyRefs || hasProviderRefs) {
                return true; //手动注释，不需要类型判断组
            }
    
            // 3. 针对 include-all: true 的高级复合判定
            if (group?.['include-all'] === true) {
                // 场景 A：如果节点池里有任意节点（静态或订阅源），模拟 filter 规则，验证过滤后是否还剩有节点
                if (totalAllNodeNames.length > 0) {
                    let filterRegex = null;
                    let excludeRegex = null;
    
                    // 安全解析包含/排除正则表达式
                    try {
                        if (group.filter) filterRegex = new RegExp(group.filter);
                        if (group['exclude-filter']) excludeRegex = new RegExp(group['exclude-filter']);
                    } catch (e) {
                        throw new InvalidConfigError(
                            `Invalid regex filter in proxy group "${group?.name || '(unnamed group)'}": ${e.message}`
                        );
                    }
    
                    // 模拟内核：过滤整个节点池（包含静态节点 + 订阅源节点）
                    const matchedNodes = totalAllNodeNames.filter(nodeName => {
                        if (filterRegex && !filterRegex.test(nodeName)) return false;
                        if (excludeRegex && excludeRegex.test(nodeName)) return false;
                        return true;
                    });
    
                    // 核心卡点：如果过滤后一个节点都不剩了...
                    if (matchedNodes.length === 0) {
                        // 连可疑的外部 proxy-providers 也没有，或者连提供者名字都没有匹配上，100% 为空，直接报错
                        if (totalProviders.length === 0) {
    						return false; //手动添加的
                            const groupName = group?.name || '(unnamed group)';
                            throw new InvalidConfigError(
                                `Invalid proxy group "${groupName}": type "${group.type}" with include-all resulted in 0 matching nodes after applying filters.`
                            );
                        }
                        // 如果有外部订阅源，但由于某些原因拉取日志为空（比如某次临时网络卡顿导致 this.providerNodeNames 没拿到数据），
                        // 为了防止单次外部网络阻断导致整个 Cloudflare Worker 挂掉，我们选择信任订阅源，放行让内核在客户端运行时去动态匹配。
                    } else {
                        // 过滤后还有剩余有效节点，安全放行当前组
                        return true;
                    }
                } 
    			
    			// 场景 B：完全没有静态节点，且没拉到任何订阅源节点，但有订阅源配置。放行靠内核运行时拉取，放行。
                if (totalProviders.length > 0) {
                    //return true; //手动注释，不需要类型判断组
                }
            }
    
            // 4. 前面 include-all 校验没通过，所有合规来源均为空时的兜底报错
    		return false; //手动添加的
            const groupName = group?.name || '(unnamed group)'; //
            throw new InvalidConfigError( //
                `Invalid proxy group "${groupName}": type "${group.type}" requires at least one proxy/provider reference, or valid non-empty matching nodes via include-all.`
            );
        });
    }

    // 生成规则
    generateRules() {
        return generateRules(this.selectedRules, this.customRules);
    }

    formatConfig() {
        const rules = this.generateRules();
        const useMrs = supportsMrsFormat(this.userAgent);
        const { site_rule_providers, ip_rule_providers } = generateClashRuleSets(this.selectedRules, this.customRules, useMrs);
        this.config['rule-providers'] = {
            ...site_rule_providers,
            ...ip_rule_providers
        };
        const ruleResults = emitClashRules(rules, this.t);

        // Add proxy-providers if we have any
        if (this.providerUrls.length > 0) {
            this.config['proxy-providers'] = {
                ...this.config['proxy-providers'],
                ...this.generateProxyProviders()
            };
        }

        sanitizeClashProxyGroups(this.config);
        this.validateProxyGroups();

        this.config.rules = [
            ...ruleResults,
            `MATCH,${this.t('outboundNames.Fall Back')}`
        ];

        // Enable Clash UI (external controller/dashboard) when requested or when custom UI params are provided
        if (this.enableClashUI || this.externalController || this.externalUiDownloadUrl) {
            const defaultController = '0.0.0.0:9090';
            const defaultUiPath = './ui';
            const defaultUiName = 'zashboard';
            const defaultUiUrl = 'https://gh-proxy.com/https://github.com/Zephyruso/zashboard/archive/refs/heads/gh-pages.zip';
            const defaultSecret = '';

            const controller = this.externalController || this.config['external-controller'] || defaultController;
            const uiPath = this.config['external-ui'] || defaultUiPath;
            const uiName = this.config['external-ui-name'] || defaultUiName;
            const uiUrl = this.externalUiDownloadUrl || this.config['external-ui-url'] || defaultUiUrl;
            const secret = this.config['secret'] ?? defaultSecret;

            this.config['external-controller'] = controller;
            this.config['external-ui'] = uiPath;
            this.config['external-ui-name'] = uiName;
            this.config['external-ui-url'] = uiUrl;
            this.config['secret'] = secret;
        }

        return yaml.dump(this.config);
    }
}
