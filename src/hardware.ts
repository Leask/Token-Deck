import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type HardwareMetric = 'cpu' | 'memory' | 'disk' | 'gpu' | 'network';

export type HardwareSnapshot = {
    metric: HardwareMetric;
    label: string;
    value: string;
    detail: string;
    percent?: number;
    status?: 'ok' | 'warn' | 'danger' | 'unknown';
};

type CpuTimes = {
    idle: number;
    total: number;
};

type NetworkCounters = {
    rxBytes: number;
    txBytes: number;
};

const CPU_SAMPLE_MS = 250;
const NETWORK_SAMPLE_MS = 750;
const DISK_TIMEOUT_MS = 3_000;
const GPU_TIMEOUT_MS = 5_000;
const NETSTAT_TIMEOUT_MS = 3_000;

export async function fetchHardwareSnapshot(
    metric: HardwareMetric
): Promise<HardwareSnapshot> {
    switch (metric) {
        case 'cpu':
            return fetchCPUSnapshot();
        case 'memory':
            return fetchMemorySnapshot();
        case 'disk':
            return fetchDiskSnapshot();
        case 'gpu':
            return fetchGPUSnapshot();
        case 'network':
            return fetchNetworkSnapshot();
    }
}

async function fetchCPUSnapshot(): Promise<HardwareSnapshot> {
    const before = readCPUTimes();
    await sleep(CPU_SAMPLE_MS);
    const after = readCPUTimes();
    const idleDelta = after.idle - before.idle;
    const totalDelta = after.total - before.total;
    const usedPercent = totalDelta <= 0
        ? 0
        : clamp(100 - idleDelta / totalDelta * 100, 0, 100);

    return {
        metric: 'cpu',
        label: 'CPU',
        value: `${Math.round(usedPercent)}%`,
        detail: `${os.cpus().length} cores`,
        percent: usedPercent,
        status: pressureStatus(usedPercent)
    };
}

function fetchMemorySnapshot(): HardwareSnapshot {
    const total = os.totalmem();
    const free = os.freemem();
    const used = Math.max(0, total - free);
    const usedPercent = total <= 0 ? 0 : used / total * 100;

    return {
        metric: 'memory',
        label: 'MEM',
        value: `${Math.round(usedPercent)}%`,
        detail: `${formatBytes(used)} / ${formatBytes(total)}`,
        percent: usedPercent,
        status: pressureStatus(usedPercent)
    };
}

async function fetchDiskSnapshot(): Promise<HardwareSnapshot> {
    const target = diskTarget();
    const { stdout } = await execFileAsync('df', ['-k', target], {
        timeout: DISK_TIMEOUT_MS,
        maxBuffer: 1024 * 256
    });
    const lines = stdout.trim().split(/\r?\n/);
    const fields = lines.at(-1)?.trim().split(/\s+/);
    if (fields === undefined || fields.length < 5) {
        throw new Error('Could not parse disk usage');
    }

    const usedKb = Number(fields[2]);
    const availableKb = Number(fields[3]);
    const percent = Number(fields[4].replace('%', ''));
    if (!Number.isFinite(usedKb) || !Number.isFinite(availableKb)) {
        throw new Error('Invalid disk usage values');
    }

    return {
        metric: 'disk',
        label: 'DISK',
        value: `${Math.round(percent)}%`,
        detail: `${formatBytes(availableKb * 1024)} free`,
        percent,
        status: pressureStatus(percent)
    };
}

async function fetchGPUSnapshot(): Promise<HardwareSnapshot> {
    if (process.platform !== 'darwin') {
        return unavailableSnapshot('gpu', 'GPU', 'not macOS');
    }

    const { stdout } = await execFileAsync(
        'ioreg',
        ['-r', '-c', 'IOAccelerator', '-d', '2', '-w0'],
        {
            timeout: GPU_TIMEOUT_MS,
            maxBuffer: 1024 * 1024 * 4
        }
    );
    const utilization = maxNumberMatch(
        stdout,
        /"Device Utilization %"\s*=\s*(\d+(?:\.\d+)?)/g
    );

    if (utilization === undefined) {
        return unavailableSnapshot('gpu', 'GPU', 'no util');
    }

    const memoryBytes = maxNumberMatch(
        stdout,
        /"In use system memory"\s*=\s*(\d+)/g
    );
    const detail = memoryBytes === undefined
        ? appleGPUModel(stdout)
        : `${formatBytes(memoryBytes)} mem`;

    return {
        metric: 'gpu',
        label: 'GPU',
        value: `${Math.round(utilization)}%`,
        detail,
        percent: utilization,
        status: pressureStatus(utilization)
    };
}

async function fetchNetworkSnapshot(): Promise<HardwareSnapshot> {
    const before = await readNetworkCounters();
    await sleep(NETWORK_SAMPLE_MS);
    const after = await readNetworkCounters();
    const seconds = NETWORK_SAMPLE_MS / 1000;
    const rxPerSecond = Math.max(0, after.rxBytes - before.rxBytes) / seconds;
    const txPerSecond = Math.max(0, after.txBytes - before.txBytes) / seconds;
    const totalPerSecond = rxPerSecond + txPerSecond;
    const percent = clamp(totalPerSecond / (100 * 1024 * 1024) * 100, 0, 100);

    return {
        metric: 'network',
        label: 'NET',
        value: `${formatRate(totalPerSecond)}`,
        detail: `D ${formatRate(rxPerSecond)} U ${formatRate(txPerSecond)}`,
        percent,
        status: 'ok'
    };
}

function readCPUTimes(): CpuTimes {
    return os.cpus().reduce<CpuTimes>((result, cpu) => {
        const times = cpu.times;
        const total = times.user
            + times.nice
            + times.sys
            + times.irq
            + times.idle;

        return {
            idle: result.idle + times.idle,
            total: result.total + total
        };
    }, { idle: 0, total: 0 });
}

async function readNetworkCounters(): Promise<NetworkCounters> {
    const { stdout } = await execFileAsync('netstat', ['-ibn'], {
        timeout: NETSTAT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024
    });

    return stdout.split(/\r?\n/).reduce<NetworkCounters>((total, line) => {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 10 || fields[2]?.startsWith('<Link#') !== true) {
            return total;
        }

        const name = fields[0];
        if (isIgnoredInterface(name)) {
            return total;
        }

        const rxBytes = Number(fields.at(-5));
        const txBytes = Number(fields.at(-2));
        if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) {
            return total;
        }

        return {
            rxBytes: total.rxBytes + rxBytes,
            txBytes: total.txBytes + txBytes
        };
    }, { rxBytes: 0, txBytes: 0 });
}

function isIgnoredInterface(name: string): boolean {
    return name.endsWith('*')
        || name === 'lo0'
        || name.startsWith('gif')
        || name.startsWith('stf')
        || name.startsWith('anpi')
        || name.startsWith('awdl')
        || name.startsWith('llw')
        || name.startsWith('bridge');
}

function diskTarget(): string {
    if (
        process.platform === 'darwin'
        && existsSync('/System/Volumes/Data')
    ) {
        return '/System/Volumes/Data';
    }

    return '/';
}

function maxNumberMatch(
    value: string,
    pattern: RegExp
): number | undefined {
    let result: number | undefined;
    for (const match of value.matchAll(pattern)) {
        const parsed = Number(match[1]);
        if (!Number.isFinite(parsed)) {
            continue;
        }
        result = result === undefined ? parsed : Math.max(result, parsed);
    }

    return result;
}

function appleGPUModel(value: string): string {
    const match = value.match(/"model"\s*=\s*"([^"]+)"/);
    return match?.[1] ?? 'Apple GPU';
}

function unavailableSnapshot(
    metric: HardwareMetric,
    label: string,
    detail: string
): HardwareSnapshot {
    return {
        metric,
        label,
        value: '--',
        detail,
        status: 'unknown'
    };
}

function pressureStatus(percent: number): HardwareSnapshot['status'] {
    if (percent >= 85) {
        return 'danger';
    }

    if (percent >= 65) {
        return 'warn';
    }

    return 'ok';
}

function formatRate(bytesPerSecond: number): string {
    return `${formatBytes(bytesPerSecond)}/s`;
}

function formatBytes(bytes: number): string {
    const units = ['B', 'K', 'M', 'G', 'T'];
    let value = bytes;
    let index = 0;

    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }

    if (index === 0) {
        return `${Math.round(value)}${units[index]}`;
    }

    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}${units[index]}`;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}
