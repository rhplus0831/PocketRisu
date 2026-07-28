const dns = require('dns');
const net = require('net');
const { Agent, buildConnector } = require('undici');

const PROXY_TARGET_BLOCKED = 'PROXY_TARGET_BLOCKED';
const ERR_PROXY_TARGET_BLOCKED = 'ERR_PROXY_TARGET_BLOCKED';

class ProxyTargetBlockedError extends Error {
    constructor(reason) {
        super(reason);
        this.name = 'ProxyTargetBlockedError';
        this.code = PROXY_TARGET_BLOCKED;
        this.reason = reason;
    }
}

function normalizeIpLiteral(ip) {
    if (typeof ip !== 'string') return '';
    let normalized = ip.trim();
    if (normalized.startsWith('[') && normalized.endsWith(']')) {
        normalized = normalized.slice(1, -1);
    }
    const zoneIndex = normalized.indexOf('%');
    if (zoneIndex !== -1) {
        normalized = normalized.slice(0, zoneIndex);
    }
    return normalized.toLowerCase();
}

function ipv4ToNumber(ip) {
    const octets = ip.split('.').map(Number);
    return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function isBlockedIPv4(ip) {
    const value = ipv4ToNumber(ip);
    const first = value >>> 24;
    const second = (value >>> 16) & 0xff;
    const third = (value >>> 8) & 0xff;

    if (first === 0 || first === 10 || first === 127) return true;
    if (first === 100 && second >= 64 && second <= 127) return true;
    if (first === 169 && second === 254) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && second === 0 && (third === 0 || third === 2)) return true;
    if (first === 192 && second === 168) return true;
    if (first === 198 && (second === 18 || second === 19)) return true;
    if (first >= 224) return true;
    return value === 0xffffffff;
}

function ipv6ToBigInt(ip) {
    let normalized = ip;
    if (normalized.includes('.')) {
        const lastColon = normalized.lastIndexOf(':');
        const ipv4 = normalized.slice(lastColon + 1);
        const value = ipv4ToNumber(ipv4);
        normalized = `${normalized.slice(0, lastColon)}:${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
    }

    const halves = normalized.split('::');
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const omitted = 8 - left.length - right.length;
    const groups = halves.length === 2
        ? [...left, ...Array(omitted).fill('0'), ...right]
        : left;

    let value = 0n;
    for (const group of groups) {
        value = (value << 16n) | BigInt(`0x${group || '0'}`);
    }
    return value;
}

function embeddedIPv4(value) {
    return [
        Number((value >> 24n) & 0xffn),
        Number((value >> 16n) & 0xffn),
        Number((value >> 8n) & 0xffn),
        Number(value & 0xffn),
    ].join('.');
}

function isBlockedProxyAddress(ip) {
    const normalized = normalizeIpLiteral(ip);
    const family = net.isIP(normalized);
    if (family === 0) return true;
    if (family === 4) return isBlockedIPv4(normalized);

    const value = ipv6ToBigInt(normalized);
    if (value === 0n || value === 1n) return true;

    const upper96 = value >> 32n;
    // IPv4-compatible (::a.b.c.d), IPv4-mapped (::ffff:a.b.c.d), and
    // well-known NAT64 (64:ff9b::/96) forms inherit the IPv4 policy.
    if (upper96 === 0n || upper96 === 0xffffn || upper96 === 0x0064ff9b0000000000000000n) {
        return isBlockedIPv4(embeddedIPv4(value));
    }

    if ((value >> 121n) === 0x7en) return true; // fc00::/7
    if ((value >> 118n) === 0x3fan) return true; // fe80::/10
    if ((value >> 120n) === 0xffn) return true; // ff00::/8
    return false;
}

function normalizeProxyTargetUrl(raw) {
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        throw new ProxyTargetBlockedError('Invalid proxy target URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new ProxyTargetBlockedError('Only HTTP(S) proxy targets are allowed');
    }
    parsed.username = '';
    parsed.password = '';
    return parsed.href;
}

function isValidDnsHostname(hostname) {
    const withoutTrailingDot = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
    if (!withoutTrailingDot || withoutTrailingDot.length > 253) return false;
    const labels = withoutTrailingDot.split('.');
    if (/^\d+$/.test(labels[labels.length - 1])) return false;
    return labels.every((label) => (
        label.length <= 63
        && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
    ));
}

function createBlockedLookupError() {
    const error = new Error('Proxy target resolved to a blocked address');
    error.code = ERR_PROXY_TARGET_BLOCKED;
    return error;
}

function createProxyDispatcher({ isAddressBlocked = isBlockedProxyAddress } = {}) {
    const lookup = (hostname, options, callback) => {
        const lookupOptions = options && typeof options === 'object' ? options : {};
        const wantsAll = lookupOptions.all !== false;
        dns.lookup(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
            if (error) {
                callback(error);
                return;
            }
            if (!Array.isArray(addresses) || addresses.length === 0) {
                callback(new Error('Proxy target did not resolve to an address'));
                return;
            }
            if (addresses.some(({ address }) => isAddressBlocked(address))) {
                callback(createBlockedLookupError());
                return;
            }
            if (wantsAll) {
                callback(null, addresses);
            } else {
                callback(null, addresses[0].address, addresses[0].family);
            }
        });
    };
    const connectWithVettedLookup = buildConnector({ lookup });

    return new Agent({
        connect(options, callback) {
            // net.connect bypasses lookup for literal hosts, including literals
            // introduced by a redirect. Check that final connector input too.
            const hostname = normalizeIpLiteral(options.hostname);
            if (net.isIP(hostname) && isAddressBlocked(hostname)) {
                queueMicrotask(() => callback(createBlockedLookupError()));
                return;
            }
            return connectWithVettedLookup(options, callback);
        },
    });
}

let sharedProxyDispatcher;

function getSharedProxyDispatcher() {
    if (!sharedProxyDispatcher) {
        sharedProxyDispatcher = createProxyDispatcher();
    }
    return sharedProxyDispatcher;
}

function assertProxyTargetAllowed(raw, { enforceInternalBlock, dispatcher } = {}) {
    const url = normalizeProxyTargetUrl(raw);
    if (!enforceInternalBlock) {
        return { url, dispatcher: undefined };
    }

    const parsed = new URL(url);
    const hostname = normalizeIpLiteral(parsed.hostname);
    if (net.isIP(hostname)) {
        if (isBlockedProxyAddress(hostname)) {
            throw new ProxyTargetBlockedError('Internal or non-public proxy targets are not allowed');
        }
    } else if (!isValidDnsHostname(hostname)) {
        throw new ProxyTargetBlockedError('Proxy target hostname is invalid');
    }

    return { url, dispatcher: dispatcher || getSharedProxyDispatcher() };
}

function isProxyTargetBlockedError(error) {
    let current = error;
    for (let depth = 0; current && depth < 3; depth += 1) {
        if (current instanceof ProxyTargetBlockedError || current.code === PROXY_TARGET_BLOCKED) {
            return true;
        }
        if (current.code === ERR_PROXY_TARGET_BLOCKED) {
            return true;
        }
        current = current.cause;
    }
    return false;
}

function resolveHubProxyTarget({ pathHeader, originalUrl, hubURL }) {
    if (!pathHeader) {
        const pathAndQuery = originalUrl.replace(/^\/hub-proxy/, '');
        return hubURL + pathAndQuery;
    }
    if (typeof pathHeader !== 'string') {
        throw new ProxyTargetBlockedError('Hub proxy target header is invalid');
    }

    let decodedPath;
    try {
        decodedPath = decodeURIComponent(pathHeader);
    } catch {
        throw new ProxyTargetBlockedError('Hub proxy target header is invalid');
    }

    let configuredHub;
    let target;
    try {
        configuredHub = new URL(hubURL);
        target = new URL(decodedPath, configuredHub);
    } catch {
        throw new ProxyTargetBlockedError('Hub proxy target URL is invalid');
    }
    if (configuredHub.protocol !== 'https:' || target.protocol !== 'https:' || target.origin !== configuredHub.origin) {
        throw new ProxyTargetBlockedError('Hub proxy header target must use the configured hub origin');
    }
    target.username = '';
    target.password = '';
    return target.href;
}

module.exports = {
    ERR_PROXY_TARGET_BLOCKED,
    PROXY_TARGET_BLOCKED,
    ProxyTargetBlockedError,
    assertProxyTargetAllowed,
    createProxyDispatcher,
    isBlockedProxyAddress,
    isProxyTargetBlockedError,
    normalizeProxyTargetUrl,
    resolveHubProxyTarget,
};
