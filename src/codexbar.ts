import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname } from 'node:path';
import { promisify } from 'node:util';

import type { JsonObject } from '@elgato/utils';

const execFileAsync = promisify(execFile);

const DEFAULT_PROVIDER = 'codex';
const DEFAULT_PORT = 8080;
const CODEXBAR_PATH_CANDIDATES = [
    '/opt/homebrew/bin/codexbar',
    '/usr/local/bin/codexbar',
    'codexbar'
];
const CHILD_PATH_ENTRIES = [
    '/opt/homebrew/opt/node/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
];
const HTTP_TIMEOUT_MS = 10_000;
const CLI_TIMEOUT_MS = 20_000;

export type TokenDeckSettings = JsonObject & {
    provider?: string;
    mode?: 'http' | 'cli';
    endpoint?: string;
    port?: number | string;
    codexbarPath?: string;
    refreshIntervalSeconds?: number | string;
};

export type RateWindow = {
    usedPercent: number;
    remainingPercent: number;
    windowMinutes?: number;
    resetsAt?: string;
    resetDescription?: string;
};

export type TokenSnapshot = {
    provider: string;
    source: string;
    version?: string;
    updatedAt?: string;
    accountLabel?: string;
    primary?: RateWindow;
    secondary?: RateWindow;
};

type RawRateWindow = {
    usedPercent?: number;
    windowMinutes?: number;
    resetsAt?: string;
    resetDescription?: string;
};

type RawUsage = {
    accountEmail?: string;
    loginMethod?: string;
    updatedAt?: string;
    primary?: RawRateWindow | null;
    secondary?: RawRateWindow | null;
};

type RawProviderPayload = {
    provider?: string;
    source?: string;
    version?: string;
    usage?: RawUsage;
    error?: {
        message?: string;
    } | string | null;
};

export async function fetchTokenSnapshot(
    settings: TokenDeckSettings
): Promise<TokenSnapshot> {
    const mode = normalizeMode(settings.mode);
    const provider = normalizeProvider(settings.provider);

    if (mode === 'http') {
        return normalizePayload(await fetchFromHTTP(settings, provider));
    }

    return normalizePayload(await fetchFromCLI(settings, provider));
}

async function fetchFromHTTP(
    settings: TokenDeckSettings,
    provider: string
): Promise<RawProviderPayload[]> {
    const endpoint = normalizeEndpoint(settings, provider);
    const response = await fetch(endpoint, {
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
    });

    if (!response.ok) {
        throw new Error(`CodexBar HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (!Array.isArray(payload)) {
        throw new Error('CodexBar HTTP returned non-array JSON');
    }

    return payload as RawProviderPayload[];
}

async function fetchFromCLI(
    settings: TokenDeckSettings,
    provider: string
): Promise<RawProviderPayload[]> {
    const codexbarPath = settings.codexbarPath?.trim()
        || defaultCodexbarPath();
    const args = [
        'usage',
        '--provider',
        provider,
        ...codexSourceArgs(provider),
        '--format',
        'json',
        '--json-only'
    ];

    try {
        const { stdout } = await execFileAsync(codexbarPath, args, {
            timeout: CLI_TIMEOUT_MS,
            env: codexbarEnv(codexbarPath),
            maxBuffer: 1024 * 1024 * 4
        });
        return parseJSONPayload(stdout);
    } catch (error) {
        const execError = error as NodeJS.ErrnoException & {
            stdout?: string;
            stderr?: string;
        };
        if (execError.stdout?.trim()) {
            return parseJSONPayload(execError.stdout);
        }

        throw new Error(execError.stderr?.trim() || execError.message);
    }
}

function normalizePayload(payload: RawProviderPayload[]): TokenSnapshot {
    const item = bestProviderPayload(payload)
        ?? payload[0];

    if (item === undefined) {
        throw new Error('CodexBar returned no providers');
    }

    if (item.error != null) {
        throw new Error(formatPayloadError(item.error));
    }

    const usage = item.usage;
    if (usage === undefined) {
        throw new Error('CodexBar returned no usage block');
    }

    return {
        provider: item.provider ?? DEFAULT_PROVIDER,
        source: item.source ?? 'unknown',
        version: item.version,
        updatedAt: usage.updatedAt,
        accountLabel: usage.loginMethod ?? usage.accountEmail,
        primary: normalizeWindow(usage.primary),
        secondary: normalizeWindow(usage.secondary)
    };
}

function bestProviderPayload(
    payload: RawProviderPayload[]
): RawProviderPayload | undefined {
    const usable = payload.filter((candidate) => {
        return candidate.error == null && candidate.usage !== undefined;
    });

    return usable.sort((left, right) => {
        return remainingPercent(left) - remainingPercent(right);
    })[0];
}

function remainingPercent(payload: RawProviderPayload): number {
    const used = payload.usage?.primary?.usedPercent;
    if (typeof used !== 'number') {
        return Number.POSITIVE_INFINITY;
    }

    return clamp(100 - used, 0, 100);
}

function normalizeWindow(window?: RawRateWindow | null): RateWindow | undefined {
    if (window == null || typeof window.usedPercent !== 'number') {
        return undefined;
    }

    const usedPercent = clamp(window.usedPercent, 0, 100);
    return {
        usedPercent,
        remainingPercent: clamp(100 - usedPercent, 0, 100),
        windowMinutes: window.windowMinutes,
        resetsAt: window.resetsAt,
        resetDescription: window.resetDescription
    };
}

function normalizeProvider(provider?: string): string {
    const normalized = provider?.trim().toLowerCase();
    return normalized || DEFAULT_PROVIDER;
}

function codexSourceArgs(provider: string): string[] {
    if (provider !== DEFAULT_PROVIDER) {
        return [];
    }

    return ['--source', 'cli'];
}

function normalizeMode(mode?: TokenDeckSettings['mode']): 'http' | 'cli' {
    if (mode === 'http') {
        return mode;
    }

    return 'cli';
}

function normalizeEndpoint(settings: TokenDeckSettings, provider: string): string {
    if (settings.endpoint?.trim()) {
        const url = new URL(settings.endpoint.trim());
        url.searchParams.set('provider', provider);
        return url.toString();
    }

    const port = positiveInteger(settings.port, DEFAULT_PORT);
    const url = new URL(`http://127.0.0.1:${port}/usage`);
    url.searchParams.set('provider', provider);
    return url.toString();
}

function defaultCodexbarPath(): string {
    return CODEXBAR_PATH_CANDIDATES.find((candidate) => {
        return candidate === 'codexbar' || existsSync(candidate);
    }) ?? 'codexbar';
}

function codexbarEnv(codexbarPath: string): NodeJS.ProcessEnv {
    return {
        ...process.env,
        PATH: childPath(codexbarPath)
    };
}

function childPath(codexbarPath: string): string {
    const entries = [
        process.env.PATH,
        pathDirectory(codexbarPath),
        ...CHILD_PATH_ENTRIES
    ];

    return uniquePathEntries(entries).join(delimiter);
}

function pathDirectory(path: string): string | undefined {
    if (!path.includes('/')) {
        return undefined;
    }

    return dirname(path);
}

function uniquePathEntries(
    entries: Array<string | undefined>
): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const entry of entries) {
        for (const part of entry?.split(delimiter) ?? []) {
            const trimmed = part.trim();
            if (trimmed.length === 0 || seen.has(trimmed)) {
                continue;
            }

            seen.add(trimmed);
            result.push(trimmed);
        }
    }

    return result;
}

export function positiveInteger(
    value: number | string | undefined,
    defaultValue: number
): number {
    const parsed = typeof value === 'string' ? Number(value) : value;
    if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed <= 0) {
        return defaultValue;
    }

    return Math.round(parsed);
}

function parseJSONPayload(raw: string): RawProviderPayload[] {
    for (let index = 0; index < raw.length; index += 1) {
        const char = raw[index];
        if (char !== '[' && char !== '{') {
            continue;
        }

        try {
            const parsed = JSON.parse(raw.slice(index));
            return Array.isArray(parsed) ? parsed : [parsed];
        } catch {
            // Keep scanning. Codex CLI notifications can be prepended to stdout.
        }
    }

    throw new Error('CodexBar did not emit JSON');
}

function formatPayloadError(error: RawProviderPayload['error']): string {
    if (typeof error === 'string') {
        return error;
    }

    return error?.message ?? 'CodexBar provider error';
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}
