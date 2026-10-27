const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
function validate(value) {
  if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error('Invalid database object');
  for(const key of ['users','todos']) if(key in value && !Array.isArray(value[key])) throw new Error('Invalid database '+key);
  if(value.users?.some(u=>!u || typeof u.user!=='string' || typeof u.salt!=='string' || typeof u.hash!=='string')) throw new Error('Invalid database accounts');
  if('timers' in value && (!value.timers || typeof value.timers!=='object')) throw new Error('Invalid database timers');
  return value;
}
function tempName(file) { return file+'.tmp-'+process.pid+'-'+crypto.randomBytes(6).toString('hex'); }
function syncWrite(file,text) {
  const temp=tempName(file);
  try {
    const fd=fs.openSync(temp,'wx',0o600);
    try { fs.writeFileSync(fd,text);fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp,file);
  } finally { try {fs.unlinkSync(temp)} catch {} }
}
async function atomicWrite(file,text) {
  const temp=tempName(file);
  try {
    const handle=await fs.promises.open(temp,'wx',0o600);
    try {await handle.writeFile(text);await handle.sync();} finally {await handle.close();}
    await fs.promises.rename(temp,file);
  } finally {await fs.promises.unlink(temp).catch(()=>{});}
}
function createStore(file,defaults) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const backup=file+'.bak';
  let value, text;
  try {text=fs.readFileSync(file,'utf8');value=validate(JSON.parse(text));}
  catch(primaryError) {
    try {
      text=fs.readFileSync(backup,'utf8');value=validate(JSON.parse(text));
      // Preserve corrupt data for manual recovery; never replace the good backup.
      if(fs.existsSync(file)) fs.copyFileSync(file,file+'.corrupt-'+Date.now());
      syncWrite(file,text);
      console.error('Recovered database from backup:',backup);
    } catch(backupError) {
      if(primaryError.code!=='ENOENT' || backupError.code!=='ENOENT') throw new Error('Cannot recover valid database; preserve db.json and db.json.bak and restore a known good copy', {cause:primaryError});
      value=defaults();text=JSON.stringify(value,null,2);syncWrite(file,text);syncWrite(backup,text);
    }
  }
  let durableText=text;
  let queue=Promise.resolve();
  function save(next) {
    const nextText=JSON.stringify(next,null,2);
    const result=queue.then(async()=>{
      await atomicWrite(backup,durableText);
      await atomicWrite(file,nextText);
      durableText=nextText;
      // Persist directory rename metadata where supported (POSIX). File fsyncs
      // still run on platforms that do not allow opening directories.
      let dir;
      try {dir=await fs.promises.open(path.dirname(file),'r');await dir.sync();}
      catch(e) {if(!['EINVAL','EPERM','EISDIR','ENOTSUP','EBADF'].includes(e.code)) throw e;}
      finally {await dir?.close();}
    });
    queue=result.catch(()=>{});
    return result;
  }
  return {value,save};
}
module.exports={createStore};
