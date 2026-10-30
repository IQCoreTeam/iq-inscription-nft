import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { renderCollection } from '../../service/render-engine.mjs';
import { singleFinalArtConfig,selectFinalArt } from '../../service/final-art-selection.mjs';
export async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'iq-creator-kit-'));
 const rgba=Buffer.alloc(16*16*4);for(let y=4;y<12;y++)for(let x=4;x<12;x++){const i=(y*16+x)*4;rgba[i]=200;rgba[i+1]=180;rgba[i+2]=150;rgba[i+3]=255;}
 await writeFile(path.join(root,'body.png'),await sharp(rgba,{raw:{width:16,height:16,channels:4}}).png().toBuffer());
 await writeFile(path.join(root,'bg.png'),await sharp({create:{width:16,height:16,channels:4,background:'#101510'}}).png().toBuffer());
 for(const [file,channel]of [['hair-a.png',0],['hair-b.png',2]]){const pixels=Buffer.alloc(16*16*4);for(let y=2;y<5;y++)for(let x=4;x<12;x++){const i=(y*16+x)*4;pixels[i+channel]=255;pixels[i+3]=255;}await writeFile(path.join(root,file),await sharp(pixels,{raw:{width:16,height:16,channels:4}}).png().toBuffer());}
 const asset=(id,file,label)=>({id,file,label,weight:1});
 const config={name:'Creator kit',seed:'creator-fixture',count:1,canvas:{width:16,height:16},outputFormat:'png',groups:[{name:'Background',role:'background',assets:[asset('bg','bg.png','Dark')]},{name:'Body',role:'character',assets:[asset('body','body.png','Base')]},{name:'Hair',role:'overlay',assets:[asset('hair-a','hair-a.png','Red'),asset('hair-b','hair-b.png','Blue')]}]};
 const dna=['bg','body','hair-a'];await renderCollection(singleFinalArtConfig(config,selectFinalArt(config,dna),'base-fixture'),root,path.join(root,'base'));
 const bytes=await readFile(path.join(root,'base','1.png'));
 const input={schema:'iq-trait-kit/1',config,slotGroups:{0:'Hair'},definitions:[{id:0,name:'Blue hair',sourceId:'hair-b',slot:0,bodyMask:1,supply:4,creatorTier:'common'}],items:[{index:1,name:'Creator #1',bodyClass:0,dressable:true,file:'base/1.png',sha256:createHash('sha256').update(bytes).digest('hex'),sourceDna:dna}],appearance:{title:'Trait Booster',subtitle:'새로운 모습',coverFile:'base/1.png'}};
 return {root,input,stop:()=>rm(root,{recursive:true,force:true})};
}
