/* Frida fragment. No Node imports. All Kakao calls execute on the established UI thread. */
'use strict';

function sourceResolverParseGif(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 14) throw new Error('GIF is too short');
  const header = String.fromCharCode.apply(null, bytes.subarray(0, 6));
  if (header !== 'GIF87a' && header !== 'GIF89a') throw new Error('Source is not GIF');
  const word = at => bytes[at] | (bytes[at + 1] << 8);
  const width = word(6), height = word(8);
  if (!width || !height) throw new Error('GIF dimensions are empty');
  let position = 13, pendingDelay = 0, frameCount = 0, trailer = false;
  const delaysMs = [];
  function need(count) {
    if (count < 0 || position + count > bytes.length) throw new Error('Truncated GIF');
  }
  function subBlocks() {
    for (let count = 0; count < 100000; count++) {
      need(1);
      const length = bytes[position++];
      if (!length) return;
      need(length);
      position += length;
    }
    throw new Error('GIF block limit exceeded');
  }
  if (bytes[10] & 0x80) { position += 3 * (1 << ((bytes[10] & 7) + 1)); need(0); }
  for (let blocks = 0; blocks < 100000 && position < bytes.length; blocks++) {
    const marker = bytes[position++];
    if (marker === 0x3b) { trailer = true; break; }
    if (marker === 0x21) {
      need(1);
      const label = bytes[position++];
      if (label === 0xf9) {
        need(6);
        if (bytes[position] !== 4 || bytes[position + 5] !== 0) throw new Error('Invalid GIF control block');
        pendingDelay = word(position + 2) * 10;
        position += 6;
      } else { subBlocks(); }
      continue;
    }
    if (marker !== 0x2c) throw new Error('Invalid GIF block marker');
    need(9);
    const localPalette = bytes[position + 8];
    position += 9;
    if (localPalette & 0x80) { position += 3 * (1 << ((localPalette & 7) + 1)); need(0); }
    need(1);
    position++; // LZW minimum code size; actual decoding belongs to the renderer.
    subBlocks();
    frameCount++;
    if (frameCount > 4096) throw new Error('GIF frame limit exceeded');
    delaysMs.push(pendingDelay);
    pendingDelay = 0;
  }
  if (!trailer || !frameCount) throw new Error('Incomplete GIF image stream');
  return { format: header, width, height, frameCount, delaysMs, animated: frameCount > 1 };
}

function createSourceResolver(context) {
  if (!context || !context.moduleBase || typeof context.emit !== 'function') throw new Error('Resolver requires moduleBase and emit');
  const asPointer = context.ptr || ptr;
  const base = asPointer(context.moduleBase);
  const memory = context.memory || Memory;
  const interceptor = context.interceptor || Interceptor;
  const currentThreadId = context.currentThreadId || (() => Process.getCurrentThreadId());
  const now = context.now || (() => Date.now());
  const abi = context.abi;
  const options = Object.assign({ maxSourceBytes: 32 * 1024 * 1024, maxJobs: 16, timeoutMs: 45000, pollMs: 400, callsPerPump: 2, retryAfterMs: 30000, maxMetadataRecords: 256 }, context.options || {});
  const zero = asPointer(0);
  const types = {
    original: base.add(0x21b419c), thumbnail: base.add(0x21b4160), content: base.add(0x21ab29c),
    gdip: base.add(0x22242c4), webp: base.add(0x2223fd0), memory: base.add(0x22832dc)
  };
  const expectedCtor = '558bec6aff6866f9220264a100000000';
  const jobs = new Map();
  const requests = new Map();
  const retryAfter = new Map();
  const uncertainResources = [];
  const emittedKeys = new Set();
  let uiThreadId = context.uiThreadId === undefined ? null : Number(context.uiThreadId);
  let hook = null, running = false, stopping = false, nativeDepth = 0, pumping = false;
  let completed = 0, failures = 0, skippedNonUi = 0;

  function message(type, details) { context.emit(Object.assign({ component: 'gif-source-resolver', type, pid: context.pid }, details || {})); }
  function vtIs(object, expected) { return object && !object.isNull() && object.readPointer().equals(expected); }
  function requireUi(threadId) {
    if (typeof context.isUiThread === 'function') return !!context.isUiThread(threadId);
    return uiThreadId !== null && Number(threadId) === uiThreadId;
  }
  function withNative(fn) {
    if (!requireUi(currentThreadId())) throw new Error('Kakao call attempted outside UI thread');
    nativeDepth++;
    try { return fn(); } finally { nativeDepth--; }
  }
  function readyAbi() {
    const required = ['createOriginal', 'getImage', 'download', 'releaseShared', 'releaseVariant'];
    return !!abi && abi.verified === true && required.every(key => typeof abi[key] === 'function');
  }
  function verifyEntry(address, hex) {
    if (typeof context.verifyEntry === 'function') { context.verifyEntry(address, hex); return; }
    const actual = new Uint8Array(address.readByteArray(hex.length / 2));
    const encoded = Array.from(actual, value => value.toString(16).padStart(2, '0')).join('');
    if (encoded !== hex) throw new Error('Kakao entry guard mismatch at ' + address);
  }
  function ownedId(object, kind) {
    const chatOffset = kind === 'thumbnail' ? 0x30 : 0x28;
    const logOffset = kind === 'thumbnail' ? 0x38 : 0x30;
    const chatId = object.add(chatOffset).readU64().toString();
    const logId = object.add(logOffset).readU64().toString();
    return { chatId, logId, key: chatId + ':' + logId };
  }
  function stringBytes(data) {
    if (!data || data.isNull()) return null;
    const length = data.sub(8).readU32();
    if (!length || length > 8192) return null;
    return new Uint8Array(data.readByteArray(length));
  }
  function sameBytes(left, right) {
    return !!left && !!right && left.length === right.length && left.every((value, index) => value === right[index]);
  }
  function thumbnailIdentity(thumbnail) {
    const meta = ownedId(thumbnail, 'thumbnail');
    let sourceKey = null;
    try { sourceKey = stringBytes(thumbnail.add(0x50).readPointer()); } catch (_) {}
    if (sourceKey) {
      let hash = 0x811c9dc5;
      sourceKey.forEach(value => { hash = Math.imul(hash ^ value, 0x01000193) >>> 0; });
      meta.uriFingerprint = hash.toString(16).padStart(8, '0');
    }
    meta.assetKey = meta.key + (meta.uriFingerprint ? ':' + meta.uriFingerprint : '');
    return { meta, sourceKey };
  }
  function eligible(identity) {
    const id = identity.meta.assetKey;
    return !jobs.has(id) && !requests.has(id) && !emittedKeys.has(id) &&
      (!retryAfter.has(id) || retryAfter.get(id) <= now()) &&
      jobs.size + requests.size < options.maxJobs &&
      (typeof context.isChatTarget !== 'function' || context.isChatTarget(identity.meta));
  }
  function recordMatches(record, identity) {
    if (record.isNull() || record.readU64().toString() !== identity.meta.logId || record.add(8).readU64().toString() !== identity.meta.chatId) return false;
    return !identity.sourceKey || sameBytes(identity.sourceKey, stringBytes(record.add(0x30).readPointer()));
  }
  function clearPair(pair) { pair.writePointer(zero); pair.add(4).writePointer(zero); }
  function releaseOwned(job) {
    if (job.sharedConsumed || job.sharedReleaseStarted) return;
    job.sharedReleaseStarted = true;
    try {
      withNative(() => abi.releaseShared(job.shared));
      job.sharedConsumed = true;
      clearPair(job.shared);
    } catch (error) {
      job.state = 'cleanup-uncertain';
      job.error = String(error);
      message('cleanup-uncertain', { key: job.meta.key, error: String(error) });
      throw error;
    }
  }
  function finish(job, type, details) {
    job.state = type;
    if (type !== 'source') failures++;
    try { releaseOwned(job); }
    catch (_) { return; } // Never retry an uncertain native release or drop its tracking record.
    jobs.delete(job.meta.assetKey);
    retryAfter.set(job.meta.assetKey, now() + options.retryAfterMs);
    message(type, Object.assign({}, job.meta, details || {}));
  }
  function copyMemoryObject(object) {
    if (!vtIs(object, types.memory)) throw new Error('Unexpected encoded-memory type');
    const length = object.add(0xc).readU32();
    if (length < 14 || length > options.maxSourceBytes) throw new Error('Encoded source size outside configured bounds');
    if (typeof context.copyMemoryObject === 'function') return context.copyMemoryObject(object, length);
    const locked = object.add(0x10).readPointer();
    if (!locked.isNull()) return locked.readByteArray(length);
    const win32 = context.win32;
    if (!win32 || !win32.globalSize || !win32.globalLock || !win32.globalUnlock) throw new Error('Balanced Win32 global-memory access is unavailable');
    const handle = object.add(8).readPointer();
    if (handle.isNull()) throw new Error('Encoded global allocation is absent');
    const sizeValue = win32.globalSize(handle);
    const allocationSize = typeof sizeValue === 'number' ? sizeValue : Number(sizeValue.toString());
    if (!Number.isSafeInteger(allocationSize) || allocationSize < length) throw new Error('Encoded allocation is shorter than its logical length');
    const buffer = win32.globalLock(handle);
    if (buffer.isNull()) throw new Error('GlobalLock failed');
    try { return buffer.readByteArray(length); }
    finally { win32.globalUnlock(handle); }
  }
  function inspectVariant(variant) {
    const image = variant.readPointer();
    if (image.isNull()) return null;
    const tag = variant.add(4).readU8();
    let encoded;
    if (tag === 0 && vtIs(image, types.gdip)) encoded = image.add(0x18).readPointer();
    else if (tag === 1 && vtIs(image, types.webp)) encoded = image.add(0x60).readPointer();
    else throw new Error('Unexpected original image variant');
    if (encoded.isNull()) return null;
    const binary = copyMemoryObject(encoded);
    const headerBytes = new Uint8Array(binary).subarray(0, 6);
    const header = String.fromCharCode.apply(null, headerBytes);
    if (header !== 'GIF87a' && header !== 'GIF89a') return { binary: null, info: null, reason: 'not-gif' };
    const info = sourceResolverParseGif(binary);
    return { binary, info };
  }
  function probeOriginal(job) {
    const output = memory.alloc(8);
    clearPair(output);
    job.pendingVariant = output;
    try {
      withNative(() => abi.getImage(job.object, output));
      return inspectVariant(output);
    } finally {
      try {
        withNative(() => abi.releaseVariant(output));
        job.pendingVariant = null;
      } catch (error) {
        job.state = 'cleanup-uncertain';
        job.error = String(error);
        message('cleanup-uncertain', { key: job.meta.key, operation: 'variant', error: String(error) });
        throw error;
      }
    }
  }
  function createOwnedJob(identity, recordRef) {
    const meta = identity.meta;
    const record = recordRef.readPointer();
    if (!recordMatches(record, identity)) throw new Error('Image metadata identity changed');
    // The metadata reference is live only inside this constructor return callback.
    // Create its independently owned original container synchronously on the UI thread.
    const shared = memory.alloc(8);
    clearPair(shared);
    const job = { meta, shared, object: zero, state: 'creating', created: now(), nextPoll: 0, downloaded: false, sharedConsumed: false, sharedReleaseStarted: false };
    jobs.set(meta.assetKey, job);
    try {
      withNative(() => abi.createOriginal(shared, recordRef));
      job.object = shared.readPointer();
      if (!vtIs(job.object, types.original) || shared.add(4).readPointer().isNull()) throw new Error('Original factory returned unexpected ownership');
      const originalId = ownedId(job.object, 'original');
      if (originalId.key !== meta.key) throw new Error('Original factory returned a different image identity');
      job.state = 'queued';
      message('queued', meta);
    } catch (error) {
      finish(job, 'source-error', { error: String(error) });
    }
  }
  function acceptCtor(recordRef, thumbnail, threadId) {
    if (!running || stopping || nativeDepth || !readyAbi()) return;
    if (!requireUi(threadId)) { skippedNonUi++; return; }
    if (!vtIs(thumbnail, types.thumbnail) || thumbnail.add(0xc0).readU8() === 0) return;
    const identity = thumbnailIdentity(thumbnail);
    if (eligible(identity)) createOwnedJob(identity, recordRef);
  }
  function requestExisting(request) {
    if (!running || stopping) return false;
    if (!request || !vtIs(request.thumbnail, types.thumbnail) || !vtIs(request.content, types.content)) return false;
    if (request.thumbnail.add(0xc0).readU8() === 0) return false;
    const identity = thumbnailIdentity(request.thumbnail);
    const message = { lo: request.content.add(0x38).readU32(), hi: request.content.add(0x3c).readU32() };
    return requestMessage(message, identity.meta, identity.sourceKey);
  }
  function requestMessage(message, meta, sourceKey) {
    if (!running || stopping || !abi.getMetadata || !abi.releaseMetadataVector) return false;
    if (!message || !Number.isInteger(message.lo) || !Number.isInteger(message.hi) || !meta || !meta.key || !meta.chatId || !meta.logId) throw new Error('requestMessage requires uint32 lo/hi and image identity');
    const identity = { meta: Object.assign({}, meta), sourceKey: sourceKey ? new Uint8Array(sourceKey) : null };
    if (!identity.meta.assetKey) identity.meta.assetKey = identity.meta.key;
    if (!eligible(identity)) return false;
    requests.set(identity.meta.assetKey, { identity, message: { lo: message.lo >>> 0, hi: message.hi >>> 0 } });
    return true;
  }
  function resolveMetadata(request) {
    const identity = request.identity;
    const output = memory.alloc(12);
    clearPair(output);
    output.add(8).writePointer(zero);
    let constructed = false, getterReturned = false, structurallyValid = false;
    try {
      constructed = true;
      withNative(() => abi.getMetadata(output, request.message.lo, request.message.hi));
      getterReturned = true;
      const begin = output.readPointer(), end = output.add(4).readPointer(), capacity = output.add(8).readPointer();
      if (begin.isNull() && end.isNull() && capacity.isNull()) { structurallyValid = true; return false; }
      const low = Number(begin.toString()), high = Number(end.toString()), cap = Number(capacity.toString());
      if (begin.isNull() || high < low || cap < high || low % 4 || (high - low) % 8 || (cap - low) % 8) throw new Error('Unexpected metadata vector bounds');
      structurallyValid = true;
      if ((high - low) / 8 > options.maxMetadataRecords) throw new Error('Metadata vector exceeds configured record limit');
      if (stopping) return false;
      for (let offset = 0; offset < high - low; offset += 8) {
        const entry = begin.add(offset), record = entry.readPointer();
        if (!record.isNull() && !entry.add(4).readPointer().isNull() && recordMatches(record, identity)) {
          // Factory copies/retains its required fields while the real metadata vector still owns this record.
          createOwnedJob(identity, entry);
          return true;
        }
      }
      return false;
    } finally {
      if (constructed) {
        try {
          if (!getterReturned || !structurallyValid) {
            // A partially unwound getter or malformed ABI output is not proof of live ownership.
            if (!(output.readPointer().isNull() && output.add(4).readPointer().isNull() && output.add(8).readPointer().isNull())) throw new Error('Metadata vector ownership is uncertain; native destructor was not called');
          } else { withNative(() => abi.releaseMetadataVector(output)); }
        }
        catch (error) {
          uncertainResources.push({ kind: 'metadata-vector', output, key: identity.meta.assetKey, error: String(error) });
          message('cleanup-uncertain', { operation: 'metadata-vector', key: identity.meta.assetKey, error: String(error) });
          throw error;
        }
      }
    }
  }
  function start() {
    if (running) return { running: true };
    if (!readyAbi()) throw new Error('Verified factory, image, download, variant and shared-owner cleanup adapters are all required');
    verifyEntry(base.add(0xeb2c90), context.thumbnailCtorGuard || expectedCtor);
    hook = interceptor.attach(base.add(0xeb2c90), {
      onEnter(args) { this.gifSourceCapture = { recordRef: args[0], thumbnail: this.context.ecx, threadId: this.threadId }; },
      onLeave() {
        const capture = this.gifSourceCapture;
        if (!capture) return;
        try { acceptCtor(capture.recordRef, capture.thumbnail, capture.threadId); }
        catch (error) { message('capture-error', { error: String(error) }); }
      }
    });
    running = true;
    stopping = false;
    return { running: true, uiThreadId };
  }
  function pumpWork() {
    const threadId = currentThreadId();
    if (uiThreadId === null && typeof context.isUiThread !== 'function') uiThreadId = Number(threadId);
    if (!requireUi(threadId)) throw new Error('pump() must execute inside the selected chat UI thread callback');
    let calls = 0;
    if (stopping) requests.clear();
    for (const [key, request] of Array.from(requests.entries())) {
      if (calls >= options.callsPerPump) break;
      requests.delete(key);
      calls++;
      try {
        if (!resolveMetadata(request)) {
          retryAfter.set(key, now() + options.retryAfterMs);
          message('metadata-not-found', request.identity.meta);
        }
      } catch (error) {
        retryAfter.set(key, now() + options.retryAfterMs);
        message('metadata-error', Object.assign({}, request.identity.meta, { error: String(error) }));
      }
    }
    for (const job of Array.from(jobs.values())) {
      if (job.state === 'cleanup-uncertain') continue;
      if (stopping) { finish(job, 'cancelled'); continue; }
      if (calls >= options.callsPerPump || now() < job.nextPoll) continue;
      if (now() - job.created > options.timeoutMs) { finish(job, 'source-timeout'); continue; }
      calls++;
      try {
        const source = probeOriginal(job);
        if (source && source.info && source.info.animated) {
          context.emit(Object.assign({ component: 'gif-source-resolver', type: 'source', pid: context.pid }, job.meta, source.info, { byteLength: source.binary.byteLength }), source.binary);
          emittedKeys.add(job.meta.assetKey);
          completed++;
          // Source bytes are already copied. Release all native ownership on this UI scope.
          releaseOwned(job);
          jobs.delete(job.meta.assetKey);
          continue;
        }
        if (!job.downloaded) {
          job.downloadResult = withNative(() => abi.download(job.object));
          job.downloaded = true;
          job.state = 'waiting';
          message('download-requested', Object.assign({}, job.meta, { result: job.downloadResult }));
        } else if (source && Number(job.downloadResult) === 1) {
          finish(job, 'static-source', { frameCount: source.info ? source.info.frameCount : 0, reason: source.reason });
          continue;
        }
        job.nextPoll = now() + options.pollMs;
      } catch (error) {
        if (job.state !== 'cleanup-uncertain') finish(job, 'source-error', { error: String(error) });
      }
    }
    return status();
  }
  function pump() {
    const threadId = currentThreadId();
    if (uiThreadId === null && typeof context.isUiThread !== 'function') uiThreadId = Number(threadId);
    if (!requireUi(threadId)) throw new Error('pump() must execute inside the selected chat UI thread callback');
    // Kakao can synchronously send paint callbacks from a factory/download/GetImage call.
    if (pumping || nativeDepth) return status();
    pumping = true;
    try { pumpWork(); }
    finally { pumping = false; }
    return status();
  }
  function stop() {
    stopping = true;
    running = false;
    if (hook) { hook.detach(); hook = null; }
    if (typeof context.requestUiPump === 'function') context.requestUiPump();
    return status();
  }
  function status() {
    return { running, stopping, uiThreadId, nativeDepth, pumping, active: jobs.size, queuedMetadata: requests.size, uncertainResources: uncertainResources.length, completed, failures, skippedNonUi, canUnload: !pumping && nativeDepth === 0 && jobs.size === 0 && requests.size === 0 && uncertainResources.length === 0,
      jobs: Array.from(jobs.values()).map(job => ({ key: job.meta.assetKey, state: job.state, downloaded: job.downloaded, ageMs: now() - job.created, error: job.error })) };
  }
  return { start, pump, stop, status, requestExisting, requestMessage };
}

if (typeof globalThis !== 'undefined') {
  globalThis.createSourceResolver = createSourceResolver;
  globalThis.sourceResolverParseGif = sourceResolverParseGif;
}
