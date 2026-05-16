import { RateWindow, TokenSnapshot } from './codexbar';

type RenderState =
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; snapshot: TokenSnapshot };

export function renderTokenImage(state: RenderState): string {
    if (state.status === 'loading') {
        return baseSVG([
            text(72, 62, 'Token', 22, '#ffffff', '700'),
            text(72, 90, 'Loading', 15, '#aab3c5')
        ]);
    }

    if (state.status === 'error') {
        return baseSVG([
            text(72, 38, 'Token', 20, '#ffffff', '700'),
            text(72, 68, 'Error', 26, '#ff6b6b', '800'),
            text(72, 98, compactError(state.message), 12, '#d9deea')
        ]);
    }

    const { snapshot } = state;
    const primary = snapshot.primary;
    const secondary = snapshot.secondary;
    const remaining = Math.round(primary?.remainingPercent ?? 0);
    const accent = colorForRemaining(remaining);
    const reset = resetText(primary);

    return baseSVG([
        text(72, 24, snapshot.provider.toUpperCase(), 14, '#aab3c5', '700'),
        text(72, 60, `${remaining}%`, 34, accent, '800'),
        text(72, 82, 'left', 12, '#d9deea', '700'),
        progressBar(18, 98, 108, 9, primary, accent),
        text(28, 119, windowLabel(primary), 10, '#aab3c5', '700'),
        text(72, 119, reset, 10, '#d9deea', '700'),
        progressBar(96, 116, 30, 5, secondary, '#5aa2ff')
    ]);
}

function baseSVG(children: string[]): string {
    return [
        '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"',
        ' viewBox="0 0 144 144">',
        '<rect width="144" height="144" rx="18" fill="#11131a"/>',
        '<rect x="8" y="8" width="128" height="128" rx="14"',
        ' fill="#171a24" stroke="#2b3140" stroke-width="2"/>',
        ...children,
        '</svg>'
    ].join('');
}

function text(
    x: number,
    y: number,
    value: string,
    size: number,
    fill: string,
    weight = '600'
): string {
    return [
        `<text x="${x}" y="${y}" text-anchor="middle"`,
        ' font-family="Inter, SF Pro, Arial, sans-serif"',
        ` font-size="${size}" font-weight="${weight}" fill="${fill}">`,
        escapeXML(value),
        '</text>'
    ].join('');
}

function progressBar(
    x: number,
    y: number,
    width: number,
    height: number,
    window: RateWindow | undefined,
    fill: string
): string {
    const remaining = window?.remainingPercent ?? 0;
    const filledWidth = Math.round(width * remaining / 100);

    return [
        `<rect x="${x}" y="${y}" width="${width}" height="${height}"`,
        ` rx="${height / 2}" fill="#2b3140"/>`,
        `<rect x="${x}" y="${y}" width="${filledWidth}" height="${height}"`,
        ` rx="${height / 2}" fill="${fill}"/>`
    ].join('');
}

function colorForRemaining(remaining: number): string {
    if (remaining >= 50) {
        return '#40d77b';
    }

    if (remaining >= 20) {
        return '#ffd166';
    }

    return '#ff6b6b';
}

function windowLabel(window: RateWindow | undefined): string {
    const minutes = window?.windowMinutes;
    if (minutes === 300) {
        return '5h';
    }

    if (minutes === 10080) {
        return '7d';
    }

    if (minutes === undefined) {
        return 'win';
    }

    if (minutes >= 1440) {
        return `${Math.round(minutes / 1440)}d`;
    }

    if (minutes >= 60) {
        return `${Math.round(minutes / 60)}h`;
    }

    return `${minutes}m`;
}

function resetText(window: RateWindow | undefined): string {
    if (window?.resetsAt === undefined) {
        return 'no reset';
    }

    const resetDate = new Date(window.resetsAt);
    const diffMs = resetDate.getTime() - Date.now();
    if (!Number.isFinite(diffMs)) {
        return 'no reset';
    }

    if (diffMs <= 0) {
        return 'now';
    }

    const minutes = Math.round(diffMs / 60000);
    if (minutes < 60) {
        return `${minutes}m`;
    }

    const hours = Math.round(minutes / 60);
    if (hours < 24) {
        return `${hours}h`;
    }

    return `${Math.round(hours / 24)}d`;
}

function compactError(message: string): string {
    if (message.length <= 18) {
        return message;
    }

    return `${message.slice(0, 15)}...`;
}

function escapeXML(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
