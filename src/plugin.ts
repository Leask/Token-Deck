import streamDeck from '@elgato/streamdeck';

import { TokenUsageAction } from './actions/token-usage';

streamDeck.logger.setLevel('info');
streamDeck.actions.registerAction(new TokenUsageAction());
streamDeck.connect();
