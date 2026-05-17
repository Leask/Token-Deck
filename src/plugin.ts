import streamDeck from '@elgato/streamdeck';

import {
    CpuStatusAction,
    DiskStatusAction,
    GpuStatusAction,
    MemoryStatusAction,
    NetworkStatusAction
} from './actions/hardware-status';
import { TokenUsageAction } from './actions/token-usage';

streamDeck.logger.setLevel('info');
streamDeck.actions.registerAction(new TokenUsageAction());
streamDeck.actions.registerAction(new CpuStatusAction());
streamDeck.actions.registerAction(new MemoryStatusAction());
streamDeck.actions.registerAction(new DiskStatusAction());
streamDeck.actions.registerAction(new GpuStatusAction());
streamDeck.actions.registerAction(new NetworkStatusAction());
streamDeck.connect();
