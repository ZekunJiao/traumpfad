import test from 'node:test';
import assert from 'node:assert/strict';
import { PhotoTransition } from '../app/js/photo-transition.js';

function fixture() {
  let resolve, reject, frames, options;
  const animation = { finished: new Promise((a,b) => { resolve=a; reject=b; }), cancel() { reject(new Error('cancelled')); } };
  const node = { animate(f,o) { frames=f; options=o; return animation; } };
  return { node, finish: () => resolve(), inspect: () => ({ frames,options }) };
}
const small={left:20,top:40,width:80,height:60}, large={left:100,top:100,width:800,height:600};
test('photo flies from its thumbnail and reverses back to the same anchor', async () => {
  const transition=new PhotoTransition(), enter=fixture();
  const entering=transition.move(enter.node,small,large);
  assert.match(enter.inspect().frames[0].transform,/scale\(0.1\)/);
  assert.equal(enter.inspect().options.duration,4800);
  enter.finish(); assert.equal(await entering,true);
  const exit=fixture(), exiting=transition.move(exit.node,small,large,{reverse:true});
  assert.deepEqual(exit.inspect().frames, [...enter.inspect().frames].reverse());
  exit.finish(); assert.equal(await exiting,true);
});
test('stage changes cancel an unfinished photo flight and reduced motion skips animation', async () => {
  const transition=new PhotoTransition(), photo=fixture();
  const pending=transition.move(photo.node,small,large);
  transition.cancel(); assert.equal(await pending,false);
  assert.equal(await transition.move({animate(){assert.fail('reduced motion must not animate');}},small,large,{reduced:true}),true);
});
