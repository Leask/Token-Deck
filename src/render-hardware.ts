import { HardwareSnapshot } from './hardware';

type HardwareRenderState =
    | { status: 'loading'; label: string }
    | { status: 'error'; label: string; message: string }
    | { status: 'ready'; snapshot: HardwareSnapshot }
    | { status: 'refreshing'; snapshot: HardwareSnapshot };

export function renderHardwareImage(state: HardwareRenderState): string {
    return svgDataURL(renderHardwareSVG(state));
}

function renderHardwareSVG(state: HardwareRenderState): string {
    if (state.status === 'loading') {
        return baseSVG([
            labelText(state.label),
            valueText('...', '#d9deea'),
            detailText('Loading'),
            progressBar(22, 104, 100, 8, 0, '#2b3140')
        ]);
    }

    if (state.status === 'error') {
        return baseSVG([
            labelText(state.label),
            valueText('ERR', '#ff6b6b'),
            detailText(compact(state.message, 17)),
            progressBar(22, 104, 100, 8, 0, '#2b3140')
        ]);
    }

    const { snapshot } = state;
    const color = colorForSnapshot(snapshot);
    const badges = state.status === 'refreshing'
        ? [refreshBadge(116, 23)]
        : [];

    return baseSVG([
        labelText(snapshot.label),
        valueText(snapshot.value, color),
        detailText(snapshot.detail),
        progressBar(22, 104, 100, 8, snapshot.percent ?? 0, color),
        ...badges
    ]);
}

function svgDataURL(svg: string): string {
    return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
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

function labelText(value: string): string {
    return text(72, 29, value, 15, '#aab3c5', '800');
}

function valueText(value: string, fill: string): string {
    const size = value.length > 7 ? 24 : 31;
    return text(72, 75, value, size, fill, '850');
}

function detailText(value: string): string {
    return text(72, 95, compact(value, 20), 12, '#d9deea', '650');
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
    percent: number,
    fill: string
): string {
    const filledWidth = Math.round(width * clamp(percent, 0, 100) / 100);

    return [
        `<rect x="${x}" y="${y}" width="${width}" height="${height}"`,
        ` rx="${height / 2}" fill="#2b3140"/>`,
        `<rect x="${x}" y="${y}" width="${filledWidth}" height="${height}"`,
        ` rx="${height / 2}" fill="${fill}"/>`
    ].join('');
}

function refreshBadge(x: number, y: number): string {
    return [
        `<g transform="translate(${x} ${y})">`,
        '<circle cx="0" cy="0" r="9" fill="#202637"',
        ' stroke="#5aa2ff" stroke-width="1.5"/>',
        '<path d="M -5 -1 A 6 6 0 0 1 4 -5"',
        ' fill="none" stroke="#9ec7ff" stroke-width="2"',
        ' stroke-linecap="round"/>',
        '<path d="M 4 -5 L 6 -8 L 8 -5 Z" fill="#9ec7ff"/>',
        '</g>'
    ].join('');
}

function colorForSnapshot(snapshot: HardwareSnapshot): string {
    if (snapshot.status === 'danger') {
        return '#ff6b6b';
    }

    if (snapshot.status === 'warn') {
        return '#ffd166';
    }

    if (snapshot.status === 'unknown') {
        return '#8d96a8';
    }

    if (snapshot.metric === 'network') {
        return '#5aa2ff';
    }

    if (snapshot.metric === 'gpu') {
        return '#b48cff';
    }

    return '#40d77b';
}

function compact(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
        return value;
    }

    return `${value.slice(0, maxLength - 3)}...`;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function escapeXML(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
