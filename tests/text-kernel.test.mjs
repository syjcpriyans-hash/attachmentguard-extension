import test from "node:test";
import assert from "node:assert/strict";
import { segmentWords, planWordReplacement, KernelError } from "../src/text-kernel.js";

function c(ch,x,objIndex,objOffset,extra={}) {
  return {
    unicode:ch,
    box:{left:x,bottom:10,right:x+5,top:20},
    origin:{x,y:10},
    streamIndex:objOffset,
    objIndex,
    objOffset,
    generated:false,
    mapError:0,
    angle:0,
    fontSize:10,
    styleKey:"Arial|10|regular",
    ...extra,
  };
}

test("fragmented PDF objects become one complete visible word", () => {
  const chars=[
    c("A",0,1,0),c("D",5,1,1),c("V",10,2,0),c("A",15,2,1),
    c("N",20,3,0),c("C",25,3,1),c("E",30,3,2)
  ];
  const words=segmentWords(chars);
  assert.equal(words.length,1);
  assert.equal(words[0].text,"ADVANCE");
  assert.equal(words[0].slices.length,3);
});

test("explicit PDF space creates two complete words", () => {
  const chars=[c("A",0,1,0),c("B",5,1,1),c(" ",10,1,2),c("C",15,1,3),c("D",20,1,4)];
  assert.deepEqual(segmentWords(chars).map(w=>w.text),["AB","CD"]);
});

test("large visual gap between different objects creates a word boundary", () => {
  assert.deepEqual(
    segmentWords([c("A",0,1,0),c("B",5,1,1),c("C",28,2,0),c("D",33,2,1)]).map(w=>w.text),
    ["AB","CD"]
  );
});

test("punctuation remains attached to its word", () => {
  const w=segmentWords([c("T",0,1,0),c("O",5,1,1),c("T",10,1,2),c("A",15,1,3),c("L",20,1,4),c(":",25,1,5)]);
  assert.equal(w[0].text,"TOTAL:");
});

test("mixed-style word is visible but intentionally not editable", () => {
  const word=segmentWords([c("A",0,1,0),c("B",5,2,0,{styleKey:"Arial|10|bold"})])[0];
  assert.equal(word.text,"AB");
  assert.equal(word.editable,false);
  assert.equal(word.mixedStyle,true);
});

test("partial primary-object replacement preserves neighboring object text in the rewrite plan", () => {
  const word={editable:true,slices:[{objIndex:5,start:2,end:5,contiguous:true}]};
  const records=new Map([[5,{text:"XXABCYY"}]]);
  const plan=planWordReplacement(word,"DOG",records);
  assert.equal(plan.actions[0].newText,"XXDOGYY");
});

test("fragmented word can consume complete secondary fragment objects", () => {
  const word={
    editable:true,
    slices:[
      {objIndex:1,start:0,end:2,contiguous:true},
      {objIndex:2,start:0,end:3,contiguous:true},
    ],
  };
  const records=new Map([[1,{text:"AD"}],[2,{text:"VAN"}]]);
  const plan=planWordReplacement(word,"HELLO",records);
  assert.equal(plan.actions[0].newText,"HELLO");
  assert.equal(plan.actions[1].removeObject,true);
});

test("fragmented word is blocked if secondary object also contains unrelated text", () => {
  const word={
    editable:true,
    slices:[
      {objIndex:1,start:0,end:2,contiguous:true},
      {objIndex:2,start:0,end:3,contiguous:true},
    ],
  };
  const records=new Map([[1,{text:"AD"}],[2,{text:"VAN REST"}]]);
  assert.throws(
    ()=>planWordReplacement(word,"HELLO",records),
    e=>e instanceof KernelError && e.code==="KERNEL_COMPLEX_CROSS_OBJECT"
  );
});

test("empty replacement is blocked rather than creating an invalid PDF object", () => {
  const word={editable:true,slices:[{objIndex:1,start:0,end:3,contiguous:true}]};
  const records=new Map([[1,{text:"ABC"}]]);
  assert.throws(
    ()=>planWordReplacement(word,"",records),
    e=>e instanceof KernelError && e.code==="KERNEL_EMPTY_REPLACEMENT"
  );
});
