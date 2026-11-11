import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import path from 'node:path';

// Run the real host control flow with synthetic filesystem/process/Frida APIs.
// No child process, native binding, installed application or registry is used.
const hostPath=process.argv[2]||fileURLToPath(new URL('../src/host/host.mjs',import.meta.url));
const source=await readFile(hostPath,'utf8');
const supportedHash='ec0f43b67cc7e81544464f649a5dfbd690776968014d34d7c554b7a9382a2290';
assert.ok(source.includes("const supportedHash='"+supportedHash+"'"),'The production compatibility hash must remain pinned');
const imports=source.match(/^import .*;\r?$/gm)||[];
assert.equal(imports.length,5,'Update the mock module loader if production imports change');
const runnable=source.replace(/^import .*;\r?\n/gm,'')
  .replaceAll('import.meta.url',JSON.stringify('file:///C:/SyntheticInlineGif/host.mjs'))
  .replace('await import(','await importFrida(');

async function run(scenario={}){
  const events=[],logs=[],states=[],files=new Map(),timers=new Set();
  let elapsed=0,attachCount=0,enumerations=0,controlReads=0;
  const epoch=Date.UTC(2030,0,1),realSetTimeout=setTimeout,realClearTimeout=clearTimeout;
  class ClockDate extends Date{constructor(...args){super(...(args.length?args:[epoch+elapsed]));}static now(){return epoch+elapsed;}}
  const record=(kind,detail={})=>events.push({kind,at:elapsed,...detail});
  function schedule(callback,ms){
    const token=realSetTimeout(()=>{timers.delete(token);elapsed+=ms;callback();},Math.min(2,Math.max(0,ms/2500)));
    timers.add(token);return token;
  }
  function clear(token){timers.delete(token);realClearTimeout(token);}
  const fakeProcess={pid:9100,env:{'ProgramFiles(x86)':'C:\\Program Files (x86)'},exitCode:undefined,on(){}};
  const control={enabled:true,shutdown:false};
  const failMissing=()=>{const error=new Error('Synthetic file is absent');error.code='ENOENT';throw error;};
  const read=async file=>{
    const name=String(file);
    if(name.endsWith('control.json')){controlReads++;return JSON.stringify(control);}
    if(name.endsWith('KakaoTalk.exe'))return Buffer.from('synthetic supported artifact');
    if(name.includes('agent')&&name.endsWith('.js'))return '// synthetic agent component';
    return files.has(name)?files.get(name):failMissing();
  };
  const rename=async(from,to)=>{
    files.set(to,files.get(from));files.delete(from);
    if(String(to).endsWith('host-state.json')){
      const state=JSON.parse(files.get(to));states.push(state);record('state',{state:state.state});
      if(state.state==='running'&&!scenario.reconnectAfterHealthy)control.shutdown=true;
      if(state.state==='waiting-for-runtime'&&scenario.stopDuringRetry)control.shutdown=true;
    }
  };
  const fakeFrida={
    async getLocalDevice(){return{async enumerateProcesses(){
      const pid=scenario.pidForEnumeration?.(++enumerations)||7301;
      return[{pid,name:'KakaoTalk.exe'}];
    }};},
    async attach(pid){
      const attempt=++attachCount;record('attach',{attempt,pid});
      const behavior=scenario.behavior?.(attempt)||'healthy';
      let detachedCallback,listener,ready=false,shuttingDown=false;
      return{
        detached:{connect(fn){detachedCallback=fn;}},
        async createScript(){
          record('create-script',{attempt});
          const emit=message=>{record('message',{attempt,messageType:message.type,eventKind:message.payload?.kind});listener(message);};
          const exports=new Proxy({}, {get(_target,name){return async(...args)=>{
            record('rpc',{attempt,name});
            if(!ready)throw new Error('RPC absent before runtime-ready: '+String(name));
            if(name==='initialize')return{ready:true,pid,widgets:0,thumbnails:0};
            if(name==='shutdown'){shuttingDown=true;return{canUnload:!scenario.nativeDrain};}
            if(name==='snapshot'){
              if(!shuttingDown&&scenario.reconnectAfterHealthy&&attempt===1){queueMicrotask(()=>{record('external-detach',{attempt});detachedCallback();});}
              return{owners:{},tracked:0,paintCount:0,sourceErrors:0,resolver:{canUnload:true}};
            }
            if(!['setKnownAssets','setEnabled','dispose'].includes(String(name)))throw new Error('Unexpected mock RPC '+String(name));
          };}});
          return{
            exports,message:{connect(fn){listener=fn;}},
            async load(){
              record('load',{attempt});
              if(behavior==='load-reject')throw new Error('Synthetic script.load rejection');
              if(behavior==='timeout'){record('load-resolved',{attempt});return;}
              if(['guard-error','early-error'].includes(behavior)){
                record('load-resolved',{attempt});
                queueMicrotask(()=>emit({type:'error',description:behavior==='guard-error'?'Error: Unsupported runtime bytes at 0x12345678':'Synthetic early bootstrap fault'}));
                return;
              }
              if(behavior==='wrong-pid'){emit({type:'send',payload:{kind:'runtime-ready',ready:true,pid:pid+1}});return;}
              if(behavior==='not-ready'){emit({type:'send',payload:{kind:'runtime-ready',ready:false,pid}});return;}
              ready=true;emit({type:'send',payload:{kind:'runtime-ready',ready:true,pid}});
              if(behavior==='ready-then-load-reject')throw new Error('Synthetic load failure after readiness');
              record('load-resolved',{attempt});
            },
            async unload(){record('unload',{attempt});if(scenario.unloadReject)throw new Error('Synthetic unload failure');}
          };
        },
        async detach(){record('detach',{attempt});detachedCallback();}
      };
    }
  };
  const sandbox={Buffer,Date:ClockDate,Promise,queueMicrotask,setTimeout:schedule,clearTimeout:clear,process:fakeProcess,
    console:{log(line){logs.push(JSON.parse(line));record('log',{type:logs.at(-1).type});}},
    path,fileURLToPath,pathToFileURL:value=>({href:'file:///'+value}),
    importFrida:async()=>fakeFrida,
    readFile:read,writeFile:async(file,value)=>{files.set(file,String(value));},rename,mkdir:async()=>{},access:async()=>failMissing(),
    open:async()=>{throw new Error('Unexpected filesystem open');},stat:async()=>{throw new Error('Unexpected stat');},unlink:async file=>{files.delete(file);},
    createHash:()=>({update(){return this;},digest(){return supportedHash;}}),
    spawn(){throw new Error('The startup scenarios must not launch a renderer');}
  };
  const context=vm.createContext(sandbox);
  let deadline;
  try{
    await Promise.race([
      vm.runInContext('(async()=>{\n'+runnable+'\n})()',context,{filename:'synthetic-host.mjs',timeout:1000}),
      new Promise((_,reject)=>{deadline=realSetTimeout(()=>reject(new Error('Synthetic host did not finish')),3000);})
    ]);
    assert.equal(timers.size,0,'Startup/cleanup must not leave a readiness or retry timer pending');
    return{events,logs,states,attachCount,controlReads,elapsed,exitCode:fakeProcess.exitCode};
  }finally{realClearTimeout(deadline);for(const timer of timers)realClearTimeout(timer);}
}

const passed=[];
async function test(name,check){await check();passed.push(name);}
const count=(r,kind)=>r.events.filter(e=>e.kind===kind).length;
function assertEarlyCleanup(result,attempts=1){
  assert.equal(result.attachCount,attempts);assert.equal(count(result,'rpc'),0);
  assert.equal(count(result,'unload'),attempts);assert.equal(count(result,'detach'),attempts);
  assert.equal(result.states.at(-1).state,'stopped');assert.equal(result.states.at(-1).clean,true);
}
await test('resolved-script-load-plus-early-agent-error-unloads-and-detaches-without-any-rpc',async()=>{
  const r=await run({behavior:()=> 'early-error'});assertEarlyCleanup(r);assert.equal(r.exitCode,1);
  assert.ok(r.logs.some(l=>l.type==='host-error'&&l.error.includes('Synthetic early bootstrap fault')));
});
await test('missing-runtime-ready-times-out-and-cleans-up-without-native-rpc',async()=>{
  const r=await run({behavior:()=> 'timeout'});assertEarlyCleanup(r);assert.ok(r.elapsed>=5000);
  assert.ok(r.logs.some(l=>l.type==='host-error'&&l.error.includes('did not report readiness')));
});
await test('script-load-rejection-does-not-leave-a-readiness-timer-or-call-absent-rpc',async()=>{
  const r=await run({behavior:()=> 'load-reject'});assertEarlyCleanup(r);
});
await test('wrong-ready-pid-and-ready-false-are-rejected-before-rpc',async()=>{
  assertEarlyCleanup(await run({behavior:()=> 'wrong-pid'}));
  assertEarlyCleanup(await run({behavior:()=> 'not-ready'}));
});
await test('healthy-runtime-readiness-precedes-rpc-and-native-cleanup-drains-before-unload',async()=>{
  const r=await run({nativeDrain:true});
  const names=r.events.filter(e=>e.kind==='rpc').map(e=>e.name);
  assert.deepEqual(names,['setKnownAssets','initialize','setEnabled','snapshot','shutdown','snapshot','dispose']);
  const ready=r.events.findIndex(e=>e.kind==='message'&&e.eventKind==='runtime-ready');
  assert.ok(ready<r.events.findIndex(e=>e.kind==='rpc'));
  assert.ok(r.events.findIndex(e=>e.kind==='rpc'&&e.name==='dispose')<r.events.findIndex(e=>e.kind==='unload'));
  assert.equal(count(r,'detach'),1);assert.equal(r.states.at(-1).clean,true);
});
await test('readiness-followed-by-load-error-still-uses-native-shutdown-and-dispose',async()=>{
  const r=await run({behavior:()=> 'ready-then-load-reject'});
  assert.deepEqual(r.events.filter(e=>e.kind==='rpc').map(e=>e.name),['shutdown','dispose']);
  assert.equal(count(r,'unload'),1);assert.equal(count(r,'detach'),1);
});
await test('early-unload-failure-still-attempts-session-detach',async()=>{
  const r=await run({behavior:()=> 'early-error',unloadReject:true});
  assert.equal(count(r,'rpc'),0);assert.equal(count(r,'unload'),1);assert.equal(count(r,'detach'),1);
  assert.equal(r.states.at(-1).state,'cleanup-pending');
});
await test('strict-byte-guard-error-retries-only-after-cleanup-and-five-second-delay',async()=>{
  const r=await run({behavior:attempt=>attempt===1?'guard-error':'healthy'});
  assert.equal(r.attachCount,2);assert.equal(count(r,'unload'),2);assert.equal(count(r,'detach'),2);
  const attached=r.events.filter(e=>e.kind==='attach');assert.ok(attached[1].at-attached[0].at>=5000);
  assert.equal(r.logs.filter(l=>l.type==='startup-retry').length,1);
  assert.ok(r.controlReads>2);assert.equal(r.exitCode,undefined);
});
await test('byte-guard-retry-limit-is-six-total-attempts-with-no-rpc-or-native-ownership',async()=>{
  const r=await run({behavior:()=> 'guard-error'});assertEarlyCleanup(r,6);
  assert.deepEqual(r.logs.filter(l=>l.type==='startup-retry').map(l=>l.attempt),[1,2,3,4,5]);
  assert.equal(r.exitCode,1);
});
await test('shutdown-control-interrupts-the-retry-delay-without-another-attach',async()=>{
  const r=await run({behavior:()=> 'guard-error',stopDuringRetry:true});assertEarlyCleanup(r);
  assert.ok(r.elapsed<5000);assert.equal(r.exitCode,undefined);
});
await test('new-pid-resets-the-bounded-startup-attempt-counter',async()=>{
  const r=await run({behavior:()=> 'guard-error',pidForEnumeration:n=>n<=5?7301:7302});assertEarlyCleanup(r,11);
  assert.deepEqual(r.logs.filter(l=>l.type==='startup-retry').map(l=>l.attempt),[1,2,3,4,5,1,2,3,4,5]);
});
await test('healthy-startup-resets-counter-before-a-later-session-reconnect',async()=>{
  const r=await run({behavior:n=>n===1?'healthy':'guard-error',reconnectAfterHealthy:true});
  assert.equal(r.attachCount,7);assert.equal(count(r,'unload'),6);assert.equal(count(r,'detach'),6);
  assert.deepEqual(r.logs.filter(l=>l.type==='startup-retry').map(l=>l.attempt),[1,2,3,4,5]);
});
const result={success:true,total:passed.length,scope:'Real host code in a VM with fake Frida, filesystem, clock and process only; no native binding, KakaoTalk, child process or registry access',passed};
if(process.env.INLINEGIF_HOST_TEST_REPORT)await writeFile(process.env.INLINEGIF_HOST_TEST_REPORT,JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
