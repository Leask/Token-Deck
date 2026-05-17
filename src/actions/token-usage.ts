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

@action({ UUID: 'com.leask.token-deck.usage' })
export class TokenUsageAction extends SingletonAction<TokenDeckSettings> {
    private readonly timers = new Map<string, NodeJS.Timeout>();
    private readonly inFlight = new Set<string>();
    private readonly pendingManualRefresh = new Set<string>();
    private readonly snapshots = new Map<string, TokenSnapshot>();

    override async onWillAppear(
        ev: WillAppearEvent<TokenDeckSettings>
    ): Promise<void> {
        if (!ev.action.isKey()) {
            return;
        }

        await this.refresh(ev.action, ev.payload.settings, true);
        this.schedule(ev.action.id, ev.payload.settings);
    }

    override onWillDisappear(
        ev: WillDisappearEvent<TokenDeckSettings>
    ): void {
        this.clearTimer(ev.action.id);
        this.snapshots.delete(ev.action.id);
    }

    override async onDidReceiveSettings(
        ev: DidReceiveSettingsEvent<TokenDeckSettings>
    ): Promise<void> {
        if (!ev.action.isKey()) {
            return;
        }

        await this.refresh(ev.action, ev.payload.settings, true);
        this.schedule(ev.action.id, ev.payload.settings);
    }

    override async onKeyDown(
        ev: KeyDownEvent<TokenDeckSettings>
    ): Promise<void> {
        await this.refresh(ev.action, ev.payload.settings, true, true);
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

    private clearTimer(actionId: string): void {
        const timer = this.timers.get(actionId);
        if (timer !== undefined) {
            clearInterval(timer);
            this.timers.delete(actionId);
        }
    }

    private async refresh(
        action: KeyDownEvent<TokenDeckSettings>['action'],
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
            const snapshot = await fetchTokenSnapshot(settings);
            this.snapshots.set(action.id, snapshot);
            streamDeck.logger.info(
                `Token Deck refresh: ${titleForSnapshot(snapshot)} `
                + `from ${snapshot.source}`
            );
            await action.setImage(renderTokenImage({
                status: 'ready',
                snapshot
            }));
            await action.setTitle(titleForSnapshot(snapshot));
            if (showLoading) {
                await action.showOk();
            }
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
                await action.setTitle(titleForSnapshot(previousSnapshot));
                if (showLoading) {
                    await action.showAlert();
                }
                return;
            }

            await action.setImage(renderTokenImage({
                status: 'error',
                message
            }));
            await action.setTitle('ERR');
            await action.showAlert();
        } finally {
            this.inFlight.delete(action.id);
            if (this.pendingManualRefresh.delete(action.id)) {
                await this.refreshLatestSettings(action);
            }
        }
    }

    private async showRefreshIndicator(
        action: KeyDownEvent<TokenDeckSettings>['action']
    ): Promise<void> {
        const snapshot = this.snapshots.get(action.id);
        if (snapshot === undefined) {
            await action.setImage(renderTokenImage({ status: 'loading' }));
            await action.setTitle('...');
            return;
        }

        await action.setImage(renderTokenImage({
            status: 'refreshing',
            snapshot
        }));
        await action.setTitle(titleForSnapshot(snapshot));
    }

    private async refreshLatestSettings(
        action: KeyDownEvent<TokenDeckSettings>['action']
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
