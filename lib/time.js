// All wall-clock input uses the configured zone, independent of the host timezone.
function partsAt(ms, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(ms).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
}
function wallTimeCandidates(value, timeZone) {
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) throw new Error('Invalid local date/time');
  const [,y,mo,d,h='00',mi='00',s='00']=m;
  const components=[+y,+mo,+d,+h,+mi,+s];
  const guess=Date.UTC(+y,+mo-1,+d,+h,+mi,+s);
  // Search both sides of a DST transition and retain both repeated instants.
  const candidates=new Set();
  for (const delta of [-86400000,0,86400000]) {
    const p=partsAt(guess+delta,timeZone);
    const offset=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)-(guess+delta);
    const candidate=guess-offset;
    const q=partsAt(candidate,timeZone);
    if ([q.year,q.month,q.day,q.hour,q.minute,q.second].every((v,i)=>v===components[i])) candidates.add(candidate);
  }
  return [...candidates].sort((a,b)=>a-b);
}
function wallTime(value,timeZone) {
  // Explicit ambiguous local datetimes consistently mean the earliest instant.
  const instant=wallTimeCandidates(value,timeZone)[0];
  if (instant===undefined) throw new Error('Invalid or nonexistent local date/time');
  return instant;
}
function calendarDay(value,timeZone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid calendar date');
  // Validate the actual date before searching; never normalize February 30, etc.
  const day=wallTime(value,'UTC');
  try { return wallTime(value,timeZone); }
  catch (error) {
    // Some zones skip midnight. A DATE denotes the first instant of that date,
    // whereas an explicit nonexistent clock time remains an error.
    const wanted=Number(value.replaceAll('-',''));
    const dayAt=ms=>{const p=partsAt(ms,timeZone);return p.year*10000+p.month*100+p.day;};
    let low=day-36*3600000, high=day+36*3600000;
    while(low<high) {
      const middle=Math.floor((low+high)/2);
      if(dayAt(middle)<wanted) low=middle+1;
      else high=middle;
    }
    if(dayAt(low)!==wanted) throw error;
    return low;
  }
}
function dateTime(value,timeZone) {
  if (typeof value !== 'string') throw new Error('Invalid date/time');
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return calendarDay(value,timeZone);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return wallTime(value,timeZone);
  const iso=value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/);
  if (!iso) throw new Error('Invalid date/time');
  const n=Date.parse(value);
  if (!Number.isFinite(n)) throw new Error('Invalid date/time');
  // Date.parse silently normalizes dates such as February 30.
  wallTime(`${iso[1]}T${iso[2]}:${iso[3]}:${iso[4] || '00'}`, 'UTC');
  return n;
}
function nextClock(value,timeZone,now=Date.now()) {
  if (!/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(String(value))) throw new Error('Invalid clock time');
  const p=partsAt(now,timeZone);
  const [h,m]=String(value).split(':');
  for(let day=0;day<3;day++) {
    const d=new Date(Date.UTC(p.year,p.month-1,p.day+day));
    const date=d.toISOString().slice(0,10);
    // Clock-only input means the next occurrence, including after a date on
    // which that clock time does not exist. Explicit datetimes remain strict.
    const instant=wallTimeCandidates(`${date}T${h.padStart(2,'0')}:${m}`,timeZone).find(candidate=>candidate>now);
    if(instant!==undefined) return instant;
  }
  throw new Error('Invalid clock time');
}
function numeric(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim()) || !Number.isFinite(Number(value))) throw new Error('Finite numeric value required');
  return Number(value);
}
function duration(body,defaultMins=0) {
  const h=numeric(body.hours === undefined ? 0 : body.hours), m=numeric(body.mins === undefined ? defaultMins : body.mins);
  if(!Number.isFinite(h)||!Number.isFinite(m)||h<0||m<0||h*3600+m*60<=0||!Number.isSafeInteger(Math.round(h*3600+m*60))) throw new Error('Positive finite hours/mins required');
  return Math.max(60,Math.round(h*3600+m*60));
}
function durationTarget(seconds,now=Date.now()) {
  const target=now+seconds*1000;
  if (!Number.isFinite(seconds) || seconds<=0 || !Number.isSafeInteger(target) || !Number.isFinite(new Date(target).getTime())) throw new Error('Duration target is outside supported date range');
  return target;
}
module.exports={partsAt,wallTime,calendarDay,dateTime,nextClock,duration,durationTarget,numeric};
