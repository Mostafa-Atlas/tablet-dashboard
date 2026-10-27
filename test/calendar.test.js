const test = require('node:test');
const assert = require('node:assert/strict');
const ics = require('../lib/ics');
const calendar = body => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR`;
const event = body => `BEGIN:VEVENT\r\n${body}\r\nEND:VEVENT`;
test('old daily series continues beyond 500 occurrences', () => {
  const events = ics.parseIcs(calendar(event('UID:old\r\nDTSTART:20200101T090000Z\r\nDTEND:20200101T100000Z\r\nRRULE:FREQ=DAILY\r\nSUMMARY:Daily')));
  assert.equal(ics.findNext(events, Date.parse('2026-10-27T08:00:00Z')).startMs, Date.parse('2026-10-27T09:00:00Z'));
});
test('BYDAY includes all weekdays and respects EXDATE and moved overrides', () => {
  const events = ics.parseIcs(calendar([
    event('UID:weekly\r\nDTSTART:20261026T090000Z\r\nDTEND:20261026T100000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR\r\nEXDATE:20261028T090000Z\r\nSUMMARY:Class'),
    event('UID:weekly\r\nRECURRENCE-ID:20261030T090000Z\r\nDTSTART:20261030T120000Z\r\nDTEND:20261030T130000Z\r\nSUMMARY:Moved')
  ].join('\r\n')));
  assert.deepEqual(ics.upcoming(events, Date.parse('2026-10-27T00:00:00Z'), 5).filter(e => e.startMs > Date.parse('2026-10-27')).map(e=>[e.summary,new Date(e.startMs).toISOString()]), [['Moved','2026-10-30T12:00:00.000Z']]);
});
test('monthly/yearly recurrence, cancellation and all-day Cairo date', () => {
  const events = ics.parseIcs(calendar([
    event('UID:monthly\r\nDTSTART:20200115T090000Z\r\nDTEND:20200115T100000Z\r\nRRULE:FREQ=MONTHLY\r\nSUMMARY:Monthly'),
    event('UID:annual\r\nDTSTART;VALUE=DATE:20201028\r\nDTEND;VALUE=DATE:20201029\r\nRRULE:FREQ=YEARLY\r\nSUMMARY:Annual'),
    event('UID:cancelled\r\nDTSTART:20261028T120000Z\r\nSTATUS:CANCELLED\r\nSUMMARY:Cancelled')
  ].join('\r\n')));
  const list = ics.upcoming(events, Date.parse('2026-10-27T00:00:00Z'), 30);
  assert.equal(list.some(e=>e.summary==='Cancelled'),false);
  assert.equal(list.find(e=>e.summary==='Monthly').startMs, Date.parse('2026-11-15T09:00:00Z'));
  const annual=list.find(e=>e.summary==='Annual');
  assert.equal(annual.allDay,true);
  assert.equal(new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo'}).format(new Date(annual.startMs)),'2026-10-28');
});
test('Cairo recurring wall time stays at 09:00 across DST end', () => {
  const events=ics.parseIcs(calendar(event('UID:dst\r\nDTSTART;TZID=Africa/Cairo:20261029T090000\r\nDTEND;TZID=Africa/Cairo:20261029T100000\r\nRRULE:FREQ=DAILY;COUNT=3')));
  assert.deepEqual(ics.upcoming(events,Date.parse('2026-10-29T00:00:00Z'),4).map(e=>new Date(e.startMs).toISOString()),['2026-10-29T06:00:00.000Z','2026-10-30T07:00:00.000Z','2026-10-31T07:00:00.000Z']);
});
test('floating CRLF dates use application timezone on a UTC host', () => {
  const {execFileSync}=require('node:child_process');
  const input=calendar(event('UID:floating\r\nDTSTART:20261027T090000\r\nDTEND:20261027T100000\r\nSUMMARY:Floating'));
  const script=`const i=require('./lib/ics'); console.log(i.findNext(i.parseIcs(${JSON.stringify(input)}),Date.parse('2026-10-27T00:00:00Z')).startMs)`;
  assert.equal(Number(execFileSync(process.execPath,['-e',script],{cwd:require('node:path').resolve(__dirname,'..'),env:{...process.env,TZ:'UTC'}}).toString().trim()),Date.parse('2026-10-27T06:00:00Z'));
});
test('weekly BYDAY emits the Wednesday omitted by origin stepping',()=>{
 const events=ics.parseIcs(calendar(event('UID:days\r\nDTSTART:20261026T090000Z\r\nDTEND:20261026T100000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR')));
 assert.equal(ics.findNext(events,Date.parse('2026-10-27T00:00:00Z')).startMs,Date.parse('2026-10-28T09:00:00Z'));
});
test('cancelled recurrence override removes just that occurrence',()=>{
 const events=ics.parseIcs(calendar([
  event('UID:c\r\nDTSTART:20261026T090000Z\r\nDTEND:20261026T100000Z\r\nRRULE:FREQ=DAILY;COUNT=4\r\nSUMMARY:Daily'),
  event('UID:c\r\nRECURRENCE-ID:20261027T090000Z\r\nDTSTART:20261027T090000Z\r\nDTEND:20261027T100000Z\r\nSTATUS:CANCELLED')
 ].join('\r\n')));
 assert.equal(ics.findNext(events,Date.parse('2026-10-27T00:00:00Z')).startMs,Date.parse('2026-10-28T09:00:00Z'));
});
test('all-day durations respect configured zone DST midnight boundaries',()=>{
 const events=ics.parseIcs(calendar(event('UID:date\r\nDTSTART;VALUE=DATE:20261029\r\nDTEND;VALUE=DATE:20261031\r\nSUMMARY:Days')));
 const next=ics.findNext(events,Date.parse('2026-10-28T23:00:00Z'));
 assert.equal(next.startMs,Date.parse('2026-10-28T21:00:00Z'));
 assert.equal(next.endMs,Date.parse('2026-10-30T22:00:00Z'));
});
test('spring DST all-day starts and exclusive ends use first valid instant of date',()=>{
 const events=ics.parseIcs(calendar([
  event('UID:start-gap\r\nDTSTART;VALUE=DATE:20260424\r\nDTEND;VALUE=DATE:20260425\r\nSUMMARY:Starts at gap'),
  event('UID:end-gap\r\nDTSTART;VALUE=DATE:20260423\r\nDTEND;VALUE=DATE:20260424\r\nSUMMARY:Ends at gap'),
  event('UID:ordinary\r\nDTSTART:20260424T090000Z\r\nDTEND:20260424T100000Z\r\nSUMMARY:Ordinary')
 ].join('\r\n')));
 const list=ics.upcoming(events,Date.parse('2026-04-23T00:00:00Z'),3);
 assert.deepEqual(list.map(e=>[e.summary,new Date(e.startMs).toISOString(),new Date(e.endMs).toISOString()]),[
  ['Ends at gap','2026-04-22T22:00:00.000Z','2026-04-23T22:00:00.000Z'],
  ['Starts at gap','2026-04-23T22:00:00.000Z','2026-04-24T21:00:00.000Z'],
  ['Ordinary','2026-04-24T09:00:00.000Z','2026-04-24T10:00:00.000Z']
 ]);
 assert.equal(ics.findNext(events,Date.parse('2026-04-23T21:59:59Z')).summary,'Ends at gap');
 assert.equal(ics.findNext(events,Date.parse('2026-04-23T22:00:00Z')).summary,'Starts at gap');
});
