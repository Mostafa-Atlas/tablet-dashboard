const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
async function fixture(t,{initial,files,fetchImpl,env={}}={}) {
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'dashboard-backend-'));
 t.after(()=>fsp.rm(dir,{recursive:true,force:true}));
 if(initial) await fsp.writeFile(path.join(dir,'db.json'),JSON.stringify(initial));
 for(const [name,value] of Object.entries(files || {})) await fsp.writeFile(path.join(dir,name),value);
 const original = { ADMIN_USER:process.env.ADMIN_USER, ADMIN_PASS:process.env.ADMIN_PASS, APP_TIMEZONE:process.env.APP_TIMEZONE };
 for(const key of Object.keys(original)) delete process.env[key];
 Object.assign(process.env,env);
 let dashboard;
 try { dashboard=require('../server').createDashboard({dataDir:dir,fetchImpl:fetchImpl || (async()=>{throw new Error('offline fixture')})}); await dashboard.ready; }
 finally { for(const [key,value] of Object.entries(original)) {if(value===undefined) delete process.env[key];else process.env[key]=value;} }
 t.after(()=>dashboard.stopBackground());
 const {app}=dashboard;
 const server=app.listen(0,'127.0.0.1');
 await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)});
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}`;
 let token;
 async function request(route,method='GET',body) {
  const response=await fetch(url+route,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
 }
 return {dir,request,async login(){const r=await request('/api/login','POST',{user:'owner',pass:'test-password'});token=r.body.token;return r},async setup(){const r=await request('/api/setup','POST',{user:'owner',pass:'test-password'});token=r.body.token;return r}};
}
test('corrupt primary recovers backup without overwriting accounts',async t=>{
 const backup={users:[{user:'saved',salt:'salt',hash:'hash'}],todos:[],timers:[],pc:{},weather:{}};
 const f=await fixture(t,{files:{'db.json':'broken','db.json.bak':JSON.stringify(backup)}});
 assert.equal((await f.request('/api/me')).body.needsSetup,false);
 assert.equal(JSON.parse(await fsp.readFile(path.join(f.dir,'db.json'))).users[0].user,'saved');
});
test('corrupt primary and backup fail startup and preserve originals',async t=>{
 await assert.rejects(fixture(t,{files:{'db.json':'broken','db.json.bak':'also broken'}}),/recover|corrupt|valid/i);
});
test('durable overlapping saves retain every item after response',async t=>{
 const f=await fixture(t); await f.setup();
 const results=await Promise.all(Array.from({length:12},(_,i)=>f.request('/api/todos','POST',{text:'item '+i})));
 assert.ok(results.every(r=>r.status===200));
 const stored=JSON.parse(await fsp.readFile(path.join(f.dir,'db.json'),'utf8'));
 assert.equal(stored.todos.filter(x=>x.text.startsWith('item ')).length,12);
 assert.equal(stored.users[0].user,'owner');
});
test('failed durable mutation returns error and retains existing state',async t=>{
 const f=await fixture(t);await f.setup();
 const before=(await f.request('/api/todos')).body;
 // Rename the directory, then occupy its pathname with a file: both file writes
 // and temp-file renames fail without requiring chmod/root-dependent behavior.
 await fsp.rename(f.dir,f.dir+'.saved');t.after(()=>fsp.rm(f.dir+'.saved',{recursive:true,force:true}));
 await fsp.writeFile(f.dir,'blocked');
 assert.equal((await f.request('/api/todos','POST',{text:'must not appear'})).status,500);
 assert.deepEqual((await f.request('/api/todos')).body,before);
});
test('timer routes reject invalid wall times/durations and timezone datetime is Cairo',async t=>{
 const f=await fixture(t);await f.setup();
 for(const [route,body] of [
 ['/api/timers',{name:'bad',type:'short',atTime:'99:99'}],
 ['/api/timers',{name:'bad',type:'short',hours:-1}],
 ['/api/timers/long',{targetAt:'NaN'}],
 ['/api/timers/short',{action:'start',hours:'abc'}],
 ['/api/time',{offsetSec:'abc'}],
 ['/api/time',{datetime:'2026-02-30T12:00'}]
 ]) assert.equal((await f.request(route,'POST',body)).status,400,route+JSON.stringify(body));
 const r=await f.request('/api/timers','POST',{name:'Cairo',date:'2026-10-27T12:00'});
 assert.equal(r.body.targetAt,Date.parse('2026-10-27T09:00:00Z'));
 assert.equal((await f.request('/api/time')).body.timeZone,'Africa/Cairo');
 const timer=(await f.request('/api/timers','POST',{name:'Short',type:'short',mins:2})).body;
 await f.request('/api/timers/'+timer.id,'PATCH',{action:'reset'});
 assert.equal((await f.request('/api/timers/'+timer.id,'PATCH',{action:'restart',hours:'NaN'})).status,400);
});
test('task and timer caps reject creation without deleting existing items',async t=>{
 const f=await fixture(t,{initial:{users:[],todos:Array.from({length:50},(_,i)=>({id:String(i),text:'saved'})),timers:Array.from({length:20},(_,i)=>({id:String(i),name:'saved',type:'long',targetAt:1})),pc:{},weather:{}}});await f.setup();
 assert.equal((await f.request('/api/todos','POST',{text:'overflow'})).status,409);
 assert.equal((await f.request('/api/timers','POST',{name:'overflow',days:1})).status,409);
 assert.equal((await f.request('/api/todos')).body.length,50);
});
test('malformed PC readings preserve unavailable instead of inventing zero',async t=>{
 const f=await fixture(t);
 const r=await f.request('/api/pc','POST',{cpu:null,ram:101,gpu:'bad',uptimeSec:-2,disks:[null,{mount:'/',pct:51,freeGb:2,totalGb:10}, {mount:'bad',pct:'NaN'}],cpuTemp:'oops',capabilities:{gpu:false}});
 assert.equal(r.status,200);
 const pc=(await f.request('/api/pc')).body;
 assert.equal(pc.cpu,null);assert.equal(pc.ram,null);assert.equal(pc.gpu,null);assert.equal(pc.cpuTemp,null);assert.equal(pc.uptimeSec,null);
 assert.deepEqual(pc.disks,[{mount:'/',pct:51,freeGb:2,totalGb:10}]);assert.equal(pc.capabilities.gpu,false);
});
test('calendar failure returns actual failure and disconnect supersedes old fetch',async t=>{
 let finish;
 const f=await fixture(t,{fetchImpl:async url=>{
   if(String(url).includes('slow.test')) return new Promise(resolve=>{finish=()=>resolve({ok:true,text:async()=> 'BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR'})});
   throw new Error('fixture fetch failed');
 }});await f.setup();
 const failed=await f.request('/api/settings','POST',{icsUrl:'https://offline.test/calendar.ics'});
 assert.equal(failed.status,502);assert.equal(failed.body.ok,false);assert.match(failed.body.calendar.error,/failed/);
 const slow=f.request('/api/settings','POST',{icsUrl:'https://slow.test/calendar.ics'});
 while(!finish) await new Promise(resolve=>setTimeout(resolve,1));
 await f.request('/api/settings','POST',{icsUrl:''});finish();await slow;
 assert.equal((await f.request('/api/calendar')).body.configured,false);
});
test('legacy fallback works before setup and stops once account exists',async t=>{
 const f=await fixture(t,{env:{ADMIN_USER:'fallback',ADMIN_PASS:'fallback-pass'}});
 assert.equal((await f.request('/api/login','POST',{user:'fallback',pass:'fallback-pass'})).status,200);
 await f.setup();
 assert.equal((await f.request('/api/login','POST',{user:'fallback',pass:'fallback-pass'})).status,401);
});
test('failed setup never installs an undurable account',async t=>{
 const f=await fixture(t);
 await fsp.rename(f.dir,f.dir+'.saved');t.after(()=>fsp.rm(f.dir+'.saved',{recursive:true,force:true}));await fsp.writeFile(f.dir,'blocked');
 assert.equal((await f.setup()).status,500);
 assert.equal((await f.request('/api/me')).body.needsSetup,true);
});
test('restart reuses duration and invalid updates do not alter the timer',async t=>{
 const f=await fixture(t);await f.setup();
 const timer=(await f.request('/api/timers','POST',{name:'Reusable',type:'short',mins:2})).body;
 await f.request('/api/timers/'+timer.id,'PATCH',{action:'reset'});
 const before=Date.now();const restarted=await f.request('/api/timers/'+timer.id,'PATCH',{action:'restart'});
 assert.equal(restarted.body.durationSec,120);assert.ok(restarted.body.targetAt>=before+119000 && restarted.body.targetAt<=Date.now()+120000);
 await f.request('/api/timers/'+timer.id,'PATCH',{action:'reset'});
 assert.equal((await f.request('/api/timers/'+timer.id,'PATCH',{action:'restart',mins:'bad',name:'Changed'})).status,400);
 assert.equal((await f.request('/api/timers')).body.find(x=>x.id===timer.id).name,'Reusable');
});
test('calendar rejects HTML and does not expose private URL in failure',async t=>{
 let html=true;
 const f=await fixture(t,{fetchImpl:async url=>{if(html)return {ok:true,text:async()=>'<html>Login required</html>'};throw new Error('Private fetch failed: '+url)}});await f.setup();
 const secret='https://calendar.test/private-secret/calendar.ics';
 assert.equal((await f.request('/api/settings','POST',{icsUrl:secret})).status,502);
 html=false;const failed=await f.request('/api/settings','POST',{icsUrl:secret});
 assert.equal(failed.status,502);assert.equal(JSON.stringify(failed.body).includes('private-secret'),false);
 assert.equal(JSON.stringify((await f.request('/api/snapshot')).body).includes('private-secret'),false);
});
test('weather failure preserves cached reading with stale/error metadata',async t=>{
 const f=await fixture(t,{initial:{users:[],todos:[],timers:[],pc:{},weather:{temp:23,code:0,label:'Clear',updatedAt:1}}});
 const response=await f.request('/api/weather');
 assert.equal(response.status,200);assert.equal(response.body.temp,23);assert.equal(response.body.updatedAt,1);assert.equal(response.body.stale,true);assert.ok(response.body.error);
});
test('numeric timer fields reject booleans, blank strings and invalid type',async t=>{
 const f=await fixture(t);await f.setup();
 for(const body of [{name:'Bad',type:'short',mins:true},{name:'Bad',type:'short',hours:' ',mins:1},{name:'Bad',type:'bad',days:1},{name:'Bad',targetAt:true}]) assert.equal((await f.request('/api/timers','POST',body)).status,400,JSON.stringify(body));
 assert.equal((await f.request('/api/time','POST',{offsetSec:null})).status,400);
});
test('restart without original duration rejects accompanying edits without later persisting them',async t=>{
 const f=await fixture(t);await f.setup();
 const timer=(await f.request('/api/timers','POST',{name:'Clock timer',type:'short',atTime:'12:30'})).body;
 const reset=(await f.request('/api/timers/'+timer.id,'PATCH',{action:'reset'})).body;
 const rejected=await f.request('/api/timers/'+timer.id,'PATCH',{action:'restart',name:'Should not stick',done:true,color:'#ffffff'});
 assert.equal(rejected.status,400);
 assert.deepEqual((await f.request('/api/timers')).body.find(x=>x.id===timer.id),reset);
 await f.request('/api/todos','POST',{text:'Unrelated durable change'});
 const stored=JSON.parse(await fsp.readFile(path.join(f.dir,'db.json'),'utf8'));
 assert.deepEqual(stored.timers.find(x=>x.id===timer.id),reset);
});
test('offset ISO inputs accept minute precision and seconds while rejecting invalid calendar dates',async t=>{
 const f=await fixture(t);await f.setup();
 for(const [input,expected] of [
  ['2026-10-27T12:30Z','2026-10-27T12:30:00.000Z'],
  ['2026-10-27T12:30+03:00','2026-10-27T09:30:00.000Z'],
  ['2026-10-27T12:30-03:00','2026-10-27T15:30:00.000Z'],
  ['2026-10-27T12:30:45Z','2026-10-27T12:30:45.000Z'],
  ['2026-10-27T12:30:45.123+03:00','2026-10-27T09:30:45.123Z']
 ]) {
  const timer=await f.request('/api/timers','POST',{name:'Offset date',date:input});
  assert.equal(timer.status,200,input);assert.equal(timer.body.targetAt,Date.parse(expected),input);
  const override=await f.request('/api/time','POST',{datetime:input});
  assert.equal(override.status,200,input);assert.ok(Math.abs(override.body.dashboardNow-Date.parse(expected))<1500,input);
 }
 for(const input of ['2026-02-30T12:30Z','2026-02-30T12:30+03:00','2026-02-30T12:30:45.123+03:00','2026-04-24T00:30']) {
  assert.equal((await f.request('/api/timers','POST',{name:'Invalid date',date:input})).status,400,input);
  assert.equal((await f.request('/api/time','POST',{datetime:input})).status,400,input);
 }
});
test('short duration targets outside Date range reject on current legacy and restart paths',async t=>{
 const f=await fixture(t);await f.setup();
 for(const [route,body] of [
  ['/api/timers',{name:'Too far',type:'short',hours:3000000000}],
  ['/api/timers/short',{action:'start',label:'Too far',hours:3000000000}]
 ]) assert.equal((await f.request(route,'POST',body)).status,400,route);
 const timer=(await f.request('/api/timers','POST',{name:'Restart range',type:'short',mins:2})).body;
 const reset=(await f.request('/api/timers/'+timer.id,'PATCH',{action:'reset'})).body;
 assert.equal((await f.request('/api/timers/'+timer.id,'PATCH',{action:'restart',hours:3000000000,name:'Should not stick'})).status,400);
 assert.deepEqual((await f.request('/api/timers')).body.find(x=>x.id===timer.id),reset);
});

test('current and legacy long timers accept gap dates while rejecting nonexistent datetimes',async t=>{
 const f=await fixture(t);await f.setup();
 for(const route of ['/api/timers','/api/timers/long']) {
  for(const [date,expected] of [['2026-04-24','2026-04-23T22:00:00Z'],['2026-04-23','2026-04-22T22:00:00Z']]) {
   const result=await f.request(route,'POST',{name:'Date '+date,label:'Date '+date,date});
   assert.equal(result.status,200,route+' '+date);assert.equal(result.body.targetAt,Date.parse(expected));
  }
  for(const date of ['2026-02-30','2026-04-24T00:30']) assert.equal((await f.request(route,'POST',{name:'Invalid',date})).status,400);
 }
});

function calendarFeed(summary) {
 // An ongoing daily occurrence keeps this integration fixture independent of today's date.
 return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:cache\r\nDTSTART:20200101T000000Z\r\nDTEND:20200102T000000Z\r\nRRULE:FREQ=DAILY\r\nSUMMARY:${summary}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
}
const sourceA='https://calendar.test/private-A/calendar.ics';
const sourceB='https://calendar.test/private-B/calendar.ics';
async function savedDb(f) {return JSON.parse(await fsp.readFile(path.join(f.dir,'db.json'),'utf8'));}

for(const replacement of [sourceB,'']) test(`calendar source ${replacement ? 'replacement' : 'disconnect'} is durable before the next checkpoint`,async t=>{
 const f=await fixture(t,{fetchImpl:async url=>{
  if(url===sourceA) return {ok:true,text:async()=>calendarFeed('Source A only')};
  throw new Error('offline '+url);
 }});await f.setup();
 assert.equal((await f.request('/api/settings','POST',{icsUrl:sourceA})).status,200);
 await f.request('/api/todos','POST',{text:'Persist source A cache'});
 assert.equal((await savedDb(f)).calendar.next.summary,'Source A only');
 assert.equal((await f.request('/api/settings','POST',{icsUrl:replacement})).status,replacement?502:200);
 const stored=await savedDb(f);
 assert.equal(stored.settings.icsUrl,replacement);assert.equal(stored.calendar.next,null);assert.deepEqual(stored.calendar.upcoming,[]);
 const restarted=await fixture(t,{initial:stored});
 const publicState=(await restarted.request('/api/calendar')).body;
 assert.equal(publicState.next,null);assert.equal(publicState.configured,!!replacement);
 // Log in to the restored account and retry the unavailable replacement source.
 const login=await restarted.login();assert.equal(login.status,200);
 assert.equal((await restarted.request('/api/settings','POST',{icsUrl:replacement})).status,replacement?502:200);
 assert.equal((await restarted.request('/api/calendar')).body.next,null);
 assert.equal((await restarted.request('/api/todos')).body.some(x=>x.text==='Persist source A cache'),true);
 assert.equal(JSON.stringify((await restarted.request('/api/snapshot')).body).includes('private-'),false);
});

test('unknown persisted calendar provenance is discarded without losing accounts or tasks',async t=>{
 const f=await fixture(t);await f.setup();
 await f.request('/api/todos','POST',{text:'Keep this task'});
 const stored=await savedDb(f);delete stored.calendarSource;
 stored.settings.icsUrl=sourceB;stored.calendar={next:{summary:'Unknown source'},upcoming:[{summary:'Unknown source'}],updatedAt:Date.now(),configured:true};
 const restarted=await fixture(t,{initial:stored});
 assert.equal((await restarted.request('/api/calendar')).body.next,null);
 assert.equal((await restarted.request('/api/me')).body.needsSetup,false);
 assert.equal((await restarted.request('/api/todos')).body.some(x=>x.text==='Keep this task'),true);
 assert.equal((await savedDb(restarted)).settings.icsUrl,sourceB);
});

test('failed same-source refresh retains its cache across restart',async t=>{
 let offline=false;
 const f=await fixture(t,{fetchImpl:async()=>{
  if(offline)throw new Error('offline');return {ok:true,text:async()=>calendarFeed('Saved source A')};
 }});await f.setup();
 await f.request('/api/settings','POST',{icsUrl:sourceA});
 offline=true;
 assert.equal((await f.request('/api/settings','POST',{icsUrl:sourceA})).status,502);
 assert.equal((await f.request('/api/calendar')).body.next.summary,'Saved source A');
 const restarted=await fixture(t,{initial:await savedDb(f)});await restarted.login();
 assert.equal((await restarted.request('/api/settings','POST',{icsUrl:sourceA})).status,502);
 assert.equal((await restarted.request('/api/calendar')).body.next.summary,'Saved source A');
});

for(const replacement of [sourceB,'']) test(`failed calendar ${replacement ? 'replacement' : 'disconnect'} write restores saved source/cache and preserves concurrent telemetry/weather`,async t=>{
 const f=await fixture(t,{fetchImpl:async url=>String(url).includes('open-meteo')
  ? {ok:true,json:async()=>({current:{temperature_2m:24,weather_code:0}})}
  : {ok:true,text:async()=>calendarFeed('Saved source A')}
 });await f.setup();
 await f.request('/api/settings','POST',{icsUrl:sourceA});
 await f.request('/api/todos','POST',{text:'Checkpoint'});
 const before=await savedDb(f),beforeCalendar=(await f.request('/api/calendar')).body;
 let release,entered;
 const started=new Promise(resolve=>{entered=resolve});
 const gate=new Promise(resolve=>{release=resolve});
 const realOpen=fsp.open;
 const mocked=t.mock.method(fsp,'open',async function(file,...args){
  if(String(file).startsWith(path.join(f.dir,'db.json.bak.tmp-'))) {
   entered();await gate;throw new Error('Injected write failure');
  }
  return realOpen.call(this,file,...args);
 });
 const changing=f.request('/api/settings','POST',{icsUrl:replacement});
 await started;
 try {
  await f.request('/api/pc','POST',{cpu:37,ram:44});
  assert.equal((await f.request('/api/weather')).body.temp,24);
 } finally {release();}
 assert.equal((await changing).status,500);mocked.mock.restore();
 assert.equal((await f.request('/api/settings')).body.icsUrl,sourceA);
 assert.deepEqual((await f.request('/api/calendar')).body,beforeCalendar);
 assert.deepEqual(await savedDb(f),before);
 assert.equal((await f.request('/api/pc')).body.cpu,37);
 assert.equal((await f.request('/api/snapshot')).body.weather.temp,24);
 await f.request('/api/todos','POST',{text:'After rollback'});
 assert.equal((await savedDb(f)).calendar.next.summary,'Saved source A');
});

test('superseded old-source fetch cannot repopulate a replacement cache',async t=>{
 let finish,entered;
 const started=new Promise(resolve=>{entered=resolve});
 const f=await fixture(t,{fetchImpl:async url=>{
  if(url===sourceA) return new Promise(resolve=>{finish=()=>resolve({ok:true,text:async()=>calendarFeed('Late source A')});entered();});
  throw new Error('B unavailable');
 }});await f.setup();
 const old=f.request('/api/settings','POST',{icsUrl:sourceA});await started;
 assert.equal((await f.request('/api/settings','POST',{icsUrl:sourceB})).status,502);
 finish();assert.equal((await old).status,409);
 assert.equal((await f.request('/api/calendar')).body.next,null);
 assert.equal((await savedDb(f)).calendar.next,null);
 assert.equal((await savedDb(f)).settings.icsUrl,sourceB);
});

test('a failed source change does not revive an older fetch after rollback restores its URL',async t=>{
 let defer=false,finish,entered;
 const started=new Promise(resolve=>{entered=resolve});
 const f=await fixture(t,{fetchImpl:async()=>{
  if(defer) return new Promise(resolve=>{finish=()=>resolve({ok:true,text:async()=>calendarFeed('Late refresh')});entered();});
  return {ok:true,text:async()=>calendarFeed('Saved source A')};
 }});await f.setup();
 await f.request('/api/settings','POST',{icsUrl:sourceA});
 defer=true;
 const old=f.request('/api/settings','POST',{icsUrl:sourceA});await started;
 const before=await savedDb(f);
 await fsp.rename(f.dir,f.dir+'.saved');t.after(()=>fsp.rm(f.dir+'.saved',{recursive:true,force:true}));
 await fsp.writeFile(f.dir,'blocked');
 assert.equal((await f.request('/api/settings','POST',{icsUrl:sourceB})).status,500);
 finish();assert.equal((await old).status,409);
 assert.equal((await f.request('/api/settings')).body.icsUrl,sourceA);
 assert.equal((await f.request('/api/calendar')).body.next.summary,'Saved source A');
 assert.deepEqual(JSON.parse(await fsp.readFile(path.join(f.dir+'.saved','db.json'),'utf8')),before);
});
