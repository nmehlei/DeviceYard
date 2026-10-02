import {SessionGrace} from '../../src/editions/sessionGrace';
test('idle session closes after five minutes and repeated activity never extends it',()=>{
  let time=100;const grace=new SessionGrace(()=>time);
  expect(grace.check(true)).toBe('allowed');expect(grace.check(false)).toBe('warn');
  time+=299999;expect(grace.check(false)).toBe('draining');time++;expect(grace.check(false)).toBe('close');
  time++;expect(grace.check(false)).toBe('close');expect(grace.check(true)).toBe('allowed');
  expect(grace.check(false)).toBe('warn');
});
