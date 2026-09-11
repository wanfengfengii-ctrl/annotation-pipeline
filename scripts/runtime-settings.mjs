import fs from 'node:fs';
import path from 'node:path';
import {
  defaultRuntimeLimits,
  validateRuntimeLimits,
} from '../lib/runtime-verification.mjs';

export function runtimeSettings(workRoot) {
  const file = path.join(workRoot, 'runtime-verification-settings.json');
  if (!fs.existsSync(file)) return { ...defaultRuntimeLimits };
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    Object.keys(value).some((key) => !Object.hasOwn(defaultRuntimeLimits, key))
  )
    throw Error('验收预算包含未知配置');
  return validateRuntimeLimits({ ...defaultRuntimeLimits, ...value });
}
