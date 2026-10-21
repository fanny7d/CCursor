export const shellEnvSource = `let cached;
async function resolveEnv(config,log,args,env){
  return cached||(cached=new Promise(async(resolve,reject)=>{
    const cts=new CancellationSource;let limit=10000;
    const configured=config.getValue("application.shellEnvironmentResolutionTimeout");
    if(typeof configured==="number")limit=Math.min(Math.max(configured,1),120)*1000;
    const timer=setTimeout(()=>{cts.dispose(true),reject(new Error("shell environment timeout"))},limit);
    try{resolve(await spawnShell(cts.token))}catch(error){reject(error)}finally{clearTimeout(timer),cts.dispose()}
  })),cached
}`;
