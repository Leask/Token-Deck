import streamDeck, {
    action,
    DidReceiveSettingsEvent,
    KeyDownEvent,
    SingletonAction,
    WillAppearEvent,
    WillDisappearEvent
} from '@elgato/streamdeck';
import type { JsonObject } from '@elgato/utils';

import {
    fetchHardwareSnapshot,
    HardwareMetric,
    HardwareSnapshot
} from '../hardware';
import { renderHardwareImage } from '../render-hardware';

type HardwareSettings = JsonObject & {
    refreshIntervalSeconds?: number | string;
};

const DEFAULT_REFRESH_SECONDS = 5;
const MIN_REFRESH_SECONDS = 2;

abstract class HardwareStatusAction extends SingletonAction<HardwareSettings> {
    private readonly timers = new Map<string, NodeJS.Timeout>();
    private readonly inFlight = new Set<string>();
    private readonly snapshots = new Map<string, HardwareSnapshot>();

    protected constructor(
        private readonly metric: HardwareMetric,
        private readonly label: string
    ) {
        super();
    }

    override async onWillAppear(
        ev: WillAppearEvent<HardwareSettings>
    ): Promise<void> {
        if (!ev.action.isKey()) {
            return;
        }

        await this.refresh(ev.action, ev.payload.settings, true);
        this.schedule(ev.action.id, ev.payload.settings);
    }

    override onWillDisappear(
        ev: WillDisappearEvent<HardwareSettings>
    ): void {
        this.clearTimer(ev.action.id);
        this.snapshots.delete(ev.action.id);
    }

    override async onDidReceiveSettings(
        ev: DidReceiveSettingsEvent<HardwareSettings>
    ): Promise<void> {
        if (!ev.action.isKey()) {
            return;
        }

        await this.refresh(ev.action, ev.payload.settings, true);
        this.schedule(ev.action.id, ev.payload.settings);
    }

    override async onKeyDown(
        ev: KeyDownEvent<HardwareSettings>
    ): Promise<void> {
        await this.refresh(ev.action, ev.payload.settings, true);
    }

    private schedule(actionId: string, settings: HardwareSettings): void {
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
                void action.getSettings<HardwareSettings>()
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
        action: KeyDownEvent<HardwareSettings>['action'],
        _settings: HardwareSettings,
        showLoading: boolean
    ): Promise<void> {
        if (this.inFlight.has(action.id)) {
            return;
        }

        this.inFlight.add(action.id);
        if (showLoading || this.snapshots.has(action.id)) {
            await this.showRefreshIndicator(action);
        }

        try {
            const snapshot = await fetchHardwareSnapshot(this.metric);
            this.snapshots.set(action.id, snapshot);
            streamDeck.logger.info(
                `Hardware refresh: ${snapshot.label} ${snapshot.value}`
            );
            await action.setImage(renderHardwareImage({
                status: 'ready',
                snapshot
            }));
            await action.setTitle('');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            streamDeck.logger.error(
                `Hardware refresh failed for ${this.metric}: ${message}`
            );
            await action.setImage(renderHardwareImage({
                status: 'error',
                label: this.label,
                message
            }));
            await action.setTitle('');
            if (showLoading) {
                await action.showAlert();
            }
        } finally {
            this.inFlight.delete(action.id);
        }
    }

    private async showRefreshIndicator(
        action: KeyDownEvent<HardwareSettings>['action']
    ): Promise<void> {
        const snapshot = this.snapshots.get(action.id);
        if (snapshot === undefined) {
            await action.setImage(renderHardwareImage({
                status: 'loading',
                label: this.label
            }));
            await action.setTitle('');
            return;
        }

        await action.setImage(renderHardwareImage({
            status: 'refreshing',
            snapshot
        }));
        await action.setTitle('');
    }
}

@action({ UUID: 'com.leask.token-deck.cpu' })
export class CpuStatusAction extends HardwareStatusAction {
    constructor() {
        super('cpu', 'CPU');
    }
}

@action({ UUID: 'com.leask.token-deck.memory' })
export class MemoryStatusAction extends HardwareStatusAction {
    constructor() {
        super('memory', 'MEM');
    }
}

@action({ UUID: 'com.leask.token-deck.disk' })
export class DiskStatusAction extends HardwareStatusAction {
    constructor() {
        super('disk', 'DISK');
    }
}

@action({ UUID: 'com.leask.token-deck.gpu' })
export class GpuStatusAction extends HardwareStatusAction {
    constructor() {
        super('gpu', 'GPU');
    }
}

@action({ UUID: 'com.leask.token-deck.network' })
export class NetworkStatusAction extends HardwareStatusAction {
    constructor() {
        super('network', 'NET');
    }
}

@action({ UUID: 'com.leask.token-deck.temperature' })
export class TemperatureStatusAction extends HardwareStatusAction {
    constructor() {
        super('temperature', 'TEMP');
    }
}

@action({ UUID: 'com.leask.token-deck.battery' })
export class BatteryStatusAction extends HardwareStatusAction {
    constructor() {
        super('battery', 'BATT');
    }
}

@action({ UUID: 'com.leask.token-deck.power' })
export class PowerStatusAction extends HardwareStatusAction {
    constructor() {
        super('power', 'PWR');
    }
}

function positiveInteger(
    value: number | string | undefined,
    defaultValue: number
): number {
    const parsed = typeof value === 'string' ? Number(value) : value;
    if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed <= 0) {
        return defaultValue;
    }

    return Math.round(parsed);
}
