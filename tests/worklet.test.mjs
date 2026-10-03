import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
const script = await readFile(
  new URL("../public/player-worklet.js", import.meta.url),
  "utf8",
);
test("audio output drains exact PCM order, freezes on pause, and discards an old seek epoch", () => {
  let Player;
  const messages = [];
  const context = vm.createContext({
    sampleRate: 48000,
    AudioWorkletProcessor: class {
      port = { postMessage: (x) => messages.push(x) };
    },
    registerProcessor: (_, p) => {
      Player = p;
    },
  });
  vm.runInContext(script, context);
  const player = new Player();
  player.source = { postMessage() {} };
  const packet = (epoch, value, done = false) => ({
    type: "audio",
    epoch,
    audio: new Float32Array(256).fill(value),
    meta: {
      frames: 128,
      startBeat: 0,
      startSeconds: 0,
      meters: [],
      status: { beat: 0.01, bpm: 120, done },
    },
  });
  player.receive({ type: "reset", epoch: 2, status: { beat: 0 } });
  player.receive(packet(1, 0.9));
  for (let i = 0; i < 8; i++) player.receive(packet(2, 0.25));
  let left = new Float32Array(128),
    right = new Float32Array(128);
  player.process([], [[left, right]]);
  assert.ok(left.every((v) => v === 0));
  player.playing = true;
  player.process([], [[left, right]]);
  assert.ok(left.every((v) => v >= 0 && v <= 0.25));
  assert.deepEqual(left, right);
  player.process([], [[left, right]]);
  player.process([], [[left, right]]);
  assert.ok(left.every((v) => v === 0.25));
  player.receive({ type: "reset", epoch: 3, status: { beat: 4 } });
  player.receive(packet(2, 0.9));
  player.receive(packet(3, 0.1, true));
  player.process([], [[left, right]]);
  assert.ok(left.every((v) => v <= 0.1));
  assert.equal(player.playing, false);
  assert.equal(messages.at(-1).type, "ended");
});

test("selected analysis PCM is synchronized and never mixed into audible output", () => {
  let Player;
  vm.runInNewContext(script, {
    sampleRate: 48000,
    AudioWorkletProcessor: class {
      port = { postMessage() {} };
    },
    registerProcessor: (_, p) => {
      Player = p;
    },
  });
  const p = new Player();
  p.source = { postMessage() {} };
  p.playing = p.primed = true;
  p.gain = 1;
  p.analysis = "lead";
  p.analysisEnabled = true;
  const audio = new Float32Array(512);
  audio.fill(0.25, 0, 256);
  audio.fill(0.75, 256);
  p.receive({
    type: "audio",
    epoch: 0,
    revision: 0,
    analysis: "lead",
    audio,
    meta: { frames: 128, startBeat: 0, startSeconds: 0, status: { beat: 1 } },
  });
  const master = [new Float32Array(128), new Float32Array(128)],
    monitor = [new Float32Array(128), new Float32Array(128)];
  p.process([], [master, monitor]);
  assert.ok(master[0].every((v) => v === 0.25));
  assert.ok(monitor[0].every((v) => v === 0.75));
  p.analysis = "bass";
  monitor.forEach((v) => v.fill(0));
  p.receive({
    type: "audio",
    epoch: 0,
    revision: 0,
    analysis: "lead",
    audio,
    meta: { frames: 128, startBeat: 1, startSeconds: 0, status: { beat: 2 } },
  });
  p.process([], [master, monitor]);
  assert.ok(
    monitor[0].every((v) => v === 0),
    "stale selection is silent until matching buffers arrive",
  );
  assert.ok(master[0].every((v) => v === 0.25));
  p.analysis = "lead";
  p.acceptedRevision = 1;
  monitor.forEach(value=>value.fill(0));
  p.receive({type:"audio",epoch:0,revision:0,analysis:"lead",audio,
    meta:{frames:128,startBeat:2,startSeconds:0,status:{beat:3}}});
  p.process([],[master,monitor]);
  assert.ok(monitor[0].every(value=>value===0),"queued prior revision cannot be labeled current detail");
  p.analysisEnabled = false;
  monitor.forEach(value=>value.fill(0));
  p.receive({type:"audio",epoch:0,revision:1,analysis:"lead",audio,
    meta:{frames:128,startBeat:3,startSeconds:0,status:{beat:4}}});
  p.process([],[master,monitor]);
  assert.ok(monitor[0].every(value=>value===0),"hidden detail remains silent independently of audible output");
});

test("an old queued done block cannot stop a newer accepted revision", () => {
  let Player;
  const messages = [];
  vm.runInNewContext(script, {
    sampleRate: 48000,
    AudioWorkletProcessor: class {
      port = { postMessage: (x) => messages.push(x) };
    },
    registerProcessor: (_, p) => {
      Player = p;
    },
  });
  const p = new Player();
  p.source = { postMessage() {} };
  p.playing = p.primed = true;
  p.gain = 1;
  p.receive({ type: "revision", epoch: 0, revision: 2 });
  const packet = (revision, done, value) => ({
    type: "audio",
    epoch: 0,
    audio: new Float32Array(256).fill(value),
    meta: {
      frames: 128,
      startBeat: 0,
      startSeconds: 0,
      meters: [],
      status: { revision, beat: revision, bpm: 120, done },
    },
  });
  p.receive(packet(1, true, 0.1));
  p.receive(packet(2, false, 0.2));
  const output = [new Float32Array(128), new Float32Array(128)];
  p.process([], [output]);
  assert.equal(p.playing, true);
  assert.equal(
    messages.some((x) => x.type === "ended"),
    false,
  );
  p.process([], [output]);
  assert.equal(p.status.revision, 2);
  assert.ok(output[0].every((v) => Math.abs(v - 0.2) < 1e-6));
});

test("queued structural fade tapers the old tail and new head without dropping blocks", () => {
  let Player;
  vm.runInNewContext(script, {
    sampleRate: 48000,
    AudioWorkletProcessor: class {
      port = { postMessage() {} };
    },
    registerProcessor: (_, p) => {
      Player = p;
    },
  });
  const p = new Player();
  p.source = { postMessage() {} };
  p.playing = p.primed = true;
  p.gain = 1;
  const packet = (revision, value) => ({
    type: "audio",
    epoch: 0,
    audio: new Float32Array(256).fill(value),
    meta: {
      frames: 128,
      startBeat: 0,
      startSeconds: 0,
      meters: [],
      status: { revision, beat: revision, bpm: 120, done: false },
    },
  });
  const old = packet(1, 0.5),
    next = packet(2, 0.5);
  p.receive(old);
  p.receive({ type: "revision", epoch: 0, revision: 2, queuedFade: true });
  p.receive(next);
  assert.equal(p.queue.length, 2);
  assert.equal(old.fadeOut, true);
  assert.equal(next.fadeIn, true);
  const output = [new Float32Array(128), new Float32Array(128)];
  p.process([], [output]);
  assert.ok(output[0][0] > 0.49);
  assert.equal(output[0][127], 0);
  p.process([], [output]);
  assert.equal(output[0][0], 0);
  assert.ok(output[0][127] > 0.49);
  assert.equal(p.queue.length, 0);
});

function monitoredPlayer() {
  let Player;
  const messages=[];
  vm.runInNewContext(script,{sampleRate:48000,AudioWorkletProcessor:class{
    port={postMessage(message){messages.push(message);}};
  },registerProcessor:(_,value)=>{Player=value;}});
  const player=new Player();
  player.source={postMessage(){}};
  player.playing=player.primed=true;player.gain=1;
  const master=[new Float32Array(128),new Float32Array(128)];
  const monitor=[new Float32Array(128),new Float32Array(128)];
  return {player,messages,consume(frames){
    for(let offset=0;offset<frames;offset+=128){
      master.forEach(channel=>channel.fill(0));monitor.forEach(channel=>channel.fill(0));
      player.process([],[master,monitor]);
    }
  },packet({source="lead",revision=0,epoch=0,generation=1,beat=0,meters}={}){
    const meta={frames:1024,startBeat:beat,startSeconds:beat/2,
      status:{revision,generation,beat:beat+1,seconds:(beat+1)/2}};
    if(meters!==undefined)meta.meters=meters;
    player.receive({type:"audio",epoch,revision,analysis:source,audio:new Float32Array(4096),meta});
  }};
}

test("worklet retains consumed same-identity sparse meters until reporting and clears disable/reset",()=>{
  const {player,messages,consume,packet}=monitoredPlayer();
  const meters=[{id:"lead",peak:0.4,rms:0.2}];
  packet({meters,beat:0});packet({beat:1});consume(2048);
  assert.deepEqual(messages.filter(message=>message.type==="position").at(-1).meters,meters);
  player.port.onmessage({data:{type:"meters",enabled:false}});
  packet({meters,beat:2});packet({beat:3});consume(2048);
  assert.equal(messages.filter(message=>message.type==="position").at(-1).meters.length,0);
  player.port.onmessage({data:{type:"meters",enabled:true}});
  packet({meters,beat:4});consume(1024);
  player.receive({type:"reset",epoch:1,status:{revision:0,beat:0}});
  assert.equal(messages.filter(message=>message.type==="position").at(-1).meters.length,0);
});

test("worklet readiness requires2048 contiguous current-source PCM across deep queue and retires every discontinuity",()=>{
  const {player,messages,consume,packet}=monitoredPlayer();
  player.port.onmessage({data:{type:"analysis",id:"bass",enabled:true,captureId:"9007199254740993"}});
  for(let index=0;index<12;index++)packet({source:"lead",beat:index});
  packet({source:"bass",beat:12});packet({source:"bass",beat:13});
  consume(12*1024);
  assert.equal(messages.some(message=>message.type==="analysisReady"&&message.ready),false);
  consume(1024);
  assert.equal(messages.some(message=>message.type==="analysisReady"&&message.ready),false);
  consume(1024);
  const readiness=()=>messages.filter(message=>message.type==="analysisReady").at(-1);
  assert.equal(readiness().ready,true);assert.equal(readiness().captureId,"9007199254740993");
  assert.equal(readiness().source,"bass");assert.equal(readiness().generation,1);
  consume(128);assert.equal(readiness().ready,false,"underflow invalidates a formerly ready window");
  packet({source:"bass",beat:14});packet({source:"bass",beat:15});consume(2048);
  assert.equal(readiness().ready,true);
  player.port.onmessage({data:{type:"playing",value:false}});
  assert.equal(readiness().ready,false,"pause invalidates without waiting for another quantum");
  player.port.onmessage({data:{type:"playing",value:true}});
  player.receive({type:"reset",epoch:1,status:{revision:0,beat:0}});
  player.port.onmessage({data:{type:"analysis",id:"bass",enabled:true,captureId:"seek"}});
  player.primed=true;
  packet({source:"bass",epoch:1,beat:0});packet({source:"bass",epoch:1,beat:1});consume(2048);
  assert.equal(readiness().ready,true);assert.equal(readiness().epoch,1);
  player.receive({type:"revision",epoch:1,revision:1});
  assert.equal(readiness().ready,false);
  player.port.onmessage({data:{type:"analysis",id:"bass",enabled:true,captureId:"revision"}});
  packet({source:"bass",epoch:1,revision:0,beat:2});
  packet({source:"bass",epoch:1,revision:1,beat:3});packet({source:"bass",epoch:1,revision:1,beat:4});
  consume(1024);assert.equal(readiness().ready,false,"old revision queue cannot satisfy readiness");
  consume(2048);assert.equal(readiness().ready,true);assert.equal(readiness().revision,1);
  packet({source:"bass",epoch:1,revision:1,generation:2,beat:0});consume(1024);
  assert.equal(readiness().ready,false,"loop generation/backwards beat resets contiguous history");
  packet({source:"bass",epoch:1,revision:1,generation:2,beat:1});consume(1024);
  assert.equal(readiness().ready,true);assert.equal(readiness().generation,2);
});
