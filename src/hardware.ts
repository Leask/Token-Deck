import { execFile } from 'node:child_process';
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

type DiskRow = {
    filesystem: string;
    totalBytes: number;
    availableBytes: number;
    mountPoint: string;
};

type DiskVolume = {
    key: string;
    totalBytes: number;
    availableBytes: number;
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
    const volumes = await readLocalDiskVolumes();
    if (volumes.length === 0) {
        throw new Error('No local physical disks found');
    }

    const totalBytes = volumes.reduce((total, volume) => {
        return total + volume.totalBytes;
    }, 0);
    const availableBytes = volumes.reduce((total, volume) => {
        return total + volume.availableBytes;
    }, 0);
    const usedBytes = Math.max(0, totalBytes - availableBytes);
    const percent = totalBytes <= 0 ? 0 : usedBytes / totalBytes * 100;

    return {
        metric: 'disk',
        label: 'DISK',
        value: `${Math.round(percent)}%`,
        detail: `${volumes.length} disks ${formatBytes(availableBytes)} free`,
        percent,
        status: pressureStatus(percent)
    };
}

async function readLocalDiskVolumes(): Promise<DiskVolume[]> {
    const { stdout } = await execFileAsync('df', ['-k', '-P', '-l'], {
        timeout: DISK_TIMEOUT_MS,
        maxBuffer: 1024 * 512
    });
    const rows = parseDiskRows(stdout);
    const volumes = new Map<string, DiskVolume>();

    for (const row of rows) {
        if (!isPhysicalDiskCandidate(row)) {
            continue;
        }

        let volume: DiskVolume | undefined;
        try {
            volume = await describeDiskRow(row);
        } catch {
            continue;
        }

        if (volume === undefined) {
            continue;
        }

        volumes.set(volume.key, volume);
    }

    return [...volumes.values()];
}

function parseDiskRows(stdout: string): DiskRow[] {
    return stdout
        .trim()
        .split(/\r?\n/)
        .slice(1)
        .flatMap((line) => {
            const match = line.match(
                /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(.+)$/
            );
            if (match === null) {
                return [];
            }

            return [{
                filesystem: match[1],
                totalBytes: Number(match[2]) * 1024,
                availableBytes: Number(match[4]) * 1024,
                mountPoint: match[5]
            }];
        });
}

function isPhysicalDiskCandidate(row: DiskRow): boolean {
    if (!row.filesystem.startsWith('/dev/')) {
        return false;
    }

    if (row.mountPoint.startsWith('/Volumes/com.apple.TimeMachine.')) {
        return false;
    }

    if (process.platform !== 'darwin') {
        return row.mountPoint === '/' || row.mountPoint.startsWith('/Volumes/');
    }

    if (row.mountPoint === '/System/Volumes/Data') {
        return true;
    }

    if (row.mountPoint === '/' && !hasDataVolume(row)) {
        return true;
    }

    return row.mountPoint.startsWith('/Volumes/');
}

async function describeDiskRow(
    row: DiskRow
): Promise<DiskVolume | undefined> {
    if (process.platform !== 'darwin') {
        return fallbackDiskVolume(row);
    }

    const { stdout } = await execFileAsync(
        'diskutil',
        ['info', '-plist', row.filesystem],
        {
            timeout: DISK_TIMEOUT_MS,
            maxBuffer: 1024 * 512
        }
    );

    const busProtocol = plistString(stdout, 'BusProtocol');
    if (busProtocol.toLowerCase() === 'disk image') {
        return undefined;
    }

    const key = plistString(stdout, 'APFSContainerReference')
        || plistString(stdout, 'ParentWholeDisk')
        || plistString(stdout, 'DeviceIdentifier')
        || row.filesystem;
    const totalBytes = plistInteger(stdout, 'APFSContainerSize')
        ?? plistInteger(stdout, 'TotalSize')
        ?? row.totalBytes;
    const availableBytes = plistInteger(stdout, 'APFSContainerFree')
        ?? row.availableBytes;

    return {
        key,
        totalBytes,
        availableBytes
    };
}

function fallbackDiskVolume(row: DiskRow): DiskVolume {
    return {
        key: row.filesystem.replace(/s\d+$/, ''),
        totalBytes: row.totalBytes,
        availableBytes: row.availableBytes
    };
}

function hasDataVolume(row: DiskRow): boolean {
    return row.filesystem.includes('s3s') || row.filesystem.includes('s1s');
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

function plistString(plist: string, key: string): string {
    const pattern = new RegExp(
        `<key>${escapeRegExp(key)}</key>\\s*<string>([^<]*)</string>`
    );
    return decodeXML(pattern.exec(plist)?.[1] ?? '');
}

function plistInteger(plist: string, key: string): number | undefined {
    const pattern = new RegExp(
        `<key>${escapeRegExp(key)}</key>\\s*<integer>(\\d+)</integer>`
    );
    const value = Number(pattern.exec(plist)?.[1]);
    return Number.isFinite(value) ? value : undefined;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeXML(value: string): string {
    return value
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, '\'')
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .replace(/&amp;/g, '&');
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
