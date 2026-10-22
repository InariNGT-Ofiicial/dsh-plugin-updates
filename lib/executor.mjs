import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFile } from 'node:fs/promises';

export function resolveDshLauncher(installAnchor) {
  if(!installAnchor)return null;
  const root=dirname(installAnchor);
  const normalized=installAnchor.replaceAll('\\','/');
  const embeddedArchive=normalized.includes('.asar/')&&existsSync(normalized.slice(0,normalized.indexOf('.asar/')+5));
  const desktopCandidates=[join(root,'node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'),join(root,'../dsh-desktop-host/lib/cli.js')];
  if(embeddedArchive)desktopCandidates.push(join(normalized.slice(0,normalized.indexOf('.asar/')+5),'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'));
  const desktop=desktopCandidates.find(p=>existsSync(p))||(embeddedArchive?desktopCandidates.at(-1):null);
  const cli=desktop||[join(root,'lib/bin.js'),join(root,'node_modules/@deepseek-ai/dsh/lib/bin.js')].find(p=>existsSync(p));
  if(!cli)return null;
  if(!existsSync(cli)&&!embeddedArchive)return null;
  let command=process.execPath;
  if(normalized.includes('.asar/')&&!process.versions.electron){
    const resources=dirname(normalized.slice(0,normalized.indexOf('.asar/')+5));
    const executable=join(dirname(resources),'DeepSeek Harness.exe');
    if(!existsSync(executable))return null;command=executable;
  }
  return {command,args:[...(cli===desktop?['--expose-internals']:[]),cli]};
}
export function makeDshRunner({installAnchor,home,launcher=resolveDshLauncher(installAnchor),timeoutMs=300000}={}) {
  if(!launcher)return null;
  return (args,{signal,logPath}={})=>new Promise((resolve,reject)=>{
    let child,output='',errors='',settled=false;
    const finish=async(error)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(logPath){let diagnostics=output+errors;for(const name of ['DSH_GITHUB_TOKEN','GITHUB_TOKEN','NPM_TOKEN','NODE_AUTH_TOKEN']){const secret=process.env[name];if(secret)diagnostics=diagnostics.split(secret).join('[REDACTED]');}try{await writeFile(logPath,diagnostics,{mode:0o600});}catch{}}error?reject(error):resolve({exitCode:child.exitCode??1,stdout:output,stderr:errors});};
    const abort=()=>{child?.kill();finish(new Error('UPDATE_CANCELLED'));};
    const timer=setTimeout(()=>{child?.kill();finish(new Error('INSTALL_TIMEOUT'));},timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    try{
      child=spawn(launcher.command,[...launcher.args,'plugin',...args],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',DSH_HOME:home,npm_config_ignore_scripts:'true'},windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
      child.stdout.on('data',b=>{output+=b.toString();if(output.length>2*1024*1024){child.kill();finish(new Error('INSTALL_OUTPUT_TOO_LARGE'));}});
      child.stderr.on('data',b=>{errors+=b.toString();if(errors.length>2*1024*1024){child.kill();finish(new Error('INSTALL_OUTPUT_TOO_LARGE'));}});
      child.once('error',()=>finish(new Error('DSH_INSTALLER_UNAVAILABLE')));child.once('close',()=>finish());
    }catch{finish(new Error('DSH_INSTALLER_UNAVAILABLE'));}
  });
}
