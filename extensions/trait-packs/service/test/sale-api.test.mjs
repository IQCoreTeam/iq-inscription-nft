import {test} from 'node:test';import assert from 'node:assert/strict';import {createPackSaleApi} from '../sale-api.mjs';
const collection='11111111111111111111111111111111',url='http://localhost/packs/'+collection+'/sale';
test('HTTP sale API exposes confirmed public terms from a configured market only',async()=>{
 const handler=createPackSaleApi(new Map([[collection,{readSale:async()=>({pool:{collection:{toBase58:()=>collection},treasury:{toBase58:()=>collection},price:100,platformFee:5,totalPrice:105,definitions:[{id:0,name:'hair',slot:0,remaining:4}],privateSigner:'never serialize'},epoch:{id:1,ticketCount:2},slot:3,canPurchase:true})}]]));
 const response=await handler(new Request(url));assert.equal(response.status,200);const data=await response.json();assert.equal(data.totalPrice,105);assert.equal('privateSigner' in data,false);assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal((await handler(new Request(url,{method:'POST'}))).status,405);assert.equal((await handler(new Request(url+'?rpc=evil'))).status,400);
});
test('API errors do not expose operator details or accept unknown collection configuration',async()=>{
 const handler=createPackSaleApi(new Map([[collection,{readSale:async()=>{throw Error('/private/key.json');}}]]));
 const response=await handler(new Request(url));assert.equal(response.status,503);assert(!JSON.stringify(await response.json()).includes('key.json'));
 assert.equal((await createPackSaleApi(new Map())(new Request(url))).status,404);
});
