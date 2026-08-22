import streamDeck, {
    action,
    DidReceiveSettingsEvent,
    KeyDownEvent,
    SingletonAction,
    WillAppearEvent,
    WillDisappearEvent
} from '@elgato/streamdeck';

import {
    fetchTokenSnapshot,
    positiveInteger,
    TokenSnapshot,
    TokenDeckSettings
} from '../codexbar';
import { renderTokenImage } from '../render';

const DEFAULT_REFRESH_SECONDS = 60;
const MIN_REFRESH_SECONDS = 15;
const DEFAULT_SWITCH_SECONDS = 10;
const MIN_SWITCH_SECONDS = 5;

const SWITCH_PROVIDERS = ['codex', 'opencode-go'] as const;
type SwitchProvider = typeof SWITCH_PROVIDERS[number];
type TokenKeyAction = KeyDownEvent<TokenDeckSettings>['action'];

@action({ UUID: 'com.leask.token-deck.usage' })
export class TokenUsageAction extends SingletonAction<TokenDeckSettings> {
    private readonly timers = new Map<string, NodeJS.Timeout>();
    private readonly rotationTimers = new Map<string, NodeJS.Timeout>();
    private readonly inFlight = new Set<string>();
    private readonly pendingManualRefresh = new Set<string>();
    private readonly snapshots = new Map<string, TokenSnapshot>();
    private readonly switchSnapshots = new Map<
        string,
        Map<SwitchProvider, TokenSnapshot>
    >();
    private readonly activeProviders = new Map<string, SwitchProvider>();

    override async onWillAppear(
        ev: WillAppearEvent<TokenDeckSettings>
    ): Promise<void> {
        if (!ev.action.isKey()) {
            return;
        }

        this.initializeSwitchState(ev.action.id, ev.payload.settings);
        await this.refresh(ev.action, ev.payload.settings, true);
        this.schedule(ev.action.id, ev.payload.settings);
        this.scheduleRotation(ev.action.id, ev.payload.settings);
    }

    override onWillDisappear(
        ev: WillDisappearEvent<TokenDeckSettings>
    ): void {
        this.clearTimer(ev.action.id);
        this.clearRotationTimer(ev.action.id);
        this.snapshots.delete(ev.action.id);
        this.switchSnapshots.delete(ev.action.id);
        this.activeProviders.delete(ev.action.id);
    }

    override async onDidReceiveSettings(
        ev: DidReceiveSettingsEvent<TokenDeckSettings>
    ): Promise<void> {
        if (!ev.action.isKey()) {
            return;
        }

        this.initializeSwitchState(ev.action.id, ev.payload.settings);
        await this.refresh(ev.action, ev.payload.settings, true);
        this.schedule(ev.action.id, ev.payload.settings);
        this.scheduleRotation(ev.action.id, ev.payload.settings);
    }

    override async onKeyDown(
        ev: KeyDownEvent<TokenDeckSettings>
    ): Promise<void> {
        if (!this.isSwitchMode(ev.payload.settings)) {
            await this.refresh(ev.action, ev.payload.settings, true, true);
            return;
        }

        this.toggleSwitchProvider(ev.action.id);
        const rendered = await this.renderActiveSwitchSnapshot(ev.action);
        if (!rendered) {
            await this.refresh(ev.action, ev.payload.settings, true, true);
        }
        this.scheduleRotation(ev.action.id, ev.payload.settings);
    }

    private schedule(actionId: string, settings: TokenDeckSettings): void {
        this.clearTimer(actionId);

        const refreshSeconds = Math.max(
            MIN_REFRESH_SECONDS,
            positiveInteger(
                settings.refreshIntervalSeconds,
                DEFAULT_REFRESH_SECONDS
            )
        );

        const timer = setInterval(() => {
            const action = this.actions.find((candidate) => {
                return candidate.id === actionId && candidate.isKey();
            });

            if (action?.isKey()) {
                void action.getSettings<TokenDeckSettings>()
                    .then((latestSettings) => {
                        return this.refresh(action, latestSettings, false);
                    })
                    .catch(() => action.showAlert());
            }
        }, refreshSeconds * 1000);

        this.timers.set(actionId, timer);
    }

    private scheduleRotation(
        actionId: string,
        settings: TokenDeckSettings
    ): void {
        this.clearRotationTimer(actionId);
        if (!this.isSwitchMode(settings)) {
            return;
        }

        const switchSeconds = Math.max(
            MIN_SWITCH_SECONDS,
            positiveInteger(
                settings.switchIntervalSeconds,
                DEFAULT_SWITCH_SECONDS
            )
        );

        const timer = setInterval(() => {
            const action = this.actions.find((candidate) => {
                return candidate.id === actionId && candidate.isKey();
            });
            if (!action?.isKey()) {
                return;
            }

            /*
             * Rotation is presentation-only. Do not call getSettings() here:
             * Stream Deck can answer that request with DidReceiveSettings,
             * which would trigger a real data refresh on every UI rotation.
             * Settings changes already reschedule this timer through
             * onDidReceiveSettings().
             */
            this.toggleSwitchProvider(actionId);
            void this.renderActiveSwitchSnapshot(action)
                .catch(() => action.showAlert());
        }, switchSeconds * 1000);

        this.rotationTimers.set(actionId, timer);
    }

    private clearTimer(actionId: string): void {
        const timer = this.timers.get(actionId);
        if (timer !== undefined) {
            clearInterval(timer);
            this.timers.delete(actionId);
        }
    }

    private clearRotationTimer(actionId: string): void {
        const timer = this.rotationTimers.get(actionId);
        if (timer !== undefined) {
            clearInterval(timer);
            this.rotationTimers.delete(actionId);
        }
    }

    private initializeSwitchState(
        actionId: string,
        settings: TokenDeckSettings
    ): void {
        if (!this.isSwitchMode(settings)) {
            this.activeProviders.delete(actionId);
            this.switchSnapshots.delete(actionId);
            return;
        }

        if (!this.activeProviders.has(actionId)) {
            this.activeProviders.set(actionId, 'codex');
        }
    }

    private isSwitchMode(settings: TokenDeckSettings): boolean {
        return settings.provider?.trim().toLowerCase() === 'switch';
    }

    private toggleSwitchProvider(actionId: string): void {
        const current = this.activeProviders.get(actionId) ?? 'codex';
        const next: SwitchProvider = current === 'codex'
            ? 'opencode-go'
            : 'codex';
        this.activeProviders.set(actionId, next);
        streamDeck.logger.info(
            `Token Deck provider switch: ${current} -> ${next}`
        );
    }

    private async refresh(
        action: TokenKeyAction,
        settings: TokenDeckSettings,
        showLoading: boolean,
        queueIfBusy = false
    ): Promise<void> {
        if (this.inFlight.has(action.id)) {
            if (queueIfBusy) {
                this.pendingManualRefresh.add(action.id);
                if (showLoading) {
                    await this.showRefreshIndicator(action);
                }
            }
            return;
        }

        this.inFlight.add(action.id);
        if (showLoading || this.snapshots.has(action.id)) {
            await this.showRefreshIndicator(action);
        }

        try {
            const snapshot = this.isSwitchMode(settings)
                ? await this.refreshSwitchSnapshots(action.id, settings)
                : await fetchTokenSnapshot(settings);

            this.snapshots.set(action.id, snapshot);
            streamDeck.logger.info(
                `Token Deck refresh: ${titleForSnapshot(snapshot)} `
                + `from ${snapshot.source}`
            );
            await action.setImage(renderTokenImage({
                status: 'ready',
                snapshot
            }));
            await action.setTitle('');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            streamDeck.logger.error(`Token Deck refresh failed: ${message}`);
            const previousSnapshot = this.snapshots.get(action.id);
            if (previousSnapshot !== undefined) {
                await action.setImage(renderTokenImage({
                    status: 'stale-error',
                    message,
                    snapshot: previousSnapshot
                }));
                await action.setTitle('');
                if (showLoading) {
                    await action.showAlert();
                }
                return;
            }

            await action.setImage(renderTokenImage({
                status: 'error',
                message
            }));
            await action.setTitle('');
            await action.showAlert();
        } finally {
            this.inFlight.delete(action.id);
            if (this.pendingManualRefresh.delete(action.id)) {
                await this.refreshLatestSettings(action);
            }
        }
    }

    private async refreshSwitchSnapshots(
        actionId: string,
        settings: TokenDeckSettings
    ): Promise<TokenSnapshot> {
        const cache = this.switchSnapshots.get(actionId)
            ?? new Map<SwitchProvider, TokenSnapshot>();

        const results = await Promise.allSettled(
            SWITCH_PROVIDERS.map(async (provider) => {
                const snapshot = await fetchTokenSnapshot({
                    ...settings,
                    provider,
                    mode: 'opencode'
                });
                return { provider, snapshot };
            })
        );

        const failures: string[] = [];
        for (const result of results) {
            if (result.status === 'fulfilled') {
                cache.set(result.value.provider, result.value.snapshot);
                continue;
            }

            failures.push(
                result.reason instanceof Error
                    ? result.reason.message
                    : String(result.reason)
            );
        }

        this.switchSnapshots.set(actionId, cache);
        if (cache.size === 0) {
            throw new Error(failures.join('; ') || 'OpenCode usage unavailable');
        }

        let active = this.activeProviders.get(actionId) ?? 'codex';
        if (!cache.has(active)) {
            active = SWITCH_PROVIDERS.find((provider) => cache.has(provider))
                ?? 'codex';
            this.activeProviders.set(actionId, active);
        }

        const snapshot = cache.get(active);
        if (snapshot === undefined) {
            throw new Error('OpenCode usage unavailable');
        }

        if (failures.length > 0) {
            streamDeck.logger.warn(
                `Token Deck partial OpenCode refresh: ${failures.join('; ')}`
            );
        }

        return snapshot;
    }

    private async renderActiveSwitchSnapshot(
        action: TokenKeyAction
    ): Promise<boolean> {
        const active = this.activeProviders.get(action.id) ?? 'codex';
        const snapshot = this.switchSnapshots.get(action.id)?.get(active);
        if (snapshot === undefined) {
            return false;
        }

        this.snapshots.set(action.id, snapshot);
        await action.setImage(renderTokenImage({
            status: 'ready',
            snapshot
        }));
        await action.setTitle('');
        return true;
    }

    private async showRefreshIndicator(
        action: TokenKeyAction
    ): Promise<void> {
        const snapshot = this.snapshots.get(action.id);
        if (snapshot === undefined) {
            await action.setImage(renderTokenImage({ status: 'loading' }));
            await action.setTitle('');
            return;
        }

        await action.setImage(renderTokenImage({
            status: 'refreshing',
            snapshot
        }));
        await action.setTitle('');
    }

    private async refreshLatestSettings(
        action: TokenKeyAction
    ): Promise<void> {
        try {
            const latestSettings = await action.getSettings<TokenDeckSettings>();
            await this.refresh(action, latestSettings, true);
        } catch {
            await action.showAlert();
        }
    }
}

function titleForSnapshot(snapshot: TokenSnapshot): string {
    const remaining = snapshot.primary?.remainingPercent;
    if (typeof remaining !== 'number') {
        return snapshot.provider.toUpperCase();
    }

    return `${Math.round(remaining)}%`;
}
