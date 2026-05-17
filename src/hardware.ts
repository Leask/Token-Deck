import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const requireFromRuntime = createRequire(import.meta.url);
const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));

export type HardwareMetric =
    | 'cpu'
    | 'memory'
    | 'disk'
    | 'gpu'
    | 'network'
    | 'temperature'
    | 'battery'
    | 'power';

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

type TemperatureReading = {
    main?: number;
    cores: number[];
    max?: number;
};

type OSXTemperatureSensor = {
    cpuTemperature: () => unknown;
};

type BatteryReading = {
    percent?: number;
    source: string;
    state: string;
    detail: string;
};

type PowerReading = {
    watts: number;
    detail: string;
};

const CPU_SAMPLE_MS = 250;
const NETWORK_SAMPLE_MS = 750;
const DISK_TIMEOUT_MS = 3_000;
const GPU_TIMEOUT_MS = 5_000;
const NETSTAT_TIMEOUT_MS = 3_000;
const TEMPERATURE_TIMEOUT_MS = 3_000;
const BATTERY_TIMEOUT_MS = 3_000;
const POWER_TIMEOUT_MS = 3_000;
const POWER_MAX_WATTS = 250;
const TEMPERATURE_MIN_C = 30;
const TEMPERATURE_MAX_C = 100;
const EXTERNAL_NODE_CANDIDATES = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    'node'
];

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
        case 'temperature':
            return fetchTemperatureSnapshot();
        case 'battery':
            return fetchBatterySnapshot();
        case 'power':
            return fetchPowerSnapshot();
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

async function fetchTemperatureSnapshot(): Promise<HardwareSnapshot> {
    if (process.platform !== 'darwin') {
        return unavailableSnapshot('temperature', 'TEMP', 'not macOS');
    }

    const reading = await readOSXTemperature();
    if (reading !== undefined) {
        return temperatureReadingSnapshot(reading);
    }

    try {
        return await readThermalPressureSnapshot();
    } catch {
        return unavailableSnapshot('temperature', 'TEMP', 'no sensor');
    }
}

async function fetchBatterySnapshot(): Promise<HardwareSnapshot> {
    if (process.platform !== 'darwin') {
        return unavailableSnapshot('battery', 'BATT', 'not macOS');
    }

    try {
        const { stdout } = await execFileAsync('pmset', ['-g', 'batt'], {
            timeout: BATTERY_TIMEOUT_MS,
            maxBuffer: 1024 * 16
        });
        return batteryReadingSnapshot(parsePmsetBattery(stdout));
    } catch {
        return unavailableSnapshot('battery', 'BATT', 'no battery');
    }
}

async function fetchPowerSnapshot(): Promise<HardwareSnapshot> {
    if (process.platform !== 'darwin') {
        return unavailableSnapshot('power', 'PWR', 'not macOS');
    }

    try {
        const { stdout } = await execFileAsync(
            'ioreg',
            ['-rn', 'AppleSmartBattery', '-w0'],
            {
                timeout: POWER_TIMEOUT_MS,
                maxBuffer: 1024 * 128
            }
        );
        const reading = parsePowerReading(stdout);
        if (reading === undefined) {
            return unavailableSnapshot('power', 'PWR', 'no meter');
        }

        return powerReadingSnapshot(reading);
    } catch {
        return unavailableSnapshot('power', 'PWR', 'no meter');
    }
}

function parsePmsetBattery(stdout: string): BatteryReading {
    const source = stdout.match(/Now drawing from '([^']+)'/)?.[1] ?? 'Power';
    const batteryLines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /;\s*.*present:\s*true/i.test(line));

    if (batteryLines.length === 0) {
        return {
            source,
            state: 'AC',
            detail: /no batteries/i.test(stdout) ? 'no battery' : source
        };
    }

    const readings = batteryLines.flatMap((line) => {
        const match = line.match(
            /^-?(.+?)\s*(?:\(id=\d+\))?\s+(\d+(?:\.\d+)?)%;\s*(.+)$/i
        );
        if (match === null) {
            return [];
        }

        return [{
            percent: clamp(Number(match[2]), 0, 100),
            source,
            state: batteryState(match[3]),
            detail: batteryDetail(match[1], match[3], source)
        }];
    });

    if (readings.length === 0) {
        return {
            source,
            state: 'unknown',
            detail: source
        };
    }

    return readings.reduce((lowest, reading) => {
        return reading.percent < lowest.percent ? reading : lowest;
    });
}

function batteryReadingSnapshot(reading: BatteryReading): HardwareSnapshot {
    const percent = reading.percent;
    if (percent === undefined) {
        return {
            metric: 'battery',
            label: 'BATT',
            value: 'AC',
            detail: reading.detail,
            percent: 100,
            status: 'ok'
        };
    }

    return {
        metric: 'battery',
        label: 'BATT',
        value: `${Math.round(percent)}%`,
        detail: reading.detail,
        percent,
        status: batteryStatus(percent, reading.state)
    };
}

function parsePowerReading(stdout: string): PowerReading | undefined {
    const telemetryReading = telemetryPowerReading(stdout);
    if (telemetryReading !== undefined) {
        return telemetryReading;
    }

    const calculatedReading = calculatedPowerReading(
        ioregInteger(stdout, 'SystemCurrentIn'),
        ioregInteger(stdout, 'SystemVoltageIn'),
        'input calc'
    );
    if (calculatedReading !== undefined) {
        return calculatedReading;
    }

    const batteryReading = calculatedPowerReading(
        ioregInteger(stdout, 'Amperage'),
        ioregInteger(stdout, 'Voltage'),
        'battery calc'
    );
    if (batteryReading !== undefined) {
        return batteryReading;
    }

    return undefined;
}

function telemetryPowerReading(stdout: string): PowerReading | undefined {
    const candidates: Array<[string, string]> = [
        ['SystemPowerIn', 'system input'],
        ['SystemLoad', 'system load'],
        ['WallEnergyEstimate', 'wall estimate'],
        ['BatteryPower', 'battery power']
    ];

    for (const [key, detail] of candidates) {
        const watts = milliwattsToWatts(ioregInteger(stdout, key));
        if (watts !== undefined) {
            return { watts, detail };
        }
    }

    return undefined;
}

function calculatedPowerReading(
    currentMilliAmps: number | undefined,
    voltageMilliVolts: number | undefined,
    detail: string
): PowerReading | undefined {
    if (currentMilliAmps === undefined || voltageMilliVolts === undefined) {
        return undefined;
    }

    const watts = Math.abs(currentMilliAmps) * Math.abs(voltageMilliVolts)
        / 1_000_000;
    if (watts <= 0.1) {
        return undefined;
    }

    return { watts, detail };
}

function powerReadingSnapshot(reading: PowerReading): HardwareSnapshot {
    const rounded = reading.watts >= 10
        ? Math.round(reading.watts)
        : Number(reading.watts.toFixed(1));

    return {
        metric: 'power',
        label: 'PWR',
        value: `${rounded}W`,
        detail: reading.detail,
        percent: clamp(reading.watts / POWER_MAX_WATTS * 100, 0, 100),
        status: powerStatus(reading.watts)
    };
}

async function readOSXTemperature(): Promise<TemperatureReading | undefined> {
    const directReading = readOSXTemperatureInProcess();
    if (directReading !== undefined) {
        return directReading;
    }

    return readOSXTemperatureWithExternalNode();
}

function readOSXTemperatureInProcess(): TemperatureReading | undefined {
    try {
        const sensor = requireFromRuntime(
            'osx-temperature-sensor'
        ) as OSXTemperatureSensor;

        return normalizeTemperatureReading(sensor.cpuTemperature());
    } catch {
        return undefined;
    }
}

async function readOSXTemperatureWithExternalNode(): Promise<
    TemperatureReading | undefined
> {
    const modulePath = osxTemperatureSensorModulePath();
    const script = [
        `const sensor = require(${JSON.stringify(modulePath)});`,
        'console.log(JSON.stringify(sensor.cpuTemperature()));'
    ].join('');

    for (const nodePath of EXTERNAL_NODE_CANDIDATES) {
        try {
            const { stdout } = await execFileAsync(nodePath, ['-e', script], {
                timeout: TEMPERATURE_TIMEOUT_MS,
                maxBuffer: 1024 * 16
            });

            return normalizeTemperatureReading(JSON.parse(stdout));
        } catch {
            continue;
        }
    }

    return undefined;
}

function batteryState(value: string): string {
    const fields = batteryFields(value);
    const firstState = fields.find((field) => {
        return field.length > 0;
    });

    return firstState ?? 'unknown';
}

function batteryDetail(
    name: string,
    stateValue: string,
    source: string
): string {
    const fields = batteryFields(stateValue);
    const state = fields[0] ?? 'unknown';
    const remaining = fields.find((field) => /remaining/i.test(field));

    if (remaining !== undefined) {
        const cleanRemaining = remaining.replace(/\s+/g, ' ');
        return `${batterySourceLabel(source)} ${cleanRemaining}`;
    }

    if (/UPS|LCD|Battery/i.test(name)) {
        return `${compactBatteryName(name)} ${state}`;
    }

    return `${batterySourceLabel(source)} ${state}`;
}

function batteryFields(value: string): string[] {
    return value
        .split(';')
        .map((field) => {
            return field.replace(/\s*present:\s*\w+/i, '').trim();
        })
        .filter((field) => field.length > 0);
}

function compactBatteryName(value: string): string {
    return value
        .replace(/^InternalBattery-\d+$/i, 'Internal')
        .replace(/\s+/g, ' ')
        .slice(0, 9);
}

function batterySourceLabel(value: string): string {
    if (/battery/i.test(value)) {
        return 'Battery';
    }

    if (/ac/i.test(value)) {
        return 'AC';
    }

    return 'Power';
}

function osxTemperatureSensorModulePath(): string {
    const candidates = [
        path.resolve(
            runtimeDirectory,
            '../../node_modules/osx-temperature-sensor'
        ),
        path.resolve(process.cwd(), 'node_modules/osx-temperature-sensor')
    ];

    return candidates.find((candidate) => {
        return fs.existsSync(candidate);
    }) ?? 'osx-temperature-sensor';
}

function normalizeTemperatureReading(
    value: unknown
): TemperatureReading | undefined {
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }

    const raw = value as {
        main?: unknown;
        cores?: unknown;
        max?: unknown;
    };
    const cores = Array.isArray(raw.cores)
        ? raw.cores.flatMap((core) => {
            const value = positiveTemperature(core);
            return value === undefined ? [] : [value];
        })
        : [];
    const main = positiveTemperature(raw.main) ?? average(cores);
    const max = positiveTemperature(raw.max)
        ?? (cores.length > 0 ? Math.max(...cores) : undefined)
        ?? main;

    if (main === undefined && max === undefined) {
        return undefined;
    }

    return {
        main,
        cores,
        max
    };
}

function temperatureReadingSnapshot(
    reading: TemperatureReading
): HardwareSnapshot {
    const current = reading.max ?? reading.main ?? 0;
    const averageTemperature = reading.main;
    const detail = averageTemperature === undefined
        ? 'Apple SMC'
        : `avg ${Math.round(averageTemperature)}C`;

    return {
        metric: 'temperature',
        label: 'TEMP',
        value: `${Math.round(current)}C`,
        detail,
        percent: temperaturePercent(current),
        status: temperatureStatus(current)
    };
}

async function readThermalPressureSnapshot(): Promise<HardwareSnapshot> {
    const { stdout } = await execFileAsync('pmset', ['-g', 'therm'], {
        timeout: TEMPERATURE_TIMEOUT_MS,
        maxBuffer: 1024 * 16
    });
    const state = parseThermalPressure(stdout);

    return {
        metric: 'temperature',
        label: 'TEMP',
        value: state.value,
        detail: state.detail,
        percent: state.percent,
        status: state.status
    };
}

function parseThermalPressure(stdout: string): {
    value: string;
    detail: string;
    percent: number;
    status: HardwareSnapshot['status'];
} {
    const activeLines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .filter((line) => !/^note:\s+no .* has been recorded$/i.test(line));

    if (activeLines.length === 0) {
        return {
            value: 'OK',
            detail: 'thermal nominal',
            percent: 0,
            status: 'ok'
        };
    }

    const speedLimit = minNumberMatch(
        activeLines.join('\n'),
        /(?:CPU|GPU)_Speed_Limit\s*=\s*(\d+(?:\.\d+)?)/g
    );
    if (speedLimit !== undefined && speedLimit < 95) {
        const pressure = clamp(100 - speedLimit, 0, 100);
        return {
            value: speedLimit < 70 ? 'HOT' : 'WARM',
            detail: `limit ${Math.round(speedLimit)}%`,
            percent: pressure,
            status: speedLimit < 70 ? 'danger' : 'warn'
        };
    }

    const text = activeLines.join(' ').toLowerCase();
    if (/critical|shutdown|sleep|danger/.test(text)) {
        return {
            value: 'HOT',
            detail: 'thermal critical',
            percent: 90,
            status: 'danger'
        };
    }

    return {
        value: 'WARM',
        detail: compactThermalDetail(activeLines[0]),
        percent: 65,
        status: 'warn'
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

function minNumberMatch(
    value: string,
    pattern: RegExp
): number | undefined {
    let result: number | undefined;
    for (const match of value.matchAll(pattern)) {
        const parsed = Number(match[1]);
        if (!Number.isFinite(parsed)) {
            continue;
        }
        result = result === undefined ? parsed : Math.min(result, parsed);
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

function ioregInteger(value: string, key: string): number | undefined {
    const pattern = new RegExp(
        `"${escapeRegExp(key)}"\\s*=\\s*(-?\\d+)`
    );
    const parsed = Number(pattern.exec(value)?.[1]);
    return Number.isFinite(parsed) ? parsed : undefined;
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

function batteryStatus(
    percent: number,
    state: string
): HardwareSnapshot['status'] {
    if (percent <= 15) {
        return 'danger';
    }

    if (percent <= 30 && /discharging|battery/i.test(state)) {
        return 'warn';
    }

    return 'ok';
}

function powerStatus(watts: number): HardwareSnapshot['status'] {
    if (watts >= 220) {
        return 'danger';
    }

    if (watts >= 150) {
        return 'warn';
    }

    return 'ok';
}

function temperatureStatus(temperature: number): HardwareSnapshot['status'] {
    if (temperature >= 90) {
        return 'danger';
    }

    if (temperature >= 75) {
        return 'warn';
    }

    return 'ok';
}

function temperaturePercent(temperature: number): number {
    return clamp(
        (temperature - TEMPERATURE_MIN_C)
            / (TEMPERATURE_MAX_C - TEMPERATURE_MIN_C)
            * 100,
        0,
        100
    );
}

function positiveTemperature(value: unknown): number | undefined {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) && numberValue > 0
        ? numberValue
        : undefined;
}

function milliwattsToWatts(value: number | undefined): number | undefined {
    if (value === undefined || value === 0) {
        return undefined;
    }

    const watts = Math.abs(value) / 1000;
    return watts > 0.1 ? watts : undefined;
}

function average(values: number[]): number | undefined {
    if (values.length === 0) {
        return undefined;
    }

    return values.reduce((total, value) => total + value, 0) / values.length;
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

function compactThermalDetail(value: string): string {
    return value
        .replace(/^note:\s*/i, '')
        .replace(/\s+/g, ' ')
        .slice(0, 20);
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}
