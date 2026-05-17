import streamDeck from '@elgato/streamdeck';

import {
    BatteryStatusAction,
    CpuStatusAction,
    DiskStatusAction,
    GpuStatusAction,
    MemoryStatusAction,
    NetworkStatusAction,
    PowerStatusAction,
    TemperatureStatusAction
} from './actions/hardware-status';
import { TokenUsageAction } from './actions/token-usage';

streamDeck.logger.setLevel('info');
streamDeck.actions.registerAction(new TokenUsageAction());
streamDeck.actions.registerAction(new CpuStatusAction());
streamDeck.actions.registerAction(new MemoryStatusAction());
streamDeck.actions.registerAction(new DiskStatusAction());
streamDeck.actions.registerAction(new GpuStatusAction());
streamDeck.actions.registerAction(new NetworkStatusAction());
streamDeck.actions.registerAction(new TemperatureStatusAction());
streamDeck.actions.registerAction(new BatteryStatusAction());
streamDeck.actions.registerAction(new PowerStatusAction());
streamDeck.connect();
