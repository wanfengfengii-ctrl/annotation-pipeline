import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  containerCapacity,
  resourceProfile,
} from '../lib/container-policy.mjs';
import { capacityFor } from '../scripts/scheduler.mjs';
import {
  dockerMemoryBytes,
  sampleDockerResources,
} from '../scripts/docker-runtime.mjs';

const GiB = 2 ** 30;
const light = resourceProfile('lightweight');
const engine = (changes = {}) => ({
  ready: true,
  cpus: 10,
  memoryBytes: 7.653 * GiB,
  resourceSample: {
    ok: true,
    vmObserved: true,
    externalWorkingSetBytes: 1.3 * GiB,
    ownedContainers: [
      { id: 'owned', memoryLimitBytes: 1.5 * GiB, workingSetBytes: 0.2 * GiB },
    ],
    memAvailableBytes: 6 * GiB,
    pressure: { someAvg10: 0, fullAvg10: 0 },
    ...changes,
  },
});
const capacity = (e, options = {}) =>
  containerCapacity(e, 3, { profile: light, occupied: 1, ...options });

test('lightweight fits three jobs in an 8 GB VM while reserving unrelated containers and growth', () => {
  assert.equal(capacity(engine()), 3);
  const twoGiB = { ...light, memoryBytes: 2 * GiB };
  assert.equal(
    capacity(
      engine({
        ownedContainers: [
          { memoryLimitBytes: 2 * GiB, workingSetBytes: 0.2 * GiB },
        ],
      }),
      { profile: twoGiB },
    ),
    2,
  );
  assert.equal(capacity(engine({ externalWorkingSetBytes: 2.5 * GiB })), 2);
});

test('existing larger limits are reserved in full, not silently resized by admission', () => {
  assert.equal(
    capacity(
      engine({
        ownedContainers: [
          { memoryLimitBytes: 3 * GiB, workingSetBytes: 0.2 * GiB },
        ],
      }),
    ),
    2,
  );
  assert.equal(
    capacity(
      engine({
        ownedContainers: [{ memoryLimitBytes: 0, workingSetBytes: 0.2 * GiB }],
      }),
    ),
    1,
  );
});

test('existing aggregate limits beyond the VM budget hold new admissions', () => {
  assert.equal(
    capacity(
      engine({
        ownedContainers: Array(2).fill({
          memoryLimitBytes: 3 * GiB,
          workingSetBytes: 0.2 * GiB,
        }),
      }),
    ),
    1,
  );
});

test('VM headroom, pressure and near-limit jobs stop additional admission without stopping current work', () => {
  assert.equal(capacity(engine({ memAvailableBytes: 4 * GiB })), 2);
  assert.equal(capacity(engine({ memAvailableBytes: 0.5 * GiB })), 1);
  assert.equal(
    capacity(engine({ pressure: { someAvg10: 10, fullAvg10: 0 } })),
    1,
  );
  assert.equal(
    capacity(engine({ pressure: { someAvg10: 0, fullAvg10: 1 } })),
    1,
  );
  assert.equal(
    capacity(
      engine({
        ownedContainers: [
          { memoryLimitBytes: 1.5 * GiB, workingSetBytes: 1.4 * GiB },
        ],
      }),
    ),
    1,
  );
  assert.equal(capacity(engine({ ok: false })), 1);
  assert.equal(
    containerCapacity({ ready: true, cpus: 10, memoryBytes: 8 * GiB }, 3, {
      profile: light,
    }),
    0,
  );
});

test('without a VM observation only the first probe container may start', () => {
  assert.equal(
    capacity(engine({ ownedContainers: [], vmObserved: false }), {
      occupied: 0,
    }),
    1,
  );
  assert.equal(
    capacity(
      engine({
        ownedContainers: [],
        vmObserved: false,
        externalWorkingSetBytes: 6 * GiB,
      }),
      { occupied: 0 },
    ),
    0,
  );
});

test('host memory counts new work incrementally and retains hardware and load limits', () => {
  const m = { cores: 10, totalGB: 32, availableGB: 5.2, load: 3 };
  assert.equal(capacityFor(m, 3, { profile: light, occupied: 1 }).effective, 3);
  assert.equal(
    capacityFor({ ...m, availableGB: 2 }, 3, { profile: light, occupied: 1 })
      .effective,
    1,
  );
  assert.equal(
    capacityFor({ ...m, load: 10 }, 3, { profile: light, occupied: 1 })
      .effective,
    2,
  );
  assert.equal(capacityFor(m, 2, { profile: light, occupied: 1 }).effective, 2);
  assert.equal(resourceProfile('standard').memoryArg, '3g');
  assert.equal(
    light.memoryBytes,
    dockerMemoryBytes(light.memoryArg.replace('m', 'MiB')),
  );
  assert.throws(() => resourceProfile('unbounded'), /未知/);
});

test('sampling inspects only allowed fields and reads VM memory through an owned container', () => {
  const calls = [];
  const command = (args, options) => {
    calls.push(args);
    assert.ok(options.timeout > 0 && options.timeout <= 5000);
    if (args[0] === 'ps') return 'abc123\ndef456';
    if (args[0] === 'inspect') {
      assert.ok(!args[2].includes('Config.Env'));
      return [
        { id: 'abc123-full', owner: 'ours', memoryLimitBytes: 1.5 * GiB },
        { id: 'def456-full', owner: 'someone-else', memoryLimitBytes: 0 },
      ]
        .map((x) => JSON.stringify(x))
        .join('\n');
    }
    if (args[0] === 'stats')
      return [
        { ID: 'abc123', MemUsage: '200MiB / 1.5GiB' },
        { ID: 'def456', MemUsage: '1.3GiB / 7.653GiB' },
      ]
        .map((x) => JSON.stringify(x))
        .join('\n');
    assert.equal(args[0], 'exec');
    assert.equal(args[1], 'abc123-full');
    assert.match(args.at(-1), /ANNOTATION_RESOURCE_SAMPLE/);
    return JSON.stringify({
      memAvailableBytes: 6 * GiB,
      pressure: { someAvg10: 0, fullAvg10: 0 },
      cgroup: {
        currentBytes: 250 * 2 ** 20,
        maxBytes: 1.5 * GiB,
        inactiveFileBytes: 25 * 2 ** 20,
      },
    });
  };
  const result = sampleDockerResources({ owner: 'ours', command });
  assert.equal(result.ok, true);
  assert.equal(result.vmObserved, true);
  assert.equal(result.externalWorkingSetBytes, 1.3 * GiB);
  assert.equal(result.ownedContainers[0].workingSetBytes, 225 * 2 ** 20);
  assert.equal(calls.filter((args) => args[0] === 'exec').length, 1);
});

test('sample failures redact details and preserve conservative admission', () => {
  const result = sampleDockerResources({
    owner: 'ours',
    command: () => {
      throw Error('sensitive raw Docker error');
    },
  });

  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result).includes('sensitive'));
  assert.equal(capacity({ ...engine(), resourceSample: result }), 1);
  assert.equal(dockerMemoryBytes('512 MiB'), 512 * 2 ** 20);
  assert.equal(dockerMemoryBytes('2.5GB'), 2.5 * 10 ** 9);
  assert.throws(() => dockerMemoryBytes('unknown'));
});

test('observed VM base memory is not charged again against MemAvailable', () => {
  const observed = engine({
    externalWorkingSetBytes: 1358954496,
    ownedContainers: [
      { memoryLimitBytes: 1610612736, workingSetBytes: 251338752 },
    ],
    memAvailableBytes: 5932253184,
  });
  observed.memoryBytes = 8217059328;
  assert.equal(capacity(observed), 3);
  observed.resourceSample.memAvailableBytes = 3 * GiB;
  assert.equal(capacity(observed), 1);
});
