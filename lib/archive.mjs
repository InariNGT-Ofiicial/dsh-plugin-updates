import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const field=(b,start,end)=>b.subarray(start,end).toString('utf8').replace(/\0.*$/s,'');
function safePath(path) {
  return !!path && !/^[\\/]|^[a-z]:/i.test(path) && !path.includes('\\') && !path.split('/').some(p=>p==='..'||p==='.') && !/[\x00-\x1f]/.test(path);
}
export function inspectTarball(compressed) {
  let tar;try{tar=gunzipSync(compressed,{maxOutputLength:64*1024*1024});}catch{throw new Error('INVALID_OR_OVERSIZED_TARBALL');}
  const files=new Map();let offset=0,longName='',root='';
  while(offset+512<=tar.length){
    const header=tar.subarray(offset,offset+512);if(header.every(x=>x===0))break;
    const rawSize=field(header,124,136).trim();if(!/^[0-7]+$/.test(rawSize))throw new Error('INVALID_TAR_SIZE');
    const size=parseInt(rawSize,8);if(!Number.isSafeInteger(size)||size<0||offset+512+size>tar.length)throw new Error('INVALID_TAR_SIZE');
    const expected=parseInt(field(header,148,156).trim(),8);let sum=0;for(let i=0;i<512;i++)sum+=i>=148&&i<156?32:header[i];if(sum!==expected)throw new Error('INVALID_TAR_CHECKSUM');
    const type=field(header,156,157)||'0';const body=tar.subarray(offset+512,offset+512+size);offset+=512+Math.ceil(size/512)*512;
    if(type==='L'){longName=body.toString('utf8').replace(/\0.*$/s,'');continue;}
    if(type==='x'||type==='g'){
      let at=0;
      while(at<body.length){const space=body.indexOf(32,at);if(space<0)throw new Error('INVALID_PAX_HEADER');const length=Number(body.subarray(at,space).toString());if(!Number.isSafeInteger(length)||length<=space-at+1||at+length>body.length)throw new Error('INVALID_PAX_HEADER');const item=body.subarray(space+1,at+length).toString('utf8').replace(/\n$/,'');const equals=item.indexOf('=');if(equals<0)throw new Error('INVALID_PAX_HEADER');const key=item.slice(0,equals),value=item.slice(equals+1);if(key==='path'){if(type==='g')throw new Error('UNSUPPORTED_GLOBAL_PATH');longName=value;}if(['size','linkpath'].includes(key))throw new Error('UNSUPPORTED_PAX_OVERRIDE');at+=length;}
      continue;
    }
    const prefix=field(header,345,500);const name=longName||(prefix?prefix+'/':'')+field(header,0,100);longName='';
    if(!safePath(name))throw new Error('UNSAFE_ARCHIVE_PATH');
    if(!['0','5'].includes(type))throw new Error('UNSUPPORTED_ARCHIVE_LINK');
    const parts=name.replace(/\/$/,'').split('/');if(!root)root=parts[0];if(parts[0]!==root)throw new Error('MULTIPLE_ARCHIVE_ROOTS');
    if(type==='0'){const relative=parts.slice(1).join('/');if(files.has(relative))throw new Error('DUPLICATE_ARCHIVE_ENTRY');files.set(relative,body);}
    if(files.size>20000)throw new Error('ARCHIVE_TOO_MANY_FILES');
  }
  if(!files.has('package.json'))throw new Error('ARCHIVE_PACKAGE_NOT_FOUND');
  let manifest;try{manifest=JSON.parse(files.get('package.json').toString('utf8'));}catch{throw new Error('INVALID_ARCHIVE_MANIFEST');}
  return {manifest,files,sha256:createHash('sha256').update(compressed).digest('hex')};
}
export function validatePackage(manifest, {name,version,runtimeVersion,nodeVersion}, hasFile=()=>true) {
  if(manifest.name!==name||manifest.version!==version)throw new Error('PACKAGE_IDENTITY_MISMATCH');
  if(!manifest.dsh?.bundle)throw new Error('NOT_A_DSH_BUNDLE');
  const bundle=manifest.dsh.bundle;
  const patches=typeof bundle==='string'?[bundle]:Array.isArray(bundle)?bundle:[bundle.patch,...(bundle.patches||[])].filter(Boolean);
  if(!patches.length||patches.some(p=>typeof p!=='string'||!safePath(p.replace(/^\.\//,''))||!hasFile(p.replace(/^\.\//,''))))throw new Error('BUNDLE_PATCH_MISSING');
  const entry=manifest.main || (typeof manifest.exports==='string'?manifest.exports:typeof manifest.exports?.['.']==='string'?manifest.exports['.']:manifest.exports?.['.']?.default);
  if(typeof entry!=='string'||!safePath(entry.replace(/^\.\//,''))||!hasFile(entry.replace(/^\.\//,'')))throw new Error('READY_TO_RUN_ENTRY_MISSING');
  if(Object.values({...manifest.dependencies,...manifest.optionalDependencies}).some(v=>typeof v==='string'&&v.startsWith('workspace:')))throw new Error('UNPACKAGED_WORKSPACE_DEPENDENCIES');
  return {runtimeVersion,nodeVersion};
}

export async function snapshotPackage(dir) {
  const chunks=[];let bytes=0,count=0;
  const put=(header,start,length,value)=>{const text=Buffer.from(value);if(text.length>length)throw new Error('BACKUP_PATH_TOO_LONG');text.copy(header,start);};
  async function walk(relative=''){
    for(const entry of await readdir(join(dir,relative),{withFileTypes:true})){
      if(['node_modules','.git'].includes(entry.name))continue;
      const path=relative?`${relative}/${entry.name}`:entry.name;
      if(entry.isSymbolicLink())throw new Error('BACKUP_LINK_NOT_SUPPORTED');
      if(entry.isDirectory()){await walk(path);continue;}
      if(!entry.isFile())throw new Error('BACKUP_TYPE_NOT_SUPPORTED');
      const data=await readFile(join(dir,path));bytes+=data.length;if(bytes>64*1024*1024||++count>20000)throw new Error('BACKUP_TOO_LARGE');
      const header=Buffer.alloc(512),full=`package/${path}`;let name=full,prefix='';
      if(Buffer.byteLength(name)>100){const split=full.lastIndexOf('/');name=full.slice(split+1);prefix=full.slice(0,split);}
      put(header,0,100,name);put(header,100,8,'0000644\0');put(header,108,8,'0000000\0');put(header,116,8,'0000000\0');put(header,124,12,data.length.toString(8).padStart(11,'0')+'\0');put(header,136,12,'00000000000\0');
      header.fill(32,148,156);put(header,156,1,'0');put(header,257,6,'ustar\0');put(header,263,2,'00');put(header,345,155,prefix);
      const sum=header.reduce((a,b)=>a+b,0);put(header,148,8,sum.toString(8).padStart(6,'0')+'\0 ');
      chunks.push(header,data,Buffer.alloc((512-data.length%512)%512));
    }
  }
  await walk();chunks.push(Buffer.alloc(1024));return gzipSync(Buffer.concat(chunks),{level:6});
}
