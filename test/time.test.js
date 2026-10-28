const test = require('node:test');
const assert = require('node:assert/strict');
const { dateTime, nextClock } = require('../lib/time');
const zone = 'Africa/Cairo';

test('date-only targets use the first instant of a valid calendar day', () => {
  assert.equal(dateTime('2026-04-24', zone), Date.parse('2026-04-23T22:00:00Z'));
  assert.equal(dateTime('2026-04-23', zone), Date.parse('2026-04-22T22:00:00Z'));
  for (const value of ['2026-02-30', '2026-13-01', '2026-04-24T00:30']) {
    assert.throws(() => dateTime(value, zone), /Invalid|nonexistent/);
  }
  assert.throws(() => dateTime('2011-12-30', 'Pacific/Apia'), /Invalid|nonexistent/);
});

for (const [position, now, expected] of [
  ['before both', '2026-10-29T20:00:00Z', '2026-10-29T20:30:00Z'],
  ['between both', '2026-10-29T20:45:00Z', '2026-10-29T21:30:00Z'],
  ['at first', '2026-10-29T20:30:00Z', '2026-10-29T21:30:00Z'],
  ['after both', '2026-10-29T21:45:00Z', '2026-10-30T21:30:00Z']
]) test(`next clock selects the next occurrence ${position} autumn fold instants`, () => {
  assert.equal(nextClock('23:30', zone, Date.parse(now)), Date.parse(expected));
});

test('explicit ambiguous datetimes still choose the earliest instant and gaps reject', () => {
  assert.equal(dateTime('2026-10-29T23:30', zone), Date.parse('2026-10-29T20:30:00Z'));
  assert.throws(() => dateTime('2026-04-24T00:30', zone), /nonexistent/);
});

for (const [position, now] of [
  ['before', '2026-04-23T21:45:00Z'],
  ['after', '2026-04-23T23:00:00Z']
]) test(`next clock advances past a nonexistent time ${position} the spring gap`, () => {
  assert.equal(nextClock('00:30', zone, Date.parse(now)), Date.parse('2026-04-24T21:30:00Z'));
});
