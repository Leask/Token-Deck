import { readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { RateWindow, TokenSnapshot } from './codexbar';

const OPENAI_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REQUEST_TIMEOUT_MS = 10_000;
const REFRESH_SKEW_MS = 60_000;

const AUTH_PATH = path.join(
    os.homedir(),
    '.local',
    'share',
    'opencode',
    'auth.json'
);

type OpenCodeOAuthCredential = {
    type: 'oauth';
    refresh: string;
    access: string;
    expires: number;
    accountId?: string;
};

type OpenCodeApiCredential = {
    type: 'api';
    key: string;
};

type OpenCodeAuthStore = Record<string, unknown>;

type OpenCodeAuthState = {
    store: OpenCodeAuthStore;
    writable: boolean;
};

type OpenAITokenResponse = {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
};

type OpenAIRateWindow = {
    used_percent?: number;
    limit_window_seconds?: number;
    reset_at?: number;
};

type OpenAIUsageResponse = {
    plan_type?: string;
    rate_limit?: {
        primary_window?: OpenAIRateWindow | null;
        secondary_window?: OpenAIRateWindow | null;
    };
};

type OpenCodeGoWindow = {
    status?: string;
    percent?: number;
    resetsAt?: string;
};

type OpenCodeGoUsageResponse = {
    usage?: {
        rolling?: OpenCodeGoWindow | null;
        weekly?: OpenCodeGoWindow | null;
        monthly?: OpenCodeGoWindow | null;
    };
};

export async function fetchOpenCodeSnapshot(
    provider: string
): Promise<TokenSnapshot> {
    switch (provider.trim().toLowerCase()) {
        case 'codex':
            return fetchCodexUsage();
        case 'opencode-go':
            return fetchOpenCodeGoUsage();
        default:
            throw new Error(`OpenCode provider not supported: ${provider}`);
    }
}

async function fetchCodexUsage(): Promise<TokenSnapshot> {
    let auth = await ensureOpenAICredential();
    let response = await requestOpenAIUsage(auth);

    if (response.status === 401 || response.status === 403) {
        auth = await ensureOpenAICredential(true);
        response = await requestOpenAIUsage(auth);
    }

    if (!response.ok) {
        throw new Error(`OpenAI usage HTTP ${response.status}`);
    }

    const data = await response.json() as OpenAIUsageResponse;
    return {
        provider: 'codex',
        source: 'opencode',
        updatedAt: new Date().toISOString(),
        accountLabel: data.plan_type
            ? `OpenCode OAuth · ${data.plan_type}`
            : 'OpenCode OAuth',
        primary: openAIWindow(data.rate_limit?.primary_window),
        secondary: openAIWindow(data.rate_limit?.secondary_window)
    };
}

async function fetchOpenCodeGoUsage(): Promise<TokenSnapshot> {
    const { store } = await readOpenCodeAuth();
    const auth = apiCredential(store['opencode-go']);
    if (auth === undefined) {
        throw new Error('OpenCode Go credential not found');
    }

    const response = await fetch(OPENCODE_GO_USAGE_URL, {
        headers: {
            Authorization: `Bearer ${auth.key}`,
            Accept: 'application/json',
            'User-Agent': 'Token-Deck'
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) {
        throw new Error(`OpenCode Go usage HTTP ${response.status}`);
    }

    const data = await response.json() as OpenCodeGoUsageResponse;
    if (data.usage === undefined) {
        throw new Error('OpenCode Go returned no usage block');
    }

    return {
        provider: 'opencode-go',
        source: 'opencode',
        updatedAt: new Date().toISOString(),
        accountLabel: 'OpenCode Go',
        primary: goWindow(data.usage.rolling, 300),
        secondary: goWindow(data.usage.weekly, 10080),
        tertiary: goWindow(data.usage.monthly, 43200)
    };
}

async function requestOpenAIUsage(
    auth: OpenCodeOAuthCredential
): Promise<Response> {
    if (!auth.accountId) {
        throw new Error('OpenCode OpenAI accountId is missing');
    }

    return fetch(OPENAI_USAGE_URL, {
        headers: {
            Authorization: `Bearer ${auth.access}`,
            'ChatGPT-Account-Id': auth.accountId,
            Accept: 'application/json',
            'User-Agent': 'Token-Deck'
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
}

async function ensureOpenAICredential(
    forceRefresh = false
): Promise<OpenCodeOAuthCredential> {
    const authState = await readOpenCodeAuth();
    const auth = oauthCredential(authState.store.openai);
    if (auth === undefined) {
        throw new Error('OpenCode OpenAI OAuth credential not found');
    }

    if (
        !forceRefresh
        && auth.access.length > 0
        && auth.expires > Date.now() + REFRESH_SKEW_MS
    ) {
        return auth;
    }

    if (!auth.refresh) {
        throw new Error('OpenCode OpenAI refresh token is missing');
    }

    const response = await fetch(OPENAI_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: auth.refresh,
            client_id: OPENAI_CLIENT_ID
        }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) {
        throw new Error(`OpenAI OAuth refresh HTTP ${response.status}`);
    }

    const tokens = await response.json() as OpenAITokenResponse;
    if (!tokens.access_token) {
        throw new Error('OpenAI OAuth refresh returned no access token');
    }

    const refreshed: OpenCodeOAuthCredential = {
        type: 'oauth',
        access: tokens.access_token,
        refresh: tokens.refresh_token ?? auth.refresh,
        expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        accountId:
            extractAccountId(tokens.id_token)
            ?? extractAccountId(tokens.access_token)
            ?? auth.accountId
    };

    if (authState.writable) {
        await saveOpenAICredential(refreshed);
    }

    return refreshed;
}

async function readOpenCodeAuth(): Promise<OpenCodeAuthState> {
    const inlineAuth = process.env.OPENCODE_AUTH_CONTENT;
    if (inlineAuth?.trim()) {
        return {
            store: parseAuthStore(inlineAuth),
            writable: false
        };
    }

    try {
        return {
            store: parseAuthStore(await readFile(AUTH_PATH, 'utf8')),
            writable: true
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Unable to read OpenCode auth store: ${message}`);
    }
}

async function saveOpenAICredential(
    credential: OpenCodeOAuthCredential
): Promise<void> {
    const latest = parseAuthStore(await readFile(AUTH_PATH, 'utf8'));
    latest.openai = credential;

    const temporary = `${AUTH_PATH}.token-deck-${process.pid}.tmp`;
    await writeFile(
        temporary,
        `${JSON.stringify(latest, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 }
    );
    await rename(temporary, AUTH_PATH);
}

function parseAuthStore(raw: string): OpenCodeAuthStore {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('OpenCode auth store is not an object');
    }

    return parsed as OpenCodeAuthStore;
}

function oauthCredential(value: unknown): OpenCodeOAuthCredential | undefined {
    if (value === null || typeof value !== 'object') {
        return undefined;
    }

    const candidate = value as Partial<OpenCodeOAuthCredential>;
    if (
        candidate.type !== 'oauth'
        || typeof candidate.access !== 'string'
        || typeof candidate.refresh !== 'string'
        || typeof candidate.expires !== 'number'
    ) {
        return undefined;
    }

    return candidate as OpenCodeOAuthCredential;
}

function apiCredential(value: unknown): OpenCodeApiCredential | undefined {
    if (value === null || typeof value !== 'object') {
        return undefined;
    }

    const candidate = value as Partial<OpenCodeApiCredential>;
    if (candidate.type !== 'api' || typeof candidate.key !== 'string') {
        return undefined;
    }

    return candidate as OpenCodeApiCredential;
}

function openAIWindow(
    window?: OpenAIRateWindow | null
): RateWindow | undefined {
    if (window === null || window === undefined || typeof window.used_percent !== 'number') {
        return undefined;
    }

    return normalizedWindow(
        window.used_percent,
        typeof window.limit_window_seconds === 'number'
            ? Math.round(window.limit_window_seconds / 60)
            : undefined,
        typeof window.reset_at === 'number'
            ? new Date(window.reset_at * 1000).toISOString()
            : undefined
    );
}

function goWindow(
    window: OpenCodeGoWindow | null | undefined,
    windowMinutes: number
): RateWindow | undefined {
    if (window === null || window === undefined || typeof window.percent !== 'number') {
        return undefined;
    }

    return normalizedWindow(
        window.percent,
        windowMinutes,
        window.resetsAt
    );
}

function normalizedWindow(
    used: number,
    windowMinutes?: number,
    resetsAt?: string
): RateWindow {
    const usedPercent = clamp(used, 0, 100);
    return {
        usedPercent,
        remainingPercent: clamp(100 - usedPercent, 0, 100),
        windowMinutes,
        resetsAt
    };
}

function extractAccountId(token?: string): string | undefined {
    if (!token) {
        return undefined;
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
        return undefined;
    }

    try {
        const claims = JSON.parse(
            Buffer.from(parts[1], 'base64url').toString('utf8')
        ) as {
            chatgpt_account_id?: string;
            organizations?: Array<{ id?: string }>;
            'https://api.openai.com/auth'?: {
                chatgpt_account_id?: string;
            };
        };

        return (
            claims.chatgpt_account_id
            ?? claims['https://api.openai.com/auth']?.chatgpt_account_id
            ?? claims.organizations?.[0]?.id
        );
    } catch {
        return undefined;
    }
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}
