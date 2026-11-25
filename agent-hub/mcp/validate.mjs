// validate.mjs — argument validation for the MCP tools.

import { EFFORTS, PERMISSIONS } from './tools.mjs';

export class ToolError extends Error {}

export function requireString(args, name, { max = 100_000 } = {}) {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolError(`"${name}" must be a non-empty string`);
  }
  if (value.length > max) throw new ToolError(`"${name}" is too long (${value.length} > ${max})`);
  return value;
}

export function optionalString(args, name) {
  const value = args[name];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new ToolError(`"${name}" must be a string`);
  return value;
}

export function optionalEffort(args) {
  const value = args.effort;
  if (value === undefined) return undefined;
  if (!EFFORTS.includes(value)) {
    throw new ToolError(`"effort" must be one of ${EFFORTS.join(', ')}`);
  }
  return value;
}

export function optionalPermission(args, fallback = 'deny') {
  const value = args.permission;
  if (value === undefined) return fallback;
  if (!PERMISSIONS.includes(value)) {
    throw new ToolError(`"permission" must be one of ${PERMISSIONS.join(', ')}`);
  }
  return value;
}

export function optionalPositiveInt(args, name) {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1000) {
    throw new ToolError(`"${name}" must be an integer >= 1000`);
  }
  return value;
}

export function optionalPositiveNumber(args, name) {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ToolError(`"${name}" must be a number > 0`);
  }
  return value;
}
