import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotices, openNoticeContent } from '../src/index.ts';
import { sealNotice, boxPublicKey } from '@byokit/seal';
import fixture from './fixture.json' with { type: 'json' };

test('seal 0.2.0 wire fixture opens with routing data in each transport shape', () => {
  const key = Uint8Array.from(fixture.key);
  for (const payload of [fixture.notice, {notice:fixture.notice}, {notice:JSON.stringify(fixture.notice)}, {body:{notice:fixture.notice}}, {body:{data:fixture.notice}}]) assert.deepEqual(openNoticeContent(payload,key),fixture.value);
  assert.equal(openNoticeContent({notice:'broken'},key),null);
  assert.equal(openNoticeContent(fixture.notice,new Uint8Array(32)),null);
  assert.equal(openNoticeContent({...fixture.notice,sealed:fixture.notice.sealed.slice(0,-1)+'A'},key),null);
  assert.equal(openNoticeContent({...fixture.notice,v:2},key),null);
  assert.equal(openNoticeContent({v:1,sealed:'A'.repeat(8193)},key),null);
  for (const value of [null, [], {title:'',body:''}, {title:'ok'}, {title:'ok',body:'',data:[]}, {title:2,body:''}]) assert.equal(openNoticeContent(sealNotice(value,boxPublicKey(key)),key),null);
});
test('key and answer-target provisioning validate before calling native, copy and clear', async () => {
  let received: number[] = []; let cleared = false; let targets: unknown[] = [];
  const kit = createNotices({async setNoticeKey(key){received=key;},async clearNoticeKey(){cleared=true;},async setAnswerTargets(t){targets=t;}});
  await assert.rejects(kit.setNoticeKey(new Uint8Array(31)),/32 bytes/);
  assert.equal(received.length,0);
  const key=Uint8Array.from(fixture.key); await kit.setNoticeKey(key); key.fill(0);
  assert.deepEqual(received,fixture.key);
  await kit.clearNoticeKey(); assert.equal(cleared,true);
  const key32=new Uint8Array(32).fill(7);
  for (const bad of [{host:'',relay:'https://r.example',key:key32},{host:'home',relay:'http://r.example',key:key32},{host:'home',relay:'https://r.example/x',key:key32},{host:'home',relay:'https://r.example',key:new Uint8Array(31)}])
    await assert.rejects(kit.setAnswerTargets([bad]),/answer target/);
  assert.deepEqual(targets,[]);
  await kit.setAnswerTargets([{host:'home',relay:'https://r.example/',key:key32}]);
  assert.deepEqual(targets,[{host:'home',relay:'https://r.example',key:Array(32).fill(7)}]);
  await assert.rejects(createNotices(null).setAnswerTargets([]),/unavailable/);
  await assert.rejects(createNotices(null).setNoticeKey(new Uint8Array(32)),/unavailable/);
  await assert.rejects(createNotices(null).clearNoticeKey(),/unavailable/);
});
