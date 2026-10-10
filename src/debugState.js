/**
 * debugState.js - the host side of the debug ABI (SPEC.md, "Debug state"),
 * shared by CartHost and CartHostWeb so the two cannot drift.
 *
 * OPT-IN, PULL-ONLY: nothing here runs per frame. A cart without FLAG_DEBUG
 * gets null from readDebugState; a debug cart's wc_debug_field_t table is
 * walked only when a debug consumer asks. Every read and write is bounds
 * checked against the cart's memory, since every pointer here is the cart's.
 */

import { DEBUG_FIELD_SIZE, DEBUG_TYPE_WIDTH, DEBUG_TYPE_NAME } from './abi.js';

/** Cap per debug-event ring (log / marks) between drains. */
export const MAX_DEBUG_EVENTS = 1000;

const MAX_FIELDS = 1024; // sane cap; the table is author-sized (a handful)
const TYPE_BYTES = 8;

/** Read a NUL-terminated C string from cart memory (for field names). */
function readCString(u8, ptr, max = 256) {
  if (!ptr || ptr >= u8.length) return '';
  let end = ptr;
  const hardEnd = Math.min(u8.length, ptr + max);
  while (end < hardEnd && u8[end] !== 0) end++;
  return new TextDecoder().decode(u8.slice(ptr, end));
}

/**
 * Read the cart's debug-state descriptor table (the fields it chose to expose
 * by name). Returns null if the cart didn't opt in (no FLAG_DEBUG, or no
 * wc_debug_state export: conformance catches that).
 * @param {{info: object, instance: WebAssembly.Instance, memory: WebAssembly.Memory}} host
 * @returns {Array<{name:string,type:number,typeName:string,valuePtr:number,len:number}> | null}
 */
export function readDebugState(host) {
  if (!host.info?.hasDebug) return null;
  const fn = host.instance?.exports?.wc_debug_state;
  if (typeof fn !== 'function' || !host.memory) return null;
  const tablePtr = fn() >>> 0;
  if (!tablePtr) return null;
  const buf = host.memory.buffer;
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const fields = [];
  for (let i = 0; i < MAX_FIELDS; i++) {
    const entry = tablePtr + i * DEBUG_FIELD_SIZE;
    if (entry + DEBUG_FIELD_SIZE > buf.byteLength) {
      throw new RangeError(`debug table entry ${i} at ${entry} runs past cart memory (${buf.byteLength} bytes)`);
    }
    const namePtr = dv.getUint32(entry, true);
    if (namePtr === 0) break; // NUL-terminated array
    const type = u8[entry + 8];
    fields.push({
      name: readCString(u8, namePtr),
      type,
      typeName: DEBUG_TYPE_NAME[type] ?? `type${type}`,
      valuePtr: dv.getUint32(entry + 4, true),
      len: dv.getUint32(entry + 12, true) || 1,
    });
  }
  return fields;
}

/** Look up one field by name, with the error a consumer can act on. */
function findField(host, name) {
  const fields = readDebugState(host);
  const f = fields?.find((x) => x.name === name);
  if (!f) {
    throw new Error(`debug field '${name}' not found — cart exposes: ${(fields ?? []).map((x) => x.name).join(', ') || '(none)'}`);
  }
  return f;
}

/** The field's value bytes, checked to lie inside cart memory. */
function checkRange(f, byteLength) {
  const bytes = f.type === TYPE_BYTES ? f.len : (DEBUG_TYPE_WIDTH[f.type] ?? 1) * f.len;
  if (f.valuePtr + bytes > byteLength) {
    throw new RangeError(`debug field '${f.name}' (${bytes} bytes at ${f.valuePtr}) runs past cart memory (${byteLength} bytes)`);
  }
}

/**
 * Read a named debug value, decoded per its declared type. Scalars return
 * {name, type, value}; arrays {name, type, len, values}; BYTES {name, type:
 * 'bytes', bytes} (a copy). Throws if the name isn't in the table.
 */
export function readDebugValue(host, name) {
  const f = findField(host, name);
  const buf = host.memory.buffer;
  checkRange(f, buf.byteLength);
  if (f.type === TYPE_BYTES) {
    return { name, type: 'bytes', bytes: new Uint8Array(buf).slice(f.valuePtr, f.valuePtr + f.len) };
  }
  const dv = new DataView(buf);
  const width = DEBUG_TYPE_WIDTH[f.type] ?? 1;
  const readOne = (off) => {
    switch (f.type) {
      case 0: return dv.getUint8(off);
      case 1: return dv.getInt8(off);
      case 2: return dv.getUint16(off, true);
      case 3: return dv.getInt16(off, true);
      case 4: return dv.getUint32(off, true);
      case 5: return dv.getInt32(off, true);
      case 6: return dv.getFloat32(off, true);
      case 7: return dv.getFloat64(off, true);
      default: return null;
    }
  };
  if (f.len === 1) return { name, type: f.typeName, value: readOne(f.valuePtr) };
  const values = [];
  for (let i = 0; i < f.len; i++) values.push(readOne(f.valuePtr + i * width));
  return { name, type: f.typeName, len: f.len, values };
}

/**
 * Write a named scalar debug value (BYTES and arrays are not supported: poke
 * the field's valuePtr directly). Returns the address written.
 */
export function writeDebugValue(host, name, value) {
  const f = findField(host, name);
  if (f.len !== 1 || f.type === TYPE_BYTES) throw new Error(`debug field '${name}' is not a scalar — poke its heap offset ${f.valuePtr} directly.`);
  const buf = host.memory.buffer;
  checkRange(f, buf.byteLength);
  const dv = new DataView(buf);
  switch (f.type) {
    case 0: dv.setUint8(f.valuePtr, value); break;
    case 1: dv.setInt8(f.valuePtr, value); break;
    case 2: dv.setUint16(f.valuePtr, value, true); break;
    case 3: dv.setInt16(f.valuePtr, value, true); break;
    case 4: dv.setUint32(f.valuePtr, value, true); break;
    case 5: dv.setInt32(f.valuePtr, value, true); break;
    case 6: dv.setFloat32(f.valuePtr, value, true); break;
    case 7: dv.setFloat64(f.valuePtr, value, true); break;
    default: throw new Error(`unsupported debug type ${f.type}`);
  }
  return f.valuePtr;
}

/** Capped push for the debug event rings: the oldest entries drop past the
 *  cap so a chatty cart can't grow host memory unbounded between drains. */
export function pushDebugEvent(ring, ev, cap = MAX_DEBUG_EVENTS) {
  ring.push(ev);
  if (ring.length > cap) ring.shift();
}
