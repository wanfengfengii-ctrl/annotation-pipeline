// Only generic startup plumbing, never a business answer or agent state.
export const scaffoldTemplateVersion = '2026-09-10.web-skeleton1';
export const scaffoldTemplates = [
  {
    id: 'python-flask',
    use: 'Python 网页与本地服务',
    files: {
      'app.py':
        "from flask import Flask\napp = Flask(__name__)\n@app.get('/')\ndef index():\n return '<!doctype html><html lang=\"zh\"><body><main id=\"app\"></main></body></html>'\nif __name__ == '__main__': app.run(host='0.0.0.0', port=8080)\n",
      'requirements.txt': 'Flask==3.1.3\npytest==9.1.1\n',
      'tests/test_startup.py':
        "from app import app\ndef test_page():\n assert app.test_client().get('/').status_code == 200\n",
    },
    readiness: {
      startCommand: 'python3 app.py',
      port: 8080,
      smokeCommand: 'python3 -m pytest -q',
    },
  },
  {
    id: 'node-http',
    use: '无需第三方库的轻量网页',
    files: {
      'server.cjs':
        "const http=require('node:http');http.createServer((req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><html lang=\"zh\"><body><main id=\"app\"></main></body></html>')}).listen(8080,'0.0.0.0');\n",
      'startup.test.cjs':
        "const {test}=require('node:test');const assert=require('node:assert/strict');test('page',async()=>{const r=await fetch('http://127.0.0.1:8080/');assert.equal(r.status,200)});\n",
    },
    readiness: {
      startCommand: 'node server.cjs',
      port: 8080,
      smokeCommand: 'node --test startup.test.cjs',
    },
  },
];
export function scaffoldTemplateInstructions() {
  return `已验证通用骨架 ${scaffoldTemplateVersion}：${JSON.stringify(scaffoldTemplates)}。按本项目真实需求选择、适配或提供 custom 骨架，不强制改换技术栈。只复用入口和空页面，不添加业务答案，不限制最终页面布局。返回 templateId 和 readiness（项目根目录下的 startCommand、1024以上 port、通用 smokeCommand），启动检查须真实服务网页，冒烟检查只核对骨架可运行。运行依赖将在题目发送前准备。`;
}
