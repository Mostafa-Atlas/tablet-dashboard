const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createStore}=require('../lib/storage');
async function files(t) {const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dashboard-storage-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return {dir,file:path.join(dir,'db.json')}}
test('overlapping immutable saves keep the last snapshot and a valid previous backup',async t=>{
 const {file}=await files(t);const store=createStore(file,()=>({users:[],todos:[],timers:[]}));
 const first={users:[],todos:[{text:'a'.repeat(1000000)}],timers:[]};
 const pending=store.save(first);first.todos[0].text='mutated after save';
 await Promise.all([pending,...Array.from({length:30},(_,i)=>store.save({users:[{user:'saved',salt:'s',hash:'h'}],todos:[{text:String(i)}],timers:[]}))]);
 assert.equal(JSON.parse(await fs.readFile(file)).todos[0].text,'29');
 assert.equal(JSON.parse(await fs.readFile(file+'.bak')).todos[0].text,'28');
 assert.equal((await fs.readdir(path.dirname(file))).some(name=>name.includes('.tmp-')),false);
});
test('semantic database corruption recovers accounts from backup and preserves corrupt primary',async t=>{
 const {dir,file}=await files(t);await fs.writeFile(file,JSON.stringify({users:null,todos:[]}));
 await fs.writeFile(file+'.bak',JSON.stringify({users:[{user:'saved',salt:'s',hash:'h'}],todos:[],timers:[]}));
 const store=createStore(file,()=>({users:[]}));assert.equal(store.value.users[0].user,'saved');
 const corrupt=(await fs.readdir(dir)).find(name=>name.startsWith('db.json.corrupt-'));assert.ok(corrupt);assert.equal(JSON.parse(await fs.readFile(path.join(dir,corrupt))).users,null);
});
test('missing primary restores existing backup instead of first boot',async t=>{
 const {file}=await files(t);await fs.writeFile(file+'.bak',JSON.stringify({users:[{user:'saved',salt:'s',hash:'h'}],todos:[],timers:[]}));
 const store=createStore(file,()=>({users:[]}));assert.equal(store.value.users[0].user,'saved');
});
