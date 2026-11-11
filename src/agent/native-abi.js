/* Verified KakaoTalk26.9.2.5342 ia32 adapter. Constructing it verifies bytes; it does not call Kakao. */
'use strict';

function createSourceResolverNativeAbi(context) {
  const pointer = context.ptr || ptr;
  const base = pointer(context.moduleBase);
  const native = context.nativeFunction || ((address, result, args, abi) => new NativeFunction(address, result, args, abi));
  const size = context.pointerSize === undefined ? Process.pointerSize : context.pointerSize;
  if (size !== 4) throw new Error('Source resolver supports only the verified ia32 build');
  const zero = pointer(0);
  const add = value => base.add(value - 0x400000);
  const types = { original: add(0x25b419c), control: add(0x25a4570), gdip: add(0x26242c4), webp: add(0x2623fd0) };
  const plans = {
    factory: [0x143c050, '558bec6aff6887cb1c0264a100000000', 'pointer', ['pointer', 'pointer'], 'fastcall'],
    sharedRelease: [0x8c1b60, '53578bda8bf93bfb7436560f1f440000', 'void', ['pointer', 'pointer'], 'fastcall'],
    getImage: [0x12b13d0, '558bec6aff6854f7220264a100000000', 'pointer', ['pointer', 'pointer'], 'thiscall'],
    download: [0x12b19a0, '558bec6aff6817f8220264a100000000', 'int', ['pointer'], 'thiscall'],
    imageRelease: [0x176fa50, '558bec56578b7d0883cefff00fc17704', 'uint', ['pointer'], 'stdcall'],
    vectorRelease: [0x8e2790, '568bf18b0e85c974578b560451e8bef3', 'void', ['pointer'], 'thiscall']
  };
  function guard(address, hex) {
    if (context.verifyEntry) { context.verifyEntry(address, hex); return; }
    const actual = Array.from(new Uint8Array(address.readByteArray(hex.length / 2)), b => b.toString(16).padStart(2, '0')).join('');
    if (actual !== hex) throw new Error('Verified source ABI byte mismatch at ' + address);
  }
  const calls = {};
  Object.keys(plans).forEach(key => {
    const plan = plans[key], address = add(plan[0]);
    guard(address, plan[1]);
    calls[key] = native(address, plan[2], plan[3], plan[4]);
  });
  function hasType(object, type) { return !object.isNull() && object.readPointer().equals(type); }
  function original(object) {
    if (!hasType(object, types.original)) throw new Error('Original-container type guard failed');
  }
  let metadataShim = null, getMetadata = null;
  if (context.enableMetadata !== false) {
    const getter = add(0x1a008b0);
    guard(getter, '558bec6aff68e05e2c0264a100000000');
    const allocator = context.memory || Memory;
    const pageSize = context.pageSize || Process.pageSize;
    metadataShim = allocator.alloc(pageSize); // A dedicated page, never a shared small-allocation page.
    const code = [0x55, 0x8b, 0xec, 0xff, 0x75, 0x10, 0xff, 0x75, 0x0c, 0x8b, 0x4d, 0x08, 0xe8];
    const relative = getter.sub(metadataShim.add(17)).toInt32();
    code.push(relative & 255, (relative >>> 8) & 255, (relative >>> 16) & 255, (relative >>> 24) & 255);
    code.push(0x83, 0xc4, 0x08, 0x5d, 0xc3);
    metadataShim.writeByteArray(code);
    if (!allocator.protect(metadataShim, pageSize, 'r-x')) throw new Error('Cannot protect private metadata ABI shim');
    getMetadata = native(metadataShim, 'uint8', ['pointer', 'uint', 'uint'], 'mscdecl');
  }
  const adapter = {
    verified: true,
    createOriginal(output, metadataRef) {
      if (metadataRef.isNull() || metadataRef.readPointer().isNull()) throw new Error('Factory metadata reference is absent');
      const returned = calls.factory(output, metadataRef);
      if (!returned.equals(output)) throw new Error('Original factory returned unexpected output storage');
      original(output.readPointer());
      const control = output.add(4).readPointer();
      if (!hasType(control, types.control)) throw new Error('Original factory control-block type guard failed');
    },
    getImage(object, output) {
      original(object);
      const returned = calls.getImage(object, output);
      if (!returned.equals(output)) throw new Error('Original GetImage returned unexpected output storage');
      return returned;
    },
    download(object) {
      original(object);
      if (!object.readPointer().add(8).readPointer().equals(add(0x12b19a0))) throw new Error('Original download virtual-slot guard failed');
      return calls.download(object);
    },
    releaseShared(output) {
      const object = output.readPointer(), control = output.add(4).readPointer();
      if (control.isNull()) {
        if (!object.isNull()) throw new Error('Shared owner has an object without a control block');
        return;
      }
      if (!hasType(control, types.control)) throw new Error('Shared-owner cleanup control-block guard failed');
      calls.sharedRelease(output, output.add(8)); // Destroys one pair; never frees Frida allocation.
      output.writePointer(zero);
      output.add(4).writePointer(zero);
    },
    releaseVariant(output) {
      const image = output.readPointer();
      if (image.isNull()) return;
      const tag = output.add(4).readU8();
      const type = tag === 0 ? types.gdip : (tag === 1 ? types.webp : null);
      if (!type || !hasType(image, type)) throw new Error('Image-variant cleanup type guard failed');
      if (!image.readPointer().add(8).readPointer().equals(add(0x176fa50))) throw new Error('Image Release virtual-slot guard failed');
      calls.imageRelease(image);
      output.writePointer(zero);
      output.add(4).writeU8(0xff);
    },
    // Keeps the private executable allocation alive until this adapter is no longer used.
    metadataShimAllocation: metadataShim
  };
  if (getMetadata) {
    adapter.getMetadata = (output, messageLo, messageHi) => getMetadata(output, messageLo >>> 0, messageHi >>> 0);
    adapter.releaseMetadataVector = output => calls.vectorRelease(output);
  }
  return adapter;
}

if (typeof globalThis !== 'undefined') globalThis.createSourceResolverNativeAbi = createSourceResolverNativeAbi;
