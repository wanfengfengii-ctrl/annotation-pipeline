import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateRuntimePlan } from '../lib/runtime-verification.mjs';

export const runtimePreflightVersion = '2026-09-11.runtime-preflight2';
export function knownRuntimeRequirements(history) {
  return (history?.checks || [])
    .filter((check) => check.outcome === 'reproduced')
    .map(({ id, requirement, expected }) => ({ id, requirement, expected }));
}
export function assertKnownRuntimeChecks(plan, history) {
  for (const old of history?.checks || []) {
    if (old.outcome !== 'reproduced') continue;
    const next = plan.checks.find((check) => check.id === old.id);
    if (
      !next ||
      next.kind === 'setup' ||
      next.requirement !== old.requirement ||
      next.expected !== old.expected
    )
      throw Error('独立验收必须重新覆盖已复现问题及原预期：' + old.id);
  }
}
// This program only parses text. Generated shell/Python/JavaScript is never
// evaluated, sourced or mounted into the preflight container.
export const syntaxProbeProgram = String.raw`
const {spawnSync}=require('node:child_process');
const checks=JSON.parse(process.argv[1]),issues=[];
const parse=(id,language,args,input)=>{
  const r=spawnSync(args[0],args.slice(1),{input,encoding:'utf8',timeout:8000,maxBuffer:65536,env:{...process.env,BASH_ENV:'',ENV:'',NODE_OPTIONS:'',PYTHONSTARTUP:''}});
  if(r.error||r.status!==0||/here-document .*delimited by end-of-file/.test(r.stderr||''))
    issues.push({id,language,message:String(r.error?.message||r.stderr||r.stdout||'parser failed').slice(-1800)});
};
for(const c of checks){
  parse(c.id,'bash',['/bin/bash','--noprofile','--norc','-n','-c',c.command]);
  const lines=c.command.split('\n');
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    const inline=/(?:^|[\s/(&|;])(node|python(?:3(?:\.\d+)?)?)\s+([^;|&\n]*?)(?:-e|-c)\s+('([^']*)'|"((?:\\.|[^"\\])*)")(?=$|[\s);|&])/g;
    for(const m of line.matchAll(inline)){
      let code=m[4]??m[5];
      if(m[5]!==undefined){
        if(/(?<!\\)[$\x60]/.test(code))continue;
        code=code.replace(/\\([$\x60"\\])/g,'$1');
      }
      if(m[1].startsWith('python'))parse(c.id,'python',['python3','-I','-c','import ast,sys; ast.parse(sys.stdin.read())'],code);
      else parse(c.id,'javascript',['node','--check',...(/--input-type[= ]module/.test(m[2])?['--input-type=module']:[])],code);
    }
    const m=line.match(/<<(-?)\s*(['"])([A-Za-z_][A-Za-z_0-9]*)\2/);
    if(!m)continue;
    const body=[];let j=i+1;
    for(;j<lines.length;j++){const s=m[1]?lines[j].replace(/^\t+/,''):lines[j];if(s===m[3])break;body.push(s);}
    if(j===lines.length)continue;
    i=j;
    const text=body.join('\n');
    if(/(?:^|[\s/])python(?:3(?:\.\d+)?)?(?:\s|$)/.test(line)||/\/[\w./-]+\.py(?:['"]|\s|$)/.test(line))
      parse(c.id,'python',['python3','-I','-c','import ast,sys; ast.parse(sys.stdin.read())'],text);
    else if(/(?:^|[\s/])node(?:\s|$)/.test(line)||/\/[\w./-]+\.[cm]?js(?:['"]|\s|$)/.test(line)){
      const kind=/\.mjs(?:['"]|\s|$)|--input-type[= ]module/.test(line)?['--input-type=module']:/\.cjs(?:['"]|\s|$)/.test(line)?['--input-type=commonjs']:[];
      parse(c.id,'javascript',['node','--check',...kind],text);
    }
  }
}
process.stdout.write(JSON.stringify({version:1,issues}));
`;

export function runtimePathInstructions({ workDir, projectDirectory, files }) {
  const project =
    projectDirectory &&
    files.some((f) => f.path.startsWith(projectDirectory + '/'))
      ? projectDirectory
      : null;
  return `路径约定：源码根目录是 ${workDir}，其内容原样映射到验收容器 /workspace。${project ? `业务项目位于其下的 ${project}，运行命令先 cd /workspace/${project}。` : '业务入口按下面真实清单选择。'}所有 codeEvidence 都相对于源码根目录，而不是 cd 后的业务目录；必须直接使用清单中的完整相对路径，不能省去 projects/… 前缀。参考路径：${JSON.stringify(files.slice(0, 16).map((f) => f.path))}。源码引用、步骤总预算和脚本语法会在执行前检查；检查不执行项目，也不代表验收通过。`;
}

export async function prepareRuntimePlan({
  generate,
  validateReferences,
  docker,
  withHeavy,
  imageId,
  root,
  knownChecks = [],
}) {
  const attempts = [];
  for (let revision = 0; revision < 2; revision++) {
    let plan;
    const issues = [];
    try {
      plan = await generate(revision, attempts.at(-1));
    } catch (error) {
      if (!error.runtimePlanCandidate) throw error;
      plan = error.runtimePlanCandidate;
      issues.push({ kind: 'structure', message: error.message });
    }
    if (!issues.length) {
      try {
        validateRuntimePlan(plan.value);
        if (revision && Array.isArray(attempts[0].plan.value?.checks)) {
          const original = attempts[0].plan.value.checks;
          const required = new Map(
            knownChecks.map((check) => [check.id, check]),
          );
          if (
            plan.value.checks.length < original.length ||
            plan.value.checks.slice(original.length).some((c) => {
              const known = required.get(c.id);
              return (
                !known ||
                c.kind === 'setup' ||
                c.requirement !== known.requirement ||
                c.expected !== known.expected
              );
            }) ||
            original.some((c, i) =>
              [
                'requirement',
                'expected',
                ...(['setup', 'acceptance', 'reproduction'].includes(c.kind)
                  ? ['kind']
                  : []),
                ...(/^[a-z][a-z0-9_-]{0,127}$/.test(c.id) ? ['id'] : []),
              ].some((k) => {
                const next = plan.value.checks[i];
                if (c[k] === next?.[k]) return false;
                // A rejected first draft may have paraphrased a frozen check.
                // Only restore its verified requirement/expected verbatim.
                const known = required.get(c.id);
                return !(
                  ['requirement', 'expected'].includes(k) &&
                  known &&
                  next?.id === c.id &&
                  next?.[k] === known[k]
                );
              }),
            )
          )
            throw Error('执行前修订不能删除、替换或改变原业务检查及其预期');
        }
        validateReferences(plan.value);
      } catch (error) {
        issues.push({ kind: 'plan', message: error.message });
      }
    }
    let syntax = null;
    if (!issues.length) {
      const logPath = path.join(root, 'preflight-' + revision + '.log');
      syntax = await withHeavy('runtime-preflight', () =>
        docker(
          [
            'run',
            '--rm',
            '--network',
            'none',
            '--read-only',
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            '--pids-limit',
            '64',
            '--memory',
            '256m',
            '--cpus',
            '1',
            '--label',
            'annotation.verification-preflight=true',
            '--entrypoint',
            'node',
            imageId,
            '-e',
            syntaxProbeProgram,
            JSON.stringify(plan.value.checks),
          ],
          { timeoutSeconds: 90, logPath },
        ),
      );
      if (syntax.exitCode !== 0 || syntax.timedOut || syntax.limited)
        throw Error('验收语法预检环境失败，未执行业务命令；日志：' + logPath);
      let parsed;
      try {
        parsed = JSON.parse(syntax.output);
      } catch {
        throw Error('验收语法预检未返回有效结果；日志：' + logPath);
      }
      if (parsed.version !== 1 || !Array.isArray(parsed.issues))
        throw Error('验收语法预检结果不完整');
      issues.push(...parsed.issues.map((x) => ({ ...x, kind: 'syntax' })));
    }
    const attempt = {
      revision,
      plan,
      issues,
      ...(syntax
        ? { syntax: { logPath: syntax.logPath, logSha256: syntax.logSha256 } }
        : {}),
    };
    attempts.push(attempt);
    const reportPath = path.join(root, 'preflight-' + revision + '.json');
    writeFileSync(
      reportPath,
      JSON.stringify({ version: runtimePreflightVersion, attempts }, null, 2),
      { mode: 0o600, flag: 'wx' },
    );
    if (!issues.length)
      return {
        ...plan,
        preflight: {
          version: runtimePreflightVersion,
          reportPath,
          sha256: createHash('sha256')
            .update(readFileSync(reportPath))
            .digest('hex'),
          revisions: revision,
        },
      };
    if (revision === 1)
      throw Error(
        '验收计划预检修订后仍未通过：' +
          issues.map((x) => x.message).join('；'),
      );
  }
}
