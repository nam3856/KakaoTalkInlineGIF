const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const directory = path.resolve(__dirname, '../src/agent');
const sandbox = { Uint8Array, ArrayBuffer, Number, String, Math, Date, Map, Set, Object, Array, Error };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(directory, 'source-resolver.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(directory, 'native-abi.js'), 'utf8'), sandbox);

function gif(frames) {
  const header = [71,73,70,56,57,97,1,0,1,0,0x80,0,0,0,0,0,255,255,255];
  const frame = [0x21,0xf9,4,0,2,0,0,0,0x2c,0,0,0,0,1,0,1,0,0,2,2,0x44,1,0];
  return Uint8Array.from(header.concat(...Array.from({length:frames}, () => frame), [0x3b])).buffer;
}
class FakeMemory {
  constructor() { this.bytes = new Map(); this.next = 0x10000000; this.thread = 7; this.time = 1000; }
  ptr(value) { return value instanceof FakePointer ? value : new FakePointer(this, Number(value) >>> 0); }
  alloc(size) { const result = this.ptr(this.next); this.next += (size + 15) & ~15; return result; }
  read(address, size) { return Uint8Array.from({length:size}, (_, i) => this.bytes.get((address + i) >>> 0) || 0); }
  write(address, values) { Array.from(values).forEach((value, i) => this.bytes.set((address + i) >>> 0, value)); }
  protect() { return true; }
}
class FakePointer {
  constructor(memory, address) { this.memory = memory; this.address = address; }
  add(value) { return this.memory.ptr((this.address + Number(value)) >>> 0); }
  sub(value) { return this.memory.ptr((this.address - (value instanceof FakePointer ? value.address : Number(value))) >>> 0); }
  equals(other) { return this.address === other.address; }
  isNull() { return this.address === 0; }
  toString() { return '0x' + this.address.toString(16); }
  toInt32() { return this.address | 0; }
  readU8() { return this.memory.read(this.address, 1)[0]; }
  writeU8(value) { this.memory.write(this.address, [value & 255]); return this; }
  readU32() { const b=this.memory.read(this.address,4); return (b[0]|b[1]<<8|b[2]<<16|b[3]<<24)>>>0; }
  writeU32(value) { this.memory.write(this.address,[value&255,value>>>8&255,value>>>16&255,value>>>24&255]); return this; }
  readU64() { let result=0n; for(let i=7;i>=0;i--) result=(result<<8n)|BigInt(this.memory.read(this.address+i,1)[0]); return result; }
  writeU64(value) { let n=BigInt(value); for(let i=0;i<8;i++){this.add(i).writeU8(Number(n&255n));n>>=8n;} return this; }
  readPointer() { return this.memory.ptr(this.readU32()); }
  writePointer(value) { return this.writeU32(this.memory.ptr(value).address); }
  readByteArray(size) { return this.memory.read(this.address,size).buffer; }
  writeByteArray(bytes) { this.memory.write(this.address,bytes); return this; }
}
function environment(options={}) {
  const mem=new FakeMemory(), base=mem.ptr(0x400000), hooks=new Map(), messages=[];
  const counters={shared:0,images:0,metadata:0,vectors:0,factory:0,releaseShared:0,releaseVariant:0,downloads:0};
  const records=new Map(), originals=new Map(), encoded=new Map();
  const at=va=>mem.ptr(va);
  function text(value) { const bytes=Buffer.from(value);const raw=mem.alloc(bytes.length+17),data=raw.add(16);data.sub(8).writeU32(bytes.length);data.writeByteArray(bytes);return data; }
  function record(log='12',chat='34',uri='https://example.invalid/a.gif',data=gif(2)) {
    const object=mem.alloc(0x140),ref=mem.alloc(8);object.writeU64(log);object.add(8).writeU64(chat);object.add(0x30).writePointer(text(uri));ref.writePointer(object);ref.add(4).writePointer(mem.alloc(16));
    records.set(object.toString(),{log,chat,data,uri});return {object,ref};
  }
  function thumbnail(item) {const p=mem.alloc(0xc8);p.writePointer(at(0x25b4160));p.add(0x30).writeU64(item.chat);p.add(0x38).writeU64(item.log);p.add(0x50).writePointer(text(item.uri));p.add(0xc0).writeU8(1);return p;}
  const metadata=record();
  const item=records.get(metadata.object.toString());
  const thumb=thumbnail(item),content=mem.alloc(0x50);content.writePointer(at(0x25ab29c));content.add(0x38).writeU64(item.log);
  let releaseThrows=!!options.releaseThrows;
  const abi={verified:true,
    createOriginal(out,recordRef){
      const recordData=records.get(recordRef.readPointer().toString());assert.ok(recordData,'factory receives live real record');
      const object=mem.alloc(0xd0),ctrl=mem.alloc(16),image=mem.alloc(0x70),memory=mem.alloc(20);
      object.writePointer(at(0x25b419c));object.add(0x28).writeU64(recordData.chat);object.add(0x30).writeU64(recordData.log);ctrl.writePointer(at(0x25a4570));
      image.writePointer(at(0x26242c4));image.add(0x18).writePointer(memory);memory.writePointer(at(0x26832dc));memory.add(0xc).writeU32(recordData.data.byteLength);encoded.set(memory.toString(),recordData.data);
      originals.set(object.toString(),{image,ready:!!options.ready});out.writePointer(object);out.add(4).writePointer(ctrl);counters.shared++;counters.factory++;
    },
    getImage(object,out){const state=originals.get(object.toString());if(state.ready){out.writePointer(state.image);out.add(4).writeU8(0);counters.images++;if(options.getImageThrows)throw Error('injected GetImage error after retained result');}return out;},
    download(object){counters.downloads++;const state=originals.get(object.toString());if(state.ready)return 1;if(options.neverReady)return 0;state.ready=true;return 0;},
    releaseShared(out){counters.releaseShared++;if(releaseThrows){releaseThrows=false;throw Error('injected uncertain native release');}if(!out.add(4).readPointer().isNull())counters.shared--;out.writePointer(at(0));out.add(4).writePointer(at(0));},
    releaseVariant(out){counters.releaseVariant++;if(!out.readPointer().isNull())counters.images--;out.writePointer(at(0));out.add(4).writeU8(255);},
    getMetadata(out){
      const entries=options.metadataRecords||[metadata];const data=mem.alloc(entries.length*8);
      entries.forEach((r,i)=>{data.add(i*8).writePointer(r.object);data.add(i*8+4).writePointer(r.ref.add(4).readPointer());counters.metadata++;});
      out.writePointer(data);out.add(4).writePointer(data.add(entries.length*8));out.add(8).writePointer(data.add(entries.length*8));counters.vectors++;return 1;
    },
    releaseMetadataVector(out){const n=(Number(out.add(4).readPointer().toString())-Number(out.readPointer().toString()))/8;counters.metadata-=n;counters.vectors--;out.writePointer(at(0));out.add(4).writePointer(at(0));out.add(8).writePointer(at(0));}
  };
  const context={moduleBase:base,pid:123,ptr:value=>mem.ptr(value),memory:mem,uiThreadId:7,currentThreadId:()=>mem.thread,now:()=>mem.time,abi,
    verifyEntry(){},isChatTarget:()=>true,copyMemoryObject:(p)=>encoded.get(p.toString()).slice(0),emit:(meta,binary)=>messages.push({meta,binary}),
    interceptor:{attach(address,callbacks){hooks.set(address.toString(),callbacks);return {detach(){hooks.delete(address.toString());}};}}
  };
  const resolver=sandbox.createSourceResolver(context);
  function trigger(which=metadata,widget=thumb){const cb=hooks.get(at(0x12b2c90).toString());assert.ok(cb);const invocation={context:{ecx:widget},threadId:mem.thread};cb.onEnter.call(invocation,[which.ref]);cb.onLeave.call(invocation,at(0));}
  return {mem,abi,counters,messages,resolver,trigger,thumb,content,metadata,record,thumbnail,records,context};
}
const tests=[];
function test(name,fn){fn();tests.push(name);}
test('GIF parser distinguishes animated originals from one-frame GIF thumbnails',()=>{assert.equal(sandbox.sourceResolverParseGif(gif(1)).animated,false);assert.equal(sandbox.sourceResolverParseGif(gif(2)).frameCount,2);assert.throws(()=>sandbox.sourceResolverParseGif(gif(2).slice(0,-1)),/Incomplete/);});
test('Future constructor resolves once and balances shared and variant owners',()=>{const e=environment();e.resolver.start();e.trigger();assert.equal(e.counters.shared,1);e.resolver.pump();e.mem.time+=500;e.resolver.pump();assert.equal(e.messages.filter(x=>x.binary).length,1);assert.equal(e.counters.shared,0);assert.equal(e.counters.images,0);assert.equal(e.resolver.status().canUnload,true);e.trigger();assert.equal(e.counters.factory,1);});
test('Non-UI constructor never queues a stale metadata reference or calls app code',()=>{const e=environment();e.resolver.start();e.mem.thread=9;e.trigger();assert.equal(e.counters.factory,0);assert.equal(e.resolver.status().skippedNonUi,1);assert.throws(()=>e.resolver.pump(),/UI thread/);});
test('Static GIF source is rejected and both native owner types are released',()=>{const e=environment({ready:true});e.records.get(e.metadata.object.toString()).data=gif(1);e.resolver.start();e.trigger();e.resolver.pump();e.mem.time+=500;e.resolver.pump();assert.equal(e.messages.filter(x=>x.binary).length,0);assert.equal(e.counters.shared,0);assert.equal(e.counters.images,0);assert.ok(e.messages.some(x=>x.meta.type==='static-source'));});
test('GetImage failure after retaining output still releases variant and shared owner',()=>{const e=environment({ready:true,getImageThrows:true});e.resolver.start();e.trigger();e.resolver.pump();assert.equal(e.counters.shared,0);assert.equal(e.counters.images,0);assert.ok(e.messages.some(x=>x.meta.type==='source-error'));});
test('Stop requires UI drain and releases a pending download exactly once',()=>{const e=environment({neverReady:true});e.resolver.start();e.trigger();e.resolver.pump();e.resolver.stop();assert.equal(e.resolver.status().canUnload,false);e.resolver.pump();e.resolver.pump();assert.equal(e.counters.shared,0);assert.equal(e.counters.releaseShared,1);assert.equal(e.resolver.status().canUnload,true);});
test('An uncertain native release is tracked and never attempted twice',()=>{const e=environment({ready:true,releaseThrows:true});e.resolver.start();e.trigger();e.resolver.pump();e.resolver.stop();e.resolver.pump();assert.equal(e.counters.releaseShared,1);assert.equal(e.resolver.status().canUnload,false);assert.equal(e.resolver.status().jobs[0].state,'cleanup-uncertain');});
test('Existing message route destroys metadata vector after creating its independent owner',()=>{const e=environment({ready:true});e.resolver.start();assert.equal(e.resolver.requestExisting({thumbnail:e.thumb,content:e.content}),true);assert.equal(e.resolver.requestExisting({thumbnail:e.thumb,content:e.content}),false);e.resolver.pump();assert.equal(e.messages.filter(x=>x.binary).length,1);assert.equal(e.counters.metadata,0);assert.equal(e.counters.vectors,0);assert.equal(e.counters.shared,0);assert.equal(e.counters.images,0);assert.equal(e.resolver.status().canUnload,true);assert.ok(!JSON.stringify(e.messages.map(x=>x.meta)).includes('https://'));});
test('Existing metadata match checks URI bytes when message and chat IDs coincide',()=>{const e=environment({ready:true});const wrong=e.record('12','34','https://example.invalid/other.gif');e.abi.getMetadata=(out)=>{const data=e.mem.alloc(16);[wrong,e.metadata].forEach((r,i)=>{data.add(i*8).writePointer(r.object);data.add(i*8+4).writePointer(r.ref.add(4).readPointer());e.counters.metadata++;});out.writePointer(data);out.add(4).writePointer(data.add(16));out.add(8).writePointer(data.add(16));e.counters.vectors++;return 1;};e.resolver.start();e.resolver.requestExisting({thumbnail:e.thumb,content:e.content});e.resolver.pump();assert.equal(e.counters.factory,1);assert.equal(e.counters.metadata,0);assert.equal(e.messages.filter(x=>x.binary).length,1);});
test('Missing ownership proof blocks activation before attaching a constructor hook',()=>{const e=environment();e.abi.verified=false;assert.throws(()=>e.resolver.start(),/Verified factory/);assert.equal(e.counters.factory,0);});
test('Malformed metadata output is never passed to an unsafe native vector destructor',()=>{const e=environment();let releases=0;e.abi.getMetadata=out=>{const p=e.mem.alloc(16);out.writePointer(p);out.add(4).writePointer(p.sub(8));out.add(8).writePointer(p.add(16));return 1;};e.abi.releaseMetadataVector=()=>{releases++;};e.resolver.start();e.resolver.requestExisting({thumbnail:e.thumb,content:e.content});e.resolver.pump();assert.equal(releases,0);assert.equal(e.resolver.status().uncertainResources,1);assert.equal(e.resolver.status().canUnload,false);});
test('A throwing getter with zero output needs no native cleanup and preserves its error',()=>{const e=environment();let releases=0;e.abi.getMetadata=()=>{throw Error('empty getter failure');};e.abi.releaseMetadataVector=()=>{releases++;};e.resolver.start();e.resolver.requestExisting({thumbnail:e.thumb,content:e.content});e.resolver.pump();assert.equal(releases,0);assert.equal(e.resolver.status().canUnload,true);assert.ok(e.messages.some(x=>x.meta.type==='metadata-error'));});
test('A partially unwound metadata getter is tracked without double-freeing its output',()=>{const e=environment();let releases=0;e.abi.getMetadata=out=>{const p=e.mem.alloc(8);out.writePointer(p);out.add(4).writePointer(p.add(8));out.add(8).writePointer(p.add(8));throw Error('partially unwound getter');};e.abi.releaseMetadataVector=()=>{releases++;};e.resolver.start();e.resolver.requestExisting({thumbnail:e.thumb,content:e.content});e.resolver.pump();assert.equal(releases,0);assert.equal(e.resolver.status().uncertainResources,1);});
test('Frida Windows ABI enum uses mscdecl for the private caller-cleaned shim',()=>{const m=new FakeMemory(),allowed=new Set(['sysv','stdcall','thiscall','fastcall','mscdecl']);sandbox.createSourceResolverNativeAbi({moduleBase:m.ptr(0x400000),ptr:x=>m.ptr(x),pointerSize:4,pageSize:4096,memory:m,verifyEntry(){},nativeFunction:(address,result,args,abi)=>{assert.ok(allowed.has(abi),'unsupported Frida ABI '+abi);return ()=>0;}});});
test('Synchronous nested UI paint pumps cannot reenter factory or image resolution',()=>{const e=environment({ready:true});const factory=e.abi.createOriginal,getImage=e.abi.getImage;e.abi.createOriginal=(...args)=>{e.resolver.pump();return factory(...args);};e.abi.getImage=(...args)=>{e.resolver.pump();return getImage(...args);};e.resolver.start();e.trigger();e.resolver.pump();assert.equal(e.counters.factory,1);assert.equal(e.messages.filter(x=>x.binary).length,1);assert.equal(e.counters.shared,0);assert.equal(e.counters.images,0);});
test('Shutdown cannot unload the private shim while a cooperative metadata native call is in flight',()=>{const e=environment();const getter=e.abi.getMetadata;let inFlight;e.abi.getMetadata=(...args)=>{e.resolver.stop();inFlight=e.resolver.status();return getter(...args);};e.resolver.start();e.resolver.requestExisting({thumbnail:e.thumb,content:e.content});const drained=e.resolver.pump();assert.equal(inFlight.canUnload,false);assert.equal(inFlight.nativeDepth,1);assert.equal(e.counters.factory,0);assert.equal(e.counters.metadata,0);assert.equal(e.counters.vectors,0);assert.equal(drained.canUnload,true);});
test('Native adapter builds only the verified ABI wrappers and private cdecl metadata shim',()=>{const mem=new FakeMemory(),calls=[],guards=[];let factoryOut;const base=mem.ptr(0x400000);const functions=(address,result,args,abi)=>{calls.push({address:address.toString(),result,args,abi});return (...params)=>{if(address.equals(mem.ptr(0x143c050))){factoryOut=params[0];const object=mem.alloc(0xd0),ctrl=mem.alloc(16);object.writePointer(mem.ptr(0x25b419c));ctrl.writePointer(mem.ptr(0x25a4570));params[0].writePointer(object);params[0].add(4).writePointer(ctrl);return params[0];}return params[1]||0;};};const adapter=sandbox.createSourceResolverNativeAbi({moduleBase:base,ptr:x=>mem.ptr(x),pointerSize:4,pageSize:4096,memory:mem,nativeFunction:functions,verifyEntry:(p,h)=>guards.push({p:p.toString(),h})});const ref=mem.alloc(8);ref.writePointer(mem.alloc(16));const out=mem.alloc(8);adapter.createOriginal(out,ref);assert.ok(factoryOut.equals(out));adapter.releaseShared(out);assert.ok(out.readPointer().isNull());assert.equal(calls.find(x=>x.address==='0x143c050').abi,'fastcall');assert.equal(calls.find(x=>x.address==='0x176fa50').abi,'stdcall');assert.equal(calls.find(x=>x.address===adapter.metadataShimAllocation.toString()).abi,'mscdecl');assert.equal(adapter.metadataShimAllocation.readByteArray(22).byteLength,22);assert.deepEqual(Array.from(new Uint8Array(adapter.metadataShimAllocation.readByteArray(13))),[0x55,0x8b,0xec,0xff,0x75,0x10,0xff,0x75,0x0c,0x8b,0x4d,0x08,0xe8]);assert.equal(guards.length,7);});
const report={passed:tests.length,tests,scope:'Synthetic ownership, state machine, GIF parsing, ABI wrapper construction and private shim bytes only. No Kakao process access, attachment, calls, downloads or code changes.'};
if (process.env.INLINEGIF_TEST_REPORT) fs.writeFileSync(process.env.INLINEGIF_TEST_REPORT,JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
