import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const environmentReadinessVersion = '2026-09-10.environment-ready3';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const readinessProgram = String.raw`# ANNOTATION_ENV_READY
import os,sys,json,tempfile,subprocess,time,venv,urllib.request,signal,hashlib
from pathlib import Path
cfg=json.load(sys.stdin)
if os.getuid()!=1000: raise RuntimeError('Readiness must run as node')
env=dict(os.environ)
for key in list(env):
 if key.lower()=='apikey' or any(x in key.upper() for x in ['TOKEN','SECRET','API_KEY']): env.pop(key,None)
env['PYTHONDONTWRITEBYTECODE']='1'
caches={}
for key,folder in [('npm_config_cache','npm'),('PIP_CACHE_DIR','pip'),('XDG_CACHE_HOME','xdg')]:
 expected='/home/node/.cache/annotation/'+folder
 if env.get(key)!=expected: raise RuntimeError('Image cache configuration mismatch: '+key)
 cache=Path(expected)
 if cache.resolve()!=cache or not cache.is_dir() or cache.stat().st_uid!=os.getuid(): raise RuntimeError('Cache path/owner mismatch: '+key)
 with tempfile.TemporaryFile(dir=cache) as probe: probe.write(b'cache-ready');probe.flush()
 caches[key]=expected
if Path('/etc/apt/apt.conf.d/docker-clean').exists(): raise RuntimeError('Runtime apt system-cache cleanup hook still enabled')
def run(args,cwd=None,timeout=180):
 p=subprocess.run(args,cwd=cwd,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=timeout)
 print(p.stdout,flush=True)
 if p.returncode: raise RuntimeError('Readiness command failed: '+str(args[0])+' exit '+str(p.returncode))
 return p.stdout
import flask,fastapi,pytest,httpx,playwright
if run(['npm','config','get','cache']).strip()!=caches['npm_config_cache']: raise RuntimeError('Npm cache override mismatch')
if run(['python3','-m','pip','cache','dir']).strip()!=caches['PIP_CACHE_DIR']: raise RuntimeError('Pip cache override mismatch')
run(['npm','cache','verify'])
run(['ffmpeg','-version'],timeout=10)
with tempfile.TemporaryDirectory() as d:
 venv.create(d,with_pip=True)
 run([d+'/bin/python','-m','pip','--version'])
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox'])
 page=b.new_page();page.set_content('<button onclick="this.textContent=\'ok\'">ready</button>')
 page.get_by_role('button',name='ready').click()
 assert page.get_by_role('button',name='ok').count()==1
 b.close()
project=Path('/workspace')/cfg['directory']
if not project.is_dir() or project.resolve()!=project: raise RuntimeError('Invalid project directory')
before={str(p.relative_to(project)):hashlib.sha256(p.read_bytes()).hexdigest() for p in project.rglob('*') if p.is_file() and not any(x in p.parts for x in ['node_modules','.venv','.git','__pycache__'])}
if (project/'requirements.txt').exists(): run(['python3','-m','pip','install','--disable-pip-version-check','-r','requirements.txt'],str(project))
if (project/'package.json').exists():
 package=json.loads((project/'package.json').read_text())
 if package.get('dependencies') or package.get('devDependencies'):
  locked=(project/'package-lock.json').exists()
  run(['npm','ci' if locked else 'install','--ignore-scripts','--no-audit','--no-fund']+([] if locked else ['--no-save','--package-lock=false']),str(project))
ready=cfg.get('readiness')
if ready:
 server=subprocess.Popen(['/bin/bash','--noprofile','--norc','-c',ready['startCommand']],cwd=str(project),env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
 try:
  url='http://127.0.0.1:'+str(ready['port'])+'/'
  for i in range(120):
   if server.poll() is not None: raise RuntimeError('Scaffold server exited before ready')
   try:
    with urllib.request.urlopen(url,timeout=1) as response:
     if response.status==200: break
   except Exception: pass
   time.sleep(.25)
  else: raise RuntimeError('Scaffold did not serve its initial webpage')
  with sync_playwright() as p:
   b=p.chromium.launch(headless=True,args=['--no-sandbox']);page=b.new_page();page.goto(url);assert page.locator('body').count()==1;b.close()
  run(['/bin/bash','--noprofile','--norc','-c',ready['smokeCommand']],str(project),60)
 finally:
  if server.poll() is None:
   os.killpg(server.pid,signal.SIGTERM)
   try: server.wait(timeout=3)
   except subprocess.TimeoutExpired: os.killpg(server.pid,signal.SIGKILL);server.wait(timeout=3)
for name,sha in before.items():
 if hashlib.sha256((project/name).read_bytes()).hexdigest()!=sha: raise RuntimeError('Dependency setup changed source: '+name)
print('ANNOTATION_READINESS='+json.dumps({'passed':True,'uid':os.getuid(),'browser':True,'venv':True,'caches':caches,'writableCaches':True,'systemAptCleanupDisabled':True,'scaffold':bool(ready),'dependencies':run(['python3','-m','pip','freeze','--all']).splitlines()}))
`;

export function validateReadiness(value) {
  if (
    !value ||
    !Number.isInteger(value.port) ||
    value.port < 1024 ||
    value.port > 65535 ||
    ['startCommand', 'smokeCommand'].some(
      (k) =>
        typeof value[k] !== 'string' ||
        !value[k].trim() ||
        value[k].length > 4000,
    )
  )
    throw Error('骨架缺少可执行的网页启动和通用冒烟检查');
  return value;
}

export async function prepareEnvironment({
  state,
  directory,
  readiness,
  evidenceDir,
  onChild = () => {},
  command = execFile,
}) {
  if (
    state.pending ||
    Object.keys(state.results || {}).length ||
    !/^[a-f0-9]{64}$/.test(state.containerId || '') ||
    !/^projects\/p-[a-f0-9-]{36}$/.test(directory)
  )
    throw Error('环境准备只能在独立题目首次输入前进行');
  if (readiness) validateReadiness(readiness);
  mkdirSync(evidenceDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const logPath = path.join(evidenceDir, 'readiness-' + Date.now() + '.log');
  let output;
  try {
    output = await new Promise((resolve, reject) => {
      const child = command(
        'docker',
        [
          'exec',
          '-i',
          state.containerId,
          'env',
          '-u',
          'apikey',
          'python3',
          '-B',
          '-c',
          readinessProgram,
        ],
        { encoding: 'utf8', timeout: 300000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const log = stdout + stderr;
          writeFileSync(logPath, log, { mode: 0o600 });
          if (error) reject(Error('开题前环境检查未通过，详见 ' + logPath));
          else resolve(stdout);
        },
      );
      onChild(child);
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ directory, readiness }));
    });
    const line = output
      .split('\n')
      .findLast((line) => line.startsWith('ANNOTATION_READINESS='));
    const result = JSON.parse(
      line?.slice('ANNOTATION_READINESS='.length) || 'null',
    );
    if (
      !result?.passed ||
      !result.browser ||
      !result.venv ||
      result.uid !== 1000 ||
      !result.writableCaches ||
      !result.systemAptCleanupDisabled ||
      (readiness && !result.scaffold)
    )
      throw Error('开题环境检查回执不完整');
    const receiptPath = logPath.replace(/\.log$/, '.json');
    const record = {
      version: environmentReadinessVersion,
      taskId: state.taskId,
      questionId: state.questionId,
      containerId: state.containerId,
      imageId: state.imageId,
      startedAt,
      finishedAt: new Date().toISOString(),
      logPath,
      logSha256: digest(readFileSync(logPath)),
      ...result,
    };
    const bytes = JSON.stringify(record, null, 2);
    writeFileSync(receiptPath, bytes, { mode: 0o600 });
    return {
      passed: true,
      version: environmentReadinessVersion,
      imageId: state.imageId,
      receiptPath,
      sha256: digest(bytes),
    };
  } catch (error) {
    throw Error('初始环境未就绪，题目尚未发送：' + error.message);
  }
}
