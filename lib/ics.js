// Standards-aware recurrence handling; keep the dashboard's small item contract.
const ical = require('node-ical');
const { calendarDay } = require('./time');
const DEFAULT_TZ = 'Africa/Cairo';
async function fetchIcs(url, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { 'User-Agent':'tablet-dashboard/1.0', Accept:'text/calendar' } });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.text();
  } finally { clearTimeout(timeout); }
}
function parseIcs(text, timeZone = DEFAULT_TZ) {
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('Invalid iCalendar response');
  // Floating DATE-TIME values belong to the application's zone. DATE values
  // remain dates; node-ical expands them without shifting the calendar day.
  const normalized = text.replace(/\r?\n[ \t]/g,'').replace(/^(DTSTART|DTEND|RECURRENCE-ID|EXDATE):(\d{8}T\d{6}(?:,\d{8}T\d{6})*)$/gm, '$1;TZID='+timeZone+':$2');
  const events = Object.values(ical.sync.parseICS(normalized)).filter(e=>e.type==='VEVENT' && e.start && !e.recurrenceid);
  Object.defineProperty(events,'timeZone',{value:timeZone});
  return events;
}
function localDay(date,timeZone) {
  const value=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  return calendarDay(value,timeZone);
}
function expand(events, now, windowDays = 366) {
  const out=[];
  const from=new Date(now-86400000), to=new Date(now+windowDays*86400000);
  const timeZone=events.timeZone || DEFAULT_TZ;
  for(const event of events) {
    if(event.status==='CANCELLED') continue;
    for(const instance of ical.expandRecurringEvent(event,{from,to,expandOngoing:true})) {
      if(instance.event.status==='CANCELLED') continue;
      const allDay=instance.isFullDay;
      const start=allDay?localDay(instance.start,timeZone):+instance.start;
      const end=allDay?localDay(instance.end,timeZone):+instance.end;
      out.push({summary:instance.summary,location:instance.event.location || event.location || null,start,end,allDay});
    }
  }
  return out;
}
function toItem(e,now) {
  return {summary:e.summary || '(no title)',location:e.location || null,startMs:e.start,endMs:e.end,ongoing:e.start<=now && now<e.end,allDay:e.allDay};
}
function findNext(events,now=Date.now()) {
  const occurrences=expand(events,now);
  const ongoing=occurrences.filter(e=>e.start<=now && now<e.end).sort((a,b)=>b.start-a.start)[0];
  const next=ongoing || occurrences.filter(e=>e.start>now).sort((a,b)=>a.start-b.start)[0];
  return next?toItem(next,now):null;
}
function upcoming(events,now=Date.now(),days=14,cap=100) {
  return expand(events,now,days).filter(e=>e.end>now-86400000 && e.start<now+days*86400000).sort((a,b)=>a.start-b.start).slice(0,cap).map(e=>toItem(e,now));
}
module.exports={fetchIcs,parseIcs,expand,findNext,upcoming,DEFAULT_TZ};
